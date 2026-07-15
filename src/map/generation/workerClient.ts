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
import type { GeneratorId, GenerationRequest, GenerationResponse } from "../../gen/worker/generationWorker";

export class GenerationWorkerClient {
  private worker: Worker | null;
  private nextRequestId = 1;
  private pending = new Map<number, { resolve: (f: GeoJSON.Feature[]) => void; reject: (e: Error) => void }>();

  private constructor(worker: Worker) {
    this.worker = worker;
    worker.onmessage = (event: MessageEvent<GenerationResponse>) => {
      const { requestId, features, error } = event.data;
      const entry = this.pending.get(requestId);
      if (!entry) return;
      this.pending.delete(requestId);
      if (error) entry.reject(new Error(error));
      else entry.resolve(features ?? []);
    };
    worker.onerror = (event: ErrorEvent) => {
      for (const { reject } of this.pending.values()) reject(new Error(event.message));
      this.pending.clear();
    };
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
    if (!this.worker) return Promise.reject(new Error("worker terminated"));
    const requestId = this.nextRequestId++;
    const request: GenerationRequest = { requestId, generatorId, seed, bbox, constraints };
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.worker!.postMessage(request);
    });
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
    if (!this.worker) return Promise.reject(new Error("worker terminated"));
    const requestId = this.nextRequestId++;
    const request: GenerationRequest = {
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
    };
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.worker!.postMessage(request);
    });
  }

  terminate(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const { reject } of this.pending.values()) reject(new Error("worker terminated"));
    this.pending.clear();
  }
}
