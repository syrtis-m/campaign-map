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

    // Free the worker: the DEM tile (priority 0) must be picked ahead of the
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
