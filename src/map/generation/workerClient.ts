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

export class GenerationWorkerClient {
  private worker: Worker | null;
  private nextRequestId = 1;
  private pending = new Map<number, { resolve: (r: GenerationResponse) => void; reject: (e: Error) => void }>();

  private constructor(worker: Worker) {
    this.worker = worker;
    worker.onmessage = (event: MessageEvent<GenerationResponse>) => {
      const entry = this.pending.get(event.data.requestId);
      if (!entry) return;
      this.pending.delete(event.data.requestId);
      if (event.data.error) entry.reject(new Error(event.data.error));
      else entry.resolve(event.data);
    };
    worker.onerror = (event: ErrorEvent) => {
      for (const { reject } of this.pending.values()) reject(new Error(event.message));
      this.pending.clear();
    };
  }

  /** Dispatch a request and resolve with the raw response (the caller unwraps
   * `features`/`heights`). */
  private dispatch(request: GenerationRequest): Promise<GenerationResponse> {
    if (!this.worker) return Promise.reject(new Error("worker terminated"));
    return new Promise((resolve, reject) => {
      this.pending.set(request.requestId, { resolve, reject });
      this.worker!.postMessage(request);
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
    for (const { reject } of this.pending.values()) reject(new Error("worker terminated"));
    this.pending.clear();
  }
}
