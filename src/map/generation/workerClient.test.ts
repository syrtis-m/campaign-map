import { describe, it, expect } from "vitest";
import { GenerationWorkerClient } from "./workerClient";
import type { GenerationRequest, GenerationResponse } from "../../gen/worker/generationWorker";
import type { BBox } from "../../gen/spatialHash";
import type { GenerationConstraints } from "../../gen/types";

/**
 * Worker PRIORITY QUEUE (Jonah: "new 3D geography takes a long while to appear").
 * All jobs share the one single-threaded worker; the client keeps an in-flight
 * WINDOW of 2 (2026-07-16: one computing + one queued worker-side, so a busy
 * main thread can't stall the worker between jobs) and feeds it the
 * highest-priority pending job whenever a slot frees, so DEM tiles + GM region
 * edits jump the contour-leaf backlog instead of waiting behind it. A
 * higher-priority arrival therefore runs after AT MOST the two already-posted
 * jobs, never behind the queued backlog.
 */

const EMPTY_CONSTRAINTS = {} as unknown as GenerationConstraints;
const EMPTY_TERRAIN = { features: [], base: { campAmp: 0, seaDatum: 0 }, campaignSeed: 0, include: { relief: true, landform: true, carve: true, grade: false } };

/** A fake Worker that records postMessage order and lets the test complete jobs
 * one at a time (so the client's in-flight window + reordering is observable). */
class FakeWorker {
  onmessage: ((e: MessageEvent<GenerationResponse>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  posted: GenerationRequest[] = [];
  postMessage(msg: GenerationRequest): void {
    this.posted.push(msg);
  }
  /** Complete the job at `posted[index]` (a completion frees one window slot). */
  completeAt(index: number): void {
    const req = this.posted[index];
    this.onmessage?.({ data: { requestId: req.requestId, features: [] } } as unknown as MessageEvent<GenerationResponse>);
  }
  /** Complete the most-recently-posted job. */
  completeLast(): void {
    this.completeAt(this.posted.length - 1);
  }
  terminate(): void {}
}

describe("GenerationWorkerClient — priority queue", () => {
  it("a DEM tile queued behind a contour leaf is dispatched FIRST when a slot frees up", async () => {
    const fake = new FakeWorker();
    const client = GenerationWorkerClient.__forTest(fake as unknown as Worker);

    // Fill the in-flight window (2) with contour leaves.
    const busy1 = client.computeContourLeaf(EMPTY_TERRAIN, 0, 0, {} as never);
    const busy2 = client.computeContourLeaf(EMPTY_TERRAIN, 0, 1, {} as never);
    expect(fake.posted.length).toBe(2); // window full

    // While the window is full, enqueue a contour leaf THEN a DEM tile.
    const contour = client.computeContourLeaf(EMPTY_TERRAIN, 1, 1, {} as never);
    const dem = client.computeDemTile(EMPTY_TERRAIN, 6, 24, 36, 128, 50, 25);
    expect(fake.posted.length).toBe(2); // both still queued — window full

    // Free a slot: the DEM tile (priority 1) must be picked ahead of the
    // still-queued contour leaf (priority 2), even though it was enqueued LAST.
    fake.completeAt(0);
    await busy1;
    expect(fake.posted.length).toBe(3);
    expect(fake.posted[2].kind).toBe("dem-tile");

    // Then the contour leaf.
    fake.completeAt(1);
    await busy2;
    expect(fake.posted.length).toBe(4);
    expect(fake.posted[3].kind).toBe("contour-leaf");
    fake.completeAt(2);
    await dem;
    fake.completeAt(3);
    await contour;
  });

  it("a GM region edit is not starved — dispatched ahead of a queued contour leaf", async () => {
    const fake = new FakeWorker();
    const client = GenerationWorkerClient.__forTest(fake as unknown as Worker);
    const busy1 = client.computeContourLeaf(EMPTY_TERRAIN, 0, 0, {} as never);
    const busy2 = client.computeContourLeaf(EMPTY_TERRAIN, 0, 1, {} as never);
    const contour = client.computeContourLeaf(EMPTY_TERRAIN, 1, 1, {} as never);
    const region = client.generateRegion("city", 1, "r", [[0, 0], [1, 0], [1, 1]], {}, EMPTY_CONSTRAINTS);
    fake.completeAt(0);
    await busy1;
    expect(fake.posted[2].kind).toBe("procgen-region");
    fake.completeAt(2);
    await region;
    fake.completeAt(1);
    await busy2;
    fake.completeAt(3);
    await contour;
  });

  it("a GM river (region-gen) PREEMPTS a DEM-tile backlog — dispatched next, not FIFO-last (Bug B: Cradle river invisible)", async () => {
    // The Cradle repro: a cold view has dozens of DEM tiles already queued when
    // the GM finishes drawing a river. Region-gen (priority 0) must jump the whole
    // DEM backlog (priority 1) at the next job boundary — it may wait behind the
    // (≤2) already-posted jobs, never behind the queued backlog.
    const fake = new FakeWorker();
    const client = GenerationWorkerClient.__forTest(fake as unknown as Worker);

    // Fill the window, then flood the queue with 20 more DEM tiles.
    const busy1 = client.computeDemTile(EMPTY_TERRAIN, 6, 0, 0, 128, 50, 25);
    const demJobs: Promise<number[]>[] = [];
    for (let i = 0; i < 20; i++) demJobs.push(client.computeDemTile(EMPTY_TERRAIN, 6, i + 1, 0, 128, 50, 25));
    expect(fake.posted.length).toBe(2); // window full; 19 DEM tiles queued

    // The GM draws a river: region-gen arrives LAST but must dispatch NEXT.
    const river = client.generateRegion("river", 7, "riv", [[0, 0], [1, 1]], {}, EMPTY_CONSTRAINTS, [[0, 0], [1, 1]]);

    fake.completeAt(0);
    await busy1;
    expect(fake.posted.length).toBe(3);
    expect(fake.posted[2].kind).toBe("procgen-region"); // preempted the queued DEM backlog

    // After the river, the DEM backlog resumes in FIFO order.
    fake.completeAt(2);
    await river;
    expect(fake.posted[3].kind).toBe("dem-tile");
    // Drain the rest so no promise dangles (22 jobs total: busy + 20 DEM +
    // river; each completion pumps the next queued job into `posted`).
    fake.completeAt(1);
    for (let i = 3; i < 22; i++) fake.completeAt(i);
    await Promise.all(demJobs);
  });

  it("same-priority jobs keep FIFO order (stable)", async () => {
    const fake = new FakeWorker();
    const client = GenerationWorkerClient.__forTest(fake as unknown as Worker);
    const bbox: BBox = { minX: 0, minY: 0, maxX: 1, maxY: 1 };
    const busy1 = client.computeDemTile(EMPTY_TERRAIN, 0, 0, 0, 128, 50, 25);
    const busy2 = client.computeDemTile(EMPTY_TERRAIN, 0, 1, 0, 128, 50, 25);
    const a = client.generate("river" as never, 1, bbox, EMPTY_CONSTRAINTS); // TileJob → tile priority
    const b = client.computeDemTile(EMPTY_TERRAIN, 6, 24, 36, 128, 50, 25); // dem → tile priority
    fake.completeAt(0);
    await busy1;
    // Both the same priority → dispatched in enqueue order: generate (a) before dem (b).
    expect(fake.posted[2].kind).toBeUndefined(); // TileJob has no kind
    fake.completeAt(1);
    await busy2;
    expect(fake.posted[3].kind).toBe("dem-tile");
    fake.completeAt(2);
    await a;
    fake.completeAt(3);
    await b;
  });
});
