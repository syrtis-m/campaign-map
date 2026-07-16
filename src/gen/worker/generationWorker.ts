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
import { terrainAt, type TerrainBaseParams } from "../fields/terrain";
import { demTileLattice } from "../fields/dem";
import { traceTerrainContourTile, type ContourTileParams } from "../fields/terrainContours";
import type { ElevationField } from "../fields/elevation";
import type { GenerationConstraints } from "../types";
import type { BBox } from "../spatialHash";
import type { FabricFeature } from "../../model/fabric";

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

/**
 * The DURABLE, plain-data terrain inputs a DEM/contour job carries across the
 * structured-clone boundary (Jonah 2026-07-15: per-tile terrain sampling moves
 * off the main thread — the cold DEM fill stalled the renderer). The worker
 * rebuilds the SAME composed field `campaignElevationSnapshot` builds on the main
 * thread (`terrainAt` over the sketch layer), so worker output is byte-identical
 * to the main-thread fallback. `features` are gen-space METERS (already unit-
 * transformed by the host, exactly as `campaignElevationSnapshot` does).
 */
export interface SerializableTerrainInputs {
  features: FabricFeature[];
  base: TerrainBaseParams;
  campaignSeed: number;
  include: { relief: boolean; landform: boolean; carve: boolean; grade: boolean };
}

/** A DEM tile lattice-fill job — the 256² field sampling that stalled the main
 * thread. Returns the quantized int lattice (the durable determinism record). */
export interface DemTileJob {
  kind: "dem-tile";
  requestId: number;
  terrain: SerializableTerrainInputs;
  z: number;
  x: number;
  y: number;
  res: number;
  scaleMetersPerUnit: number;
  k: number;
}

/** A single global-terrain contour leaf (one world-aligned tile). Returns the
 * `terrain-contour` line features (gen-space meters — the host converts to
 * display units before setData). */
export interface ContourLeafJob {
  kind: "contour-leaf";
  requestId: number;
  terrain: SerializableTerrainInputs;
  tx: number;
  ty: number;
  params: ContourTileParams;
}

export type GenerationRequest = TileJob | ProcgenRegionJob | DemTileJob | ContourLeafJob;

export interface GenerationResponse {
  requestId: number;
  features?: GeoJSON.Feature[];
  /** DEM-tile jobs only: the quantized int height lattice (row-major res²). */
  heights?: number[];
  error?: string;
}

/** Rebuild the composed campaign terrain field from the plain-data inputs — the
 * SINGLE reconstruct shared by the worker dispatch and the round-trip test, and
 * byte-matched to the main thread's `terrainAt` call in
 * `campaignElevationSnapshot`. Pure/deterministic.
 *
 * MEMOIZED across jobs: one edit fans out to dozens of dem-tile/contour-leaf
 * jobs carrying byte-identical inputs, and `terrainAt`'s setup (river centerline
 * resample, spine-clearance occupancy grid, per-stamp segment hashes) costs
 * hundreds of ms — measured 2026-07-16 on Cradle: ~200–500 ms of every leaf
 * job was field rebuild. Reusing the closure is byte-safe because a `terrainAt`
 * field is a pure function of its inputs (no per-call state). Tiny LRU (not
 * size-1) so a drag preview's draft inputs and the durable inputs can coexist
 * without thrashing. */
const FIELD_MEMO_MAX = 4;
const fieldMemo = new Map<string, ElevationField>();

export function terrainFieldFromInputs(t: SerializableTerrainInputs): ElevationField {
  const key = JSON.stringify(t);
  const hit = fieldMemo.get(key);
  if (hit) {
    fieldMemo.delete(key); // LRU touch
    fieldMemo.set(key, hit);
    return hit;
  }
  const field = terrainAt(t.features, { base: t.base, campaignSeed: t.campaignSeed, include: t.include });
  fieldMemo.set(key, field);
  while (fieldMemo.size > FIELD_MEMO_MAX) {
    const oldest = fieldMemo.keys().next().value;
    if (oldest === undefined) break;
    fieldMemo.delete(oldest);
  }
  return field;
}

/**
 * Dispatch one request to its generator and package the response. Pure (no
 * `self`/postMessage), so the round-trip test drives the exact same path
 * `self.onmessage` does without a live Worker. Errors are returned as an
 * `error` response, never thrown, mirroring the worker's contract.
 */
export function handleWorkerMessage(req: GenerationRequest): GenerationResponse {
  try {
    if (req.kind === "procgen-region") {
      const algorithm = algorithmById(req.algorithmId);
      if (!algorithm) throw new Error(`unknown procgen algorithm: ${req.algorithmId}`);
      const region = reconstructJobRegion(algorithm, req.regionId, req.ring, req.spine, req.params);
      return { requestId: req.requestId, features: algorithm.generate(req.seed, region, req.params, req.constraints) };
    }
    if (req.kind === "dem-tile") {
      const field = terrainFieldFromInputs(req.terrain);
      const heights = demTileLattice(field, req.z, req.x, req.y, req.res, req.scaleMetersPerUnit, req.k);
      return { requestId: req.requestId, heights };
    }
    if (req.kind === "contour-leaf") {
      const field = terrainFieldFromInputs(req.terrain);
      const elev = (x: number, y: number): number => field(x, y).v;
      return { requestId: req.requestId, features: traceTerrainContourTile(elev, req.tx, req.ty, req.params) };
    }
    const generator = GENERATORS[req.generatorId];
    if (!generator) throw new Error(`unknown generatorId: ${req.generatorId}`);
    return { requestId: req.requestId, features: generator(req.seed, req.bbox, req.constraints) };
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
