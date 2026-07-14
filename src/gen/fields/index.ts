/**
 * `src/gen/fields/` — reusable scalar fields over generation space (plan 023
 * §2). Distance/interiority/constraint fields today; the elevation layers
 * (gradient-damped fBm, §3) land in a later phase on this same base.
 *
 * Everything is pure/headless and point-evaluable (`f(x, y)` from durable
 * inputs only) — the property that keeps tiles seam-free and determinism cheap
 * (plan 023 §0). D1–D6 binding.
 *
 * The leaf distance/containment primitives are the bit-exact source of truth
 * for `region.ts`'s `interiorT`/`distanceToBoundary` and
 * `fabricConstraints.ts`'s `pointInRing` — see the BIT-EXACTNESS note in
 * `sdf.ts`.
 */
export type { Field, Pt } from "./sdf";
export {
  // Leaf primitives (bit-exact, imported back by region.ts / fabricConstraints.ts):
  distanceToRingBoundary,
  ringContainsEvenOdd,
  pointInRingClosed,
  distanceToPolyline,
  // Numeric signed distance (hot-path):
  signedDistancePolygon,
  signedDistancePolyline,
  // Field builders:
  sdfPolygon,
  sdfPolyline,
} from "./sdf";
export {
  fUnion,
  fIntersect,
  fSubtract,
  fSmoothUnion,
  fMask,
  fOffset,
  fScale,
  fClamp,
  fSum,
  fDomainWarp,
} from "./combinators";
export {
  // Metaball potential + Chaikin smoothing + contour→MultiPolygon assembly
  // (plan 026-B) — the reusable half of the organic-canopy pipeline: bumps a
  // density field around anchors, rounds a marching-squares ring, and nests the
  // closed loops into filled polygons with holes.
  metaballField,
} from "./metaball";
export { chaikinClosed } from "./smoothing";
export { contoursToMultiPolygon } from "./polygons";
export type { HeightSample, FbmErodedOptions, ElevationField } from "./elevation";
export {
  // Analytic-derivative noise + gradient-damped fBm (plan 023 §1.1) — the
  // elevation base, consumed first by the `mountain` generator.
  valueNoise2DWithDeriv,
  fbmEroded,
} from "./elevation";
export type { MountainTerrain, MountainParams, TerrainConfig } from "./mountainField";
export {
  // Mountain elevation field (plan 023 §3), moved verbatim from mountain.ts in
  // box 23-E — the shared cross-KIND elevation surface. `elevationFieldFromFabric`
  // composes the campaign field from the sketched mountain features carried on
  // GenerationConstraints: how farmland (paddy terraces) and the river (slope
  // coupling) legally read elevation without importing the mountain generator.
  MOUNTAIN_TERRAINS,
  mountainHeightField,
  elevationFieldFromFabric,
  terrainConfig,
  terrace,
} from "./mountainField";
export type { Contour, MarchingSquaresOptions } from "./marchingSquares";
export {
  // Iso-line / iso-band tracing over any scalar field (plan 023 §4.1) — the
  // reusable machinery behind mountain contours (23-C) and forest canopy (026-B).
  marchingSquares,
} from "./marchingSquares";
export {
  // DEM raster support for hillshade + 3D terrain (plan 023 §4.2): campaign
  // field composition, slippy-tile → gen-space sampling, raw-lattice
  // quantization + terrarium RGBA packing (the pure/numeric half — PNG encoding
  // is a host concern in campaignDemProtocol.ts).
  TERRARIUM_BASE,
  demVerticalScale,
  tileLngLatBounds,
  unionFields,
  demTileLattice,
  latticeToRGBA,
} from "./dem";
