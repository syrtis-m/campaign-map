import { describe, it, expect } from "vitest";
import { GenerationWorkerClient } from "./workerClient";
import type { GenerationRequest, GenerationResponse } from "../../gen/worker/generationWorker";
import type { BBox } from "../../gen/spatialHash";
import type { GenerationConstraints } from "../../gen/types";

/**
 * Worker PRIORITY QUEUE (Jonah: "new 3D geography takes a long while to appear").
 * All jobs share the one single-threaded worker; the client feeds it its
 * highest-priority pending job when it frees up, so DEM tiles + GM region edits
 * jump the contour-leaf backlog instead of waiting behind it.
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
  /** Complete the most-recently-posted job (the one in flight). */
  completeLast(): void {
    const req = this.posted[this.posted.length - 1];
    this.onmessage?.({ data: { requestId: req.requestId, features: [] } } as unknown as MessageEvent<GenerationResponse>);
  }
  terminate(): void {}
}

describe("GenerationWorkerClient — priority queue", () => {
  it("a DEM tile queued behind a contour leaf is dispatched FIRST when the worker frees up", async () => {
    const fake = new FakeWorker();
    const client = GenerationWorkerClient.__forTest(fake as unknown as Worker);

    // Occupy the worker with a first job (in-flight window = 1).
    const busy = client.computeContourLeaf(EMPTY_TERRAIN, 0, 0, {} as never);
    expect(fake.posted.length).toBe(1); // the busy job is in flight

    // While the worker is busy, enqueue a contour leaf THEN a DEM tile.
    const contour = client.computeContourLeaf(EMPTY_TERRAIN, 1, 1, {} as never);
    const dem = client.computeDemTile(EMPTY_TERRAIN, 6, 24, 36, 128, 50, 25);
    expect(fake.posted.length).toBe(1); // both still queued — worker busy

    // Free the worker: the DEM tile (priority 1) must be picked ahead of the
    // still-queued contour leaf (priority 2), even though it was enqueued LAST.
    fake.completeLast();
    await busy;
    expect(fake.posted.length).toBe(2);
    expect(fake.posted[1].kind).toBe("dem-tile");

    // Then the contour leaf.
    fake.completeLast();
    await dem;
    expect(fake.posted.length).toBe(3);
    expect(fake.posted[2].kind).toBe("contour-leaf");
    fake.completeLast();
    await contour;
  });

  it("a GM region edit is not starved — dispatched ahead of a queued contour leaf", async () => {
    const fake = new FakeWorker();
    const client = GenerationWorkerClient.__forTest(fake as unknown as Worker);
    const busy = client.computeContourLeaf(EMPTY_TERRAIN, 0, 0, {} as never);
    const contour = client.computeContourLeaf(EMPTY_TERRAIN, 1, 1, {} as never);
    const region = client.generateRegion("city", 1, "r", [[0, 0], [1, 0], [1, 1]], {}, EMPTY_CONSTRAINTS);
    fake.completeLast();
    await busy;
    expect(fake.posted[1].kind).toBe("procgen-region");
    fake.completeLast();
    await region;
    fake.completeLast();
    await contour;
  });

  it("a GM river (region-gen) PREEMPTS a DEM-tile backlog — dispatched next, not FIFO-last (Bug B: Cradle river invisible)", async () => {
    // The Cradle repro: a cold view has dozens of DEM tiles already queued when
    // the GM finishes drawing a river. Region-gen (priority 0) must jump the whole
    // DEM backlog (priority 1) at the next job boundary — otherwise the river's
    // channel paints only after every tile drains ("i can't see it").
    const fake = new FakeWorker();
    const client = GenerationWorkerClient.__forTest(fake as unknown as Worker);

    // Occupy the worker, then flood the queue with 20 DEM tiles.
    const busy = client.computeDemTile(EMPTY_TERRAIN, 6, 0, 0, 128, 50, 25);
    const demJobs: Promise<number[]>[] = [];
    for (let i = 0; i < 20; i++) demJobs.push(client.computeDemTile(EMPTY_TERRAIN, 6, i + 1, 0, 128, 50, 25));
    expect(fake.posted.length).toBe(1); // 20 DEM tiles queued behind the busy one

    // The GM draws a river: region-gen arrives LAST but must dispatch NEXT.
    const river = client.generateRegion("river", 7, "riv", [[0, 0], [1, 1]], {}, EMPTY_CONSTRAINTS, [[0, 0], [1, 1]]);

    fake.completeLast();
    await busy;
    expect(fake.posted.length).toBe(2);
    expect(fake.posted[1].kind).toBe("procgen-region"); // preempted all 20 DEM tiles

    // After the river, the DEM backlog resumes in FIFO order.
    fake.completeLast();
    await river;
    expect(fake.posted[2].kind).toBe("dem-tile");
    // Drain the rest so no promise dangles.
    for (let i = 0; i < 20; i++) fake.completeLast();
    await Promise.all(demJobs);
  });

  it("same-priority jobs keep FIFO order (stable)", async () => {
    const fake = new FakeWorker();
    const client = GenerationWorkerClient.__forTest(fake as unknown as Worker);
    const bbox: BBox = { minX: 0, minY: 0, maxX: 1, maxY: 1 };
    const busy = client.computeDemTile(EMPTY_TERRAIN, 0, 0, 0, 128, 50, 25);
    const a = client.generate("river" as never, 1, bbox, EMPTY_CONSTRAINTS); // default → 0
    const b = client.computeDemTile(EMPTY_TERRAIN, 6, 24, 36, 128, 50, 25); // dem → 0
    fake.completeLast();
    await busy;
    // Both priority 0 → dispatched in enqueue order: generate (a) before dem (b).
    expect(fake.posted[1].kind).toBeUndefined(); // TileJob has no kind
    fake.completeLast();
    await a;
    expect(fake.posted[2].kind).toBe("dem-tile");
    fake.completeLast();
    await b;
  });
});
