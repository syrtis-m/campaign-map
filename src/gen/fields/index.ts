/**
 * `src/gen/fields/` — reusable scalar fields over generation space:
 * distance/interiority/constraint fields plus the elevation layers
 * (gradient-damped fBm).
 *
 * Everything is pure/headless and point-evaluable (`f(x, y)` from durable
 * inputs only) — the property that keeps tiles seam-free and determinism cheap.
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
  // Metaball potential + Chaikin smoothing + contour→MultiPolygon assembly —
  // the reusable half of the organic-canopy pipeline: bumps a density field
  // around anchors, rounds a marching-squares ring, and nests the closed loops
  // into filled polygons with holes.
  metaballField,
} from "./metaball";
export { chaikinClosed } from "./smoothing";
export { contoursToMultiPolygon } from "./polygons";
export type { HeightSample, FbmErodedOptions, ElevationField } from "./elevation";
export {
  // Analytic-derivative noise + gradient-damped fBm — the elevation base,
  // consumed first by the `mountain` generator.
  valueNoise2DWithDeriv,
  fbmEroded,
} from "./elevation";
export type { MountainTerrain, MountainParams, TerrainConfig } from "./mountainField";
export {
  // Mountain elevation field — the shared cross-KIND elevation surface.
  // `elevationFieldFromFabric` composes the campaign field from the sketched
  // mountain features carried on GenerationConstraints: how farmland (paddy
  // terraces) and the river (slope coupling) legally read elevation without
  // importing the mountain generator.
  MOUNTAIN_TERRAINS,
  mountainHeightField,
  elevationFieldFromFabric,
  terrainConfig,
  terrace,
} from "./mountainField";
export type {
  TerrainBaseParams,
  TerrainOptions,
  ReliefParams,
  ReliefPolarity,
  LandformParams,
  LandformMode,
} from "./terrain";
export {
  // The composed campaign terrain field (plan 036): base + mountain-union add +
  // relief/landform stamps. Byte-identical to `elevationFieldFromFabric` on a
  // mountain-only campaign (the migration is a call); the drop-in the river slope
  // + farmland paddy consumers read.
  terrainAt,
  hasTerrainRelief,
  DEFAULT_TERRAIN_BASE,
  RELIEF_POLARITIES,
  RELIEF_DEFAULTS,
  reliefMaxOffset,
  LANDFORM_MODES,
  LANDFORM_DEFAULTS,
} from "./terrain";
export type { FieldLatticeOptions } from "./fieldLattice";
export {
  // Chunked, LRU-bounded lazy field-sample lattice (plan 036-B/-C) — the
  // substrate the viewport-keyed contour/DEM leaves sample the composed terrain
  // field through, never eagerly whole-campaign.
  FieldLattice,
} from "./fieldLattice";
export type { Contour, MarchingSquaresOptions } from "./marchingSquares";
export {
  // Iso-line / iso-band tracing over any scalar field — the reusable machinery
  // behind mountain contours and forest canopy.
  marchingSquares,
} from "./marchingSquares";
export {
  // DEM raster support for hillshade + 3D terrain: campaign
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
