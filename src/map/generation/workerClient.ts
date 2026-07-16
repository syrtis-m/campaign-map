/**
 * Loads the generation Web Worker bundle (esbuild's second entry point,
 * generation-worker.js) via a Blob URL — reading the built file's text
 * through the vault adapter and constructing the worker from that, rather
 * than a direct file:// path, sidesteps Electron-renderer origin/CSP
 * quirks around `new Worker(path)` (same class of problem glyphs.ts solves
 * for font PBFs via `getResourcePath()`, just one level more indirect since
 * a Worker can't be pointed at an app:// resource URL the way an <img> can).
 */
import type { App } from "obsidian";
import type { BBox } from "../../gen/spatialHash";
import type { GenerationConstraints } from "../../gen/types";
import type { ContourTileParams } from "../../gen/fields/terrainContours";
import type {
  GeneratorId,
  GenerationRequest,
  GenerationResponse,
  SerializableTerrainInputs,
} from "../../gen/worker/generationWorker";

/**
 * Job PRIORITY (lower = sooner). All jobs share the ONE generation worker, which
 * is single-threaded, so a naive post-everything-immediately let the cheap contour
 * leaves a camera move enqueues run AHEAD of the DEM tiles the 3D view actually
 * needs (Jonah: "new 3D geography takes a long while to appear"). The client now
 * holds jobs in a priority queue and only feeds the worker its highest-priority
 * pending job when it frees up.
 *
 * Region generation is STRICTLY above the DEM-tile / world-tile tier (Jonah
 * 2026-07-15, Cradle: "after drawing a river i can't see it"). A cold Cradle view
 * has dozens of 128² DEM tile jobs (50–450 ms each) already queued; when both
 * region-gen AND DEM sat at the SAME priority, a GM's freshly-drawn river waited
 * FIFO behind that entire tile backlog before its channel could paint. A GM edit
 * is a direct, explicit request — it must PREEMPT the tile backlog at the next job
 * boundary. So: region 0 (a GM edit — never lags) > DEM + world tiles 1 (3D nav /
 * base fill — interactive but background to an edit) > contour leaves 2 (a
 * background overlay — yields to everything). Same-priority jobs keep FIFO. */
const REGION_PRIORITY = 0;
const TILE_PRIORITY = 1;
const CONTOUR_PRIORITY = 2;
const JOB_PRIORITY: Record<string, number> = {
  "procgen-region": REGION_PRIORITY, // a GM edit — must preempt the tile backlog
  "dem-tile": TILE_PRIORITY, // 3D terrain — interactive, but yields to a GM edit
  default: TILE_PRIORITY, // world-tier tile generation (TileJob has no `kind`)
  "contour-leaf": CONTOUR_PRIORITY, // background contour overlay — yields to the above
};

interface QueuedJob {
  request: GenerationRequest;
  priority: number;
  seq: number; // FIFO tiebreak within a priority
  resolve: (r: GenerationResponse) => void;
  reject: (e: Error) => void;
}

export class GenerationWorkerClient {
  private worker: Worker | null;
  private nextRequestId = 1;
  private pending = new Map<number, { resolve: (r: GenerationResponse) => void; reject: (e: Error) => void }>();
  private queue: QueuedJob[] = [];
  private inFlight = 0;
  private seqCounter = 0;
  /** The worker is single-threaded, so 1-in-flight gives STRICT priority order at
   * a negligible inter-job postMessage round-trip (sub-ms vs 50–450 ms jobs) and
   * never leaves a lower-priority job blocking a higher one that arrives mid-burst. */
  private readonly maxInFlight = 1;

  private constructor(worker: Worker) {
    this.worker = worker;
    worker.onmessage = (event: MessageEvent<GenerationResponse>) => {
      const entry = this.pending.get(event.data.requestId);
      if (entry) {
        this.pending.delete(event.data.requestId);
        this.inFlight--;
        if (event.data.error) entry.reject(new Error(event.data.error));
        else entry.resolve(event.data);
      }
      this.pump();
    };
    worker.onerror = (event: ErrorEvent) => {
      const err = new Error(event.message);
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
      for (const job of this.queue.splice(0)) job.reject(err);
      this.inFlight = 0;
    };
  }

  /** Feed the worker its highest-priority pending job(s) up to the in-flight
   * window. Called on enqueue and on every response, so a job that arrives while
   * the worker is busy is reordered against the rest of the backlog before the
   * worker picks next. */
  private pump(): void {
    if (!this.worker) return;
    while (this.inFlight < this.maxInFlight && this.queue.length > 0) {
      let best = 0;
      for (let i = 1; i < this.queue.length; i++) {
        const q = this.queue[i];
        const b = this.queue[best];
        if (q.priority < b.priority || (q.priority === b.priority && q.seq < b.seq)) best = i;
      }
      const job = this.queue.splice(best, 1)[0];
      this.pending.set(job.request.requestId, { resolve: job.resolve, reject: job.reject });
      this.inFlight++;
      this.worker.postMessage(job.request);
    }
  }

  /** Enqueue a request at its kind's priority and resolve with the raw response
   * (the caller unwraps `features`/`heights`). */
  private dispatch(request: GenerationRequest): Promise<GenerationResponse> {
    if (!this.worker) return Promise.reject(new Error("worker terminated"));
    const kind = (request as { kind?: string }).kind ?? "default";
    const priority = JOB_PRIORITY[kind] ?? JOB_PRIORITY.default;
    return new Promise((resolve, reject) => {
      this.queue.push({ request, priority, seq: this.seqCounter++, resolve, reject });
      this.pump();
    });
  }

  static async create(app: App): Promise<GenerationWorkerClient> {
    const workerPath = `${app.vault.configDir}/plugins/campaign-map/generation-worker.js`;
    const code = await app.vault.adapter.read(workerPath);
    const blob = new Blob([code], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    try {
      return new GenerationWorkerClient(new Worker(url));
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /** TEST SEAM: build a client over a fake worker to exercise the priority queue
   * without a live Web Worker. */
  static __forTest(worker: Worker): GenerationWorkerClient {
    return new GenerationWorkerClient(worker);
  }

  generate(
    generatorId: GeneratorId,
    seed: number,
    bbox: BBox,
    constraints: GenerationConstraints
  ): Promise<GeoJSON.Feature[]> {
    const requestId = this.nextRequestId++;
    return this.dispatch({ requestId, generatorId, seed, bbox, constraints }).then((r) => r.features ?? []);
  }

  /** DEM tile lattice fill, OFF the main thread (Jonah 2026-07-15). Returns the
   * quantized int height lattice; the protocol handler caches + PNG-encodes it. */
  computeDemTile(
    terrain: SerializableTerrainInputs,
    z: number,
    x: number,
    y: number,
    res: number,
    scaleMetersPerUnit: number,
    k: number
  ): Promise<number[]> {
    const requestId = this.nextRequestId++;
    return this.dispatch({ kind: "dem-tile", requestId, terrain, z, x, y, res, scaleMetersPerUnit, k }).then(
      (r) => r.heights ?? []
    );
  }

  /** One global-terrain contour leaf (one world-aligned tile), OFF the main
   * thread. Returns `terrain-contour` line features in gen-space meters. */
  computeContourLeaf(
    terrain: SerializableTerrainInputs,
    tx: number,
    ty: number,
    params: ContourTileParams
  ): Promise<GeoJSON.Feature[]> {
    const requestId = this.nextRequestId++;
    return this.dispatch({ kind: "contour-leaf", requestId, terrain, tx, ty, params }).then((r) => r.features ?? []);
  }

  /** Whole-region network computation — the expensive job that must run
   * off-thread. `seed`/`params` come from the
   * region's persisted procgen block; the worker rebuilds the region from
   * `ring` + `regionId` and dispatches the registry algorithm. */
  generateRegion(
    algorithmId: string,
    seed: number,
    regionId: string,
    ring: [number, number][],
    params: Record<string, unknown>,
    constraints: GenerationConstraints,
    spine?: [number, number][]
  ): Promise<GeoJSON.Feature[]> {
    const requestId = this.nextRequestId++;
    return this.dispatch({
      kind: "procgen-region",
      requestId,
      algorithmId,
      seed,
      regionId,
      ring,
      // Present only for line-kind regions (031-D); a polygon region omits it so
      // the worker rebuilds from `ring` — payload stays minimal and unchanged.
      ...(spine ? { spine } : {}),
      params,
      constraints,
    }).then((r) => r.features ?? []);
  }

  terminate(): void {
    this.worker?.terminate();
    this.worker = null;
    const err = new Error("worker terminated");
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
    for (const job of this.queue.splice(0)) job.reject(err);
    this.inFlight = 0;
  }
}
