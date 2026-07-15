/**
 * The style contract: one declarative manifest per algorithm binding every
 * emitted generator-id (gid) to a semantic paint role, a mark kind, and a
 * z-slot within the generated group. Three consumers read it: `tileGeneratorIds`
 * derives from `contract.map(b => b.gid)` (the host's cache keys + tile clip),
 * the theme paint builder turns each bucket into MapLibre layers via a
 * role→value map, and a unit test asserts every gid a generator can emit appears
 * here (an uncached gid is silently dropped at the tile clip — the contract makes
 * that class of bug structural).
 *
 * Pure data — no maplibre, no DOM, no Obsidian (this module lives under `src/gen`
 * and must stay host-agnostic and importable by both the registry and
 * `map/themes` without a cycle). Colors, opacities and width ramps are the paint
 * builder's business, not the contract's; the contract carries only the semantic
 * binding that lets a NEW bucket paint in every theme with a one-line addition.
 */

/**
 * The fixed vocabulary of paint roles. Small and deliberate: a new role is a
 * design act (a theme must assign it a value), not a per-bucket color pick. Each
 * maps to exactly one per-theme fabric token, so a bucket's role fixes its hue
 * family across all five themes.
 *
 * Additions beyond a plain land/water/built/route/boundary/relief/accent core,
 * each because the existing paint genuinely distinguishes the token:
 *  - `water` (flowing: river channel/canal) vs `water-body` (still: moat, pond,
 *    ocean) — two distinct water tokens the themes already separate.
 *  - `water-edge` — the pond shore-casing token, distinct from either water.
 *  - `vegetation` (manicured park green) vs `vegetation-deep` (woodland canopy).
 *  - `cultivated` — tilled-field ochre, neither green nor built.
 *  - `path-casing` — the dark cased-path / rim edge token (park paths, canopy
 *    rims, raked gravel), distinct from the masonry `boundary`.
 *  - `built-accent` — the low-opacity neighborhood district wash.
 *  - `terrain-contour` — the global iso-line hue (relief-derived, painted by the
 *    dedicated `terrain-contour` layer over the campaign terrain field, not a
 *    generated-fabric bucket). Distinct from `relief` (mountain massif/hachure)
 *    so a theme could later diverge the two; today both derive from the mountain
 *    stone token.
 */
export type SemanticRole =
  | "water"
  | "water-body"
  | "water-edge"
  | "ground"
  | "vegetation"
  | "vegetation-deep"
  | "cultivated"
  | "built"
  | "built-accent"
  | "route"
  | "boundary"
  | "path-casing"
  | "relief"
  | "terrain-contour"
  | "accent";

/**
 * How a bucket paints. `fill`/`line` are the polygon/linestring marks; `point`
 * is a point-geometry marker the recipe renders as a circle or an SDF-glyph
 * symbol; `fill+outline` is a fill with a stroked edge in one bucket. A bucket's
 * primary mark — a multi-layer bucket (e.g. a cased path) still names the mark of
 * its principal layer.
 */
export type Mark = "fill" | "line" | "point" | "fill+outline";

export interface BucketStyle {
  /** The emitted generator-id this bucket paints. */
  gid: string;
  /** Primary MapLibre geometry class. */
  mark: Mark;
  /** Semantic paint role → a per-theme color via the role→value map. */
  role: SemanticRole;
  /** Order within the generated group (globally unique across all contracts);
   * the paint builder emits buckets in ascending `z`. A multi-layer bucket
   * emits its layers contiguously starting at `z`. */
  z: number;
  /** LINE marks whose width reads a feature property (e.g. street `width`). */
  widthFromProp?: string;
  /** LINE marks drawn as a dash pattern (overland routes). */
  dashed?: boolean;
  /** Emitted but deliberately unpainted (e.g. `city-block` faces are subdivided
   * into painted parcels; the face polygon itself draws nothing). Kept in the
   * contract so it stays in `tileGeneratorIds` and passes the emitted-gid ⊆
   * contract test, while contributing no layer. */
  unpainted?: boolean;
}

/**
 * World-tier fabric (not a region algorithm — world-region + world-route are
 * emitted by the world-tier generators). Painted by the same builder so a
 * generated ocean/coast and overland route read as fabric.
 */
export const WORLD_STYLE_CONTRACT: readonly BucketStyle[] = [
  { gid: "world-region", mark: "fill", role: "ground", z: 0 },
  { gid: "world-route", mark: "line", role: "route", z: 50, dashed: true },
];

/** City. Bucket order matches `DOMAIN_TILE_GENERATOR_IDS`. `city-landmark` paints
 * three layers (landmark fill + canal line + gate circle, discriminated by the
 * feature `type`). `city-block` is unpainted. `city-street` paints last of all
 * generated layers. */
export const CITY_STYLE_CONTRACT: readonly BucketStyle[] = [
  { gid: "city-street", mark: "line", role: "route", z: 51, widthFromProp: "width" },
  { gid: "city-block", mark: "fill", role: "built", z: -1, unpainted: true },
  { gid: "city-parcel", mark: "line", role: "built", z: 13 },
  { gid: "city-footprint", mark: "fill", role: "built", z: 12 },
  { gid: "city-landmark", mark: "fill", role: "built", z: 14 },
  { gid: "city-district", mark: "fill", role: "built-accent", z: 11 },
];

/** River. Bucket order matches `RIVER_TILE_GENERATOR_IDS`. */
export const RIVER_STYLE_CONTRACT: readonly BucketStyle[] = [
  { gid: "river-channel", mark: "fill", role: "water", z: 18 },
  { gid: "river-bank", mark: "line", role: "water", z: 17 },
  { gid: "river-island", mark: "fill", role: "ground", z: 23 },
  { gid: "river-confluence", mark: "fill", role: "water", z: 19 },
  { gid: "river-distributary", mark: "fill", role: "water", z: 20 },
  { gid: "river-estuary", mark: "fill", role: "water", z: 21 },
  { gid: "river-oxbow", mark: "fill", role: "water", z: 22 },
  { gid: "river-point-bar", mark: "fill", role: "ground", z: 24 },
  { gid: "river-glyph", mark: "point", role: "water", z: 25 },
];

/** Forest. Bucket order matches `FOREST_TILE_GENERATOR_IDS`. `forest-tree` paints
 * two layers (drop-shadow symbol under a variety-tinted base symbol). */
export const FOREST_STYLE_CONTRACT: readonly BucketStyle[] = [
  { gid: "forest-canopy", mark: "fill", role: "vegetation-deep", z: 26 },
  { gid: "forest-canopy-rim", mark: "line", role: "vegetation-deep", z: 27 },
  { gid: "forest-clearing", mark: "fill", role: "ground", z: 28 },
  { gid: "forest-tree", mark: "point", role: "vegetation-deep", z: 29 },
];

/** Park. Bucket order matches `PARK_TILE_GENERATOR_IDS`. `park-path` paints two
 * layers (casing under fill). */
export const PARK_STYLE_CONTRACT: readonly BucketStyle[] = [
  { gid: "park-lawn", mark: "fill", role: "vegetation", z: 31 },
  { gid: "park-canopy", mark: "fill", role: "vegetation-deep", z: 32 },
  { gid: "park-bed", mark: "fill", role: "vegetation-deep", z: 34 },
  { gid: "park-path", mark: "line", role: "route", z: 37 },
  { gid: "park-pond", mark: "fill", role: "water-body", z: 39 },
  { gid: "park-island", mark: "fill", role: "ground", z: 41 },
  { gid: "park-bridge", mark: "fill", role: "boundary", z: 42 },
  { gid: "park-court", mark: "fill", role: "boundary", z: 35 },
  { gid: "park-rock", mark: "point", role: "boundary", z: 44 },
  { gid: "park-tree", mark: "point", role: "vegetation-deep", z: 43 },
  { gid: "park-point", mark: "point", role: "accent", z: 45 },
  { gid: "park-canopy-rim", mark: "line", role: "path-casing", z: 33 },
  { gid: "park-pond-shore", mark: "line", role: "water-edge", z: 40 },
  { gid: "park-court-rake", mark: "line", role: "path-casing", z: 36 },
];

/** Wall. Bucket order matches `WALL_TILE_GENERATOR_IDS`. */
export const WALL_STYLE_CONTRACT: readonly BucketStyle[] = [
  { gid: "wall-moat", mark: "fill", role: "water-body", z: 46 },
  { gid: "wall-quad", mark: "fill", role: "boundary", z: 47 },
  { gid: "wall-tower", mark: "fill", role: "boundary", z: 48 },
  { gid: "wall-gate", mark: "point", role: "boundary", z: 49 },
];

/** Farmland. Bucket order matches `FARMLAND_TILE_GENERATOR_IDS`. */
export const FARMLAND_STYLE_CONTRACT: readonly BucketStyle[] = [
  { gid: "farm-field", mark: "fill", role: "cultivated", z: 5 },
  { gid: "farm-lane", mark: "line", role: "route", z: 7 },
  { gid: "farm-hedge", mark: "line", role: "vegetation-deep", z: 8 },
  { gid: "farm-building", mark: "fill", role: "built", z: 9 },
  { gid: "orchard-tree", mark: "point", role: "vegetation-deep", z: 10 },
  { gid: "farm-bank", mark: "line", role: "boundary", z: 6 },
];

/** Mountain. Bucket order matches `MOUNTAIN_TILE_GENERATOR_IDS`. The
 * `mountain-contour` bucket was RETIRED (Jonah 2026-07-15): iso-lines now trace
 * the composed campaign terrain field as a global surface painted by the
 * `terrain-contour` role, not a per-mountain-ring generated feature. */
export const MOUNTAIN_STYLE_CONTRACT: readonly BucketStyle[] = [
  { gid: "mountain-massif", mark: "fill", role: "relief", z: 1 },
  { gid: "mountain-hachure", mark: "line", role: "relief", z: 3 },
  { gid: "mountain-peak", mark: "point", role: "relief", z: 4 },
];

/** Every contract the paint builder composes, in generated-group source order
 * (world-tier first, then the region algorithms). The builder flattens these and
 * orders the resulting layers by each bucket's `z`. */
export const ALL_STYLE_CONTRACTS: readonly (readonly BucketStyle[])[] = [
  WORLD_STYLE_CONTRACT,
  MOUNTAIN_STYLE_CONTRACT,
  FARMLAND_STYLE_CONTRACT,
  CITY_STYLE_CONTRACT,
  RIVER_STYLE_CONTRACT,
  FOREST_STYLE_CONTRACT,
  PARK_STYLE_CONTRACT,
  WALL_STYLE_CONTRACT,
];

/** The gid list a contract binds — the value `tileGeneratorIds` derives from. */
export function contractGids(contract: readonly BucketStyle[]): readonly string[] {
  return contract.map((b) => b.gid);
}
