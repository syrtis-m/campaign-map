/**
 * Web Worker entry point (docs/02 §5: "Generation runs in a Web Worker...
 * so the map tab never stutters"). Dispatches tile-generation requests to
 * the pure generators in src/gen/ — this file is the ONLY thing in src/gen/
 * that isn't itself host-agnostic (it uses postMessage/self), which is why
 * it lives in its own worker/ subfolder rather than alongside the generators.
 */
import { z } from "zod";
import { generateWorldRegions, generateSettlements, generateRoutes } from "../world";
import { algorithmById, type ProcgenAlgorithm } from "../procgen/registry";
import { makeRegion, makeSpine, makeCorridorRegion, type ProcgenRegion } from "../region";
import type { GenerationConstraints } from "../types";
import type { BBox } from "../spatialHash";

/** World-tier generators are per-tile; city-tier generation is region-scoped —
 * the whole-region network is the one expensive job that must run off-thread,
 * dispatched via the procgen registry. */
export type GeneratorId = "world-region" | "world-settlement" | "world-route";

const GENERATORS: Record<GeneratorId, (seed: number, bbox: BBox, c: GenerationConstraints) => GeoJSON.Feature[]> = {
  "world-region": generateWorldRegions,
  "world-settlement": generateSettlements,
  "world-route": generateRoutes,
};

type Pt = [number, number];

/** A whole-region procgen job. The worker resolves the
 * algorithm from the registry, rebuilds the region from its ring (polygon
 * kinds) or its `spine` (line kinds), and runs the pure generator —
 * `seed`/`params` come from the region's persisted procgen block, so identity
 * is durable data, never derived at run time. */
export interface ProcgenRegionJob {
  kind: "procgen-region";
  requestId: number;
  algorithmId: string;
  seed: number;
  regionId: string;
  ring: Pt[];
  /** LINE-kind (river/wall) corridor spine — the mm-quantized polyline the
   * generator elaborates (plan 031-D). Present ⇔ this is a spine corridor; the
   * worker rebuilds `makeCorridorRegion(makeSpine(spine), corridorMaxOffset)` so
   * line-kind regen leaves the main thread. Absent ⇒ a polygon region rebuilt
   * from `ring`. Plain data (a Pt[]), structured-clone-safe. */
  spine?: Pt[];
  params: Record<string, unknown>;
  constraints: GenerationConstraints;
}

/** IO-boundary validation (CLAUDE.md) for the one non-primitive field the
 * worker reconstructs geometry from: a spine is an array of [x,y] points. A
 * corrupt structured-clone payload fails LOUDLY here rather than silently
 * rebuilding the wrong (polygon) region. */
const JobSpineSchema = z.array(z.tuple([z.number(), z.number()]));

/**
 * Rebuild the ProcgenRegion a job describes — the SINGLE reconstruct step shared
 * by `self.onmessage` and the headless round-trip test (a real Web Worker can't
 * spin in Vitest). A spine payload rebuilds the corridor region exactly as the
 * host's `buildRegionFromFeature` does (`makeSpine` → `makeCorridorRegion` with
 * the algorithm's `corridorMaxOffset(params)`), so the worker output is
 * byte-identical to the main-thread fallback. Pure/deterministic.
 */
export function reconstructJobRegion(
  algorithm: ProcgenAlgorithm,
  regionId: string,
  ring: Pt[],
  spine: Pt[] | undefined,
  params: Record<string, unknown>
): ProcgenRegion {
  if (spine !== undefined) {
    if (!algorithm.corridorMaxOffset) {
      throw new Error(`procgen algorithm ${algorithm.id} received a spine but is not a line-kind generator`);
    }
    const points = JobSpineSchema.parse(spine) as Pt[];
    return makeCorridorRegion(regionId, makeSpine(regionId, points), algorithm.corridorMaxOffset(params));
  }
  return makeRegion(regionId, ring);
}

export interface TileJob {
  kind?: undefined;
  requestId: number;
  generatorId: GeneratorId;
  seed: number;
  bbox: BBox;
  constraints: GenerationConstraints;
}

export type GenerationRequest = TileJob | ProcgenRegionJob;

export interface GenerationResponse {
  requestId: number;
  features?: GeoJSON.Feature[];
  error?: string;
}

/**
 * Dispatch one request to its generator and package the response. Pure (no
 * `self`/postMessage), so the round-trip test drives the exact same path
 * `self.onmessage` does without a live Worker. Errors are returned as an
 * `error` response, never thrown, mirroring the worker's contract.
 */
export function handleWorkerMessage(req: GenerationRequest): GenerationResponse {
  try {
    let features: GeoJSON.Feature[];
    if (req.kind === "procgen-region") {
      const algorithm = algorithmById(req.algorithmId);
      if (!algorithm) throw new Error(`unknown procgen algorithm: ${req.algorithmId}`);
      const region = reconstructJobRegion(algorithm, req.regionId, req.ring, req.spine, req.params);
      features = algorithm.generate(req.seed, region, req.params, req.constraints);
    } else {
      const generator = GENERATORS[req.generatorId];
      if (!generator) throw new Error(`unknown generatorId: ${req.generatorId}`);
      features = generator(req.seed, req.bbox, req.constraints);
    }
    return { requestId: req.requestId, features };
  } catch (err) {
    return { requestId: req.requestId, error: err instanceof Error ? err.message : String(err) };
  }
}

// Register the worker handler only in a real Worker context — importing this
// module for its pure exports (registry dispatch, `reconstructJobRegion`,
// `handleWorkerMessage`) in node/Vitest must not touch the undefined `self`
// (`typeof` on the global is safe even when it isn't defined).
if (typeof self !== "undefined" && typeof self.postMessage === "function") {
  const worker = self as unknown as Worker;
  worker.onmessage = (event: MessageEvent<GenerationRequest>) => {
    worker.postMessage(handleWorkerMessage(event.data));
  };
}
