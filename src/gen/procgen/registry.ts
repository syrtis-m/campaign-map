/**
 * Procgen algorithm registry (plan 020 §5): the sketch-kind →
 * procgen-algorithm binding. A sketched district IS the request for city
 * procgen; future bindings (park → park-gen, forest/mountain polygons,
 * river-kind enrichment) slot in by adding a registry entry + params schema
 * + pure generator — zero new host lifecycle code. Host lifecycle code must
 * consult this registry only — never `if (kind === "district")`.
 *
 * Pure module: zod + pure generators only, no DOM/map/Obsidian imports.
 * Determinism: `generate` delegates to pure generators that read only their
 * arguments (D6); params are validated by each algorithm's own zod schema so
 * a malformed persisted `procgen.params` block fails loudly at the IO
 * boundary, never silently mid-pipeline.
 */
import { z } from "zod";
import type { FabricKind } from "../../model/fabric";
import type { GenerationConstraints } from "../types";
import type { ProcgenRegion } from "../region";
import type { Stage, ConstraintKind } from "./dag";
import { generateRiver, riverMaxOffset } from "../river";
import { generateForest, FOREST_VARIETIES } from "../forest";
import { generatePark, PARK_VARIETIES } from "../park";
import { generateWall, wallMaxOffset, WALL_STYLES } from "../wall";
import { generateFarmland, FARMLAND_TYPES, HEDGING_KINDS } from "../farmland";
import { generateMountain, MOUNTAIN_TERRAINS } from "../mountain";
import {
  DOMAIN_TILE_GENERATOR_IDS,
  generateCityNetwork,
  defaultProfileForTheme,
  type ProfileId,
} from "../citynet";

/**
 * A named "template" (plan 022 §1): a bundle of params the host offers as a
 * dropdown before the algorithm's per-param controls. Presets are pure sugar
 * over `params` — they are NEVER a runtime dependency (determinism: `params`
 * are the whole truth). The persisted procgen block stores `params` (+ an
 * OPTIONAL `presetId` for display only); a generator never reads `presetId`.
 */
export interface ProcgenPreset {
  id: string;
  label: string;
  params: Record<string, unknown>;
}

export interface ProcgenAlgorithm {
  id: string; // "city"
  label: string; // "City"
  appliesTo: readonly FabricKind[]; // ["district"]
  /** Plan 024 §2: the fixed stage this algorithm occupies in the cross-layer
   * regen cascade. An algorithm consumes only from STRICTLY LOWER stages, so
   * the global partial order `(stage, regionId)` is cycle-free by construction
   * and drives both replay and cascade order (see `dag.ts`). */
  stage: Stage;
  /** Plan 024 §3: the constraint FIELD(s) this algorithm's output supplies to
   * higher stages (river → `water`; forest/park → `vegetation`; mountain →
   * `elevation`; city → `settlement`; wall → `detail`). `[]` for a terminal
   * producer nothing downstream reads (e.g. farmland). */
  produces: readonly ConstraintKind[];
  /** Plan 024 §3: the constraint FIELD(s) this algorithm reads from lower
   * stages. Declares the DESIGN's intended coupling (river consumes
   * `elevation`; city consumes `water`+`vegetation`; wall consumes
   * `settlement`) — the DAG edge machinery keys on it; a declared-but-not-yet-
   * wired consumption merely triggers a byte-identical downstream recompute
   * (perf-only), so declaring intent here keeps 24-C purely about wiring
   * consumption, never re-touching the DAG. */
  consumes: readonly ConstraintKind[];
  paramsSchema: z.ZodType<Record<string, unknown>>;
  /** Named templates (plan 022 §1). Every algorithm has ≥1; the host renders
   * these as a dropdown, seeding the param controls from the chosen preset's
   * `params`. City's four profiles are its presets. */
  presets: readonly ProcgenPreset[];
  /** The preset id to pre-select for a fresh region in `themeId` (e.g.
   * parchment → euro-medieval). MUST be the id of a member of `presets`. */
  defaultPresetId(themeId: string): string;
  /** Theme-appropriate defaults for a fresh region (e.g. parchment →
   * euro-medieval), shown pre-filled in the host's params form. Derived from
   * the default preset so presets stay the single source of truth. */
  defaultParams(themeId: string): Record<string, unknown>;
  /** Per-tile generator ids this algorithm's network clips into — the host
   * uses these for cache keys and paint layers. */
  tileGeneratorIds: readonly string[];
  /** Plan 022 §2 (LINE-kind algorithms only): the corridor half-width, a PURE
   * function of the params — all output must sit within this distance of the
   * sketched spine. The host builds the spine corridor region from it (a
   * windiness increase widens the corridor, never violates it) and plan 024
   * reuses it as the cascade influence margin. Absent for polygon algorithms
   * (city), which are contained by their sketched ring instead. */
  corridorMaxOffset?(params: Record<string, unknown>): number;
  generate(
    seed: number,
    region: ProcgenRegion,
    params: Record<string, unknown>,
    constraints: GenerationConstraints
  ): GeoJSON.Feature[];
}

/** City params v1 (plan 020 §3.1): `{ profile }`. Room to grow — density,
 * wall override, etc. — behind the persisted `procgen.version`. */
export const CITY_PROFILE_IDS = [
  "euro-medieval",
  "euro-continental",
  "na-grid",
  "na-suburb",
  "superblock",
  "tartan-grid",
  "ward-grid",
  "eixample",
  "haussmann",
  "baroque-axial",
] as const satisfies readonly ProfileId[];

const cityParamsSchema = z.object({
  profile: z.enum(CITY_PROFILE_IDS),
  /** Optional GM-placed generation center (plan 020 Addendum 2), gen-space
   * meters, mm-quantized by the host. Present ⇒ the plaza + arterial star
   * anchor here instead of the computed `generationCenter(region)`, so a
   * boundary vertex edit leaves the skeleton in place and only the rim adapts.
   * Absent ⇒ automatic center (keeps migrated regions byte-stable). If a later
   * edit moves the boundary so this point falls outside the ring, generation
   * falls back to the automatic center deterministically. */
  center: z.tuple([z.number().finite(), z.number().finite()]).optional(),
});

/** City presets (plan 022 §1): the four profiles become templates of the
 * `city` algorithm. Preset id === profile id (they are 1:1 today); a preset's
 * `params` is exactly `{ profile }`. Future city knobs (density, wall
 * override) would join `params` here and default per preset — additive, so a
 * plugin update never re-rolls an existing region (§1 additive-params rule).
 * Labels are concise-but-descriptive and are the single source for both the
 * create modal and the selected-region panel. */
const CITY_PRESETS: readonly ProcgenPreset[] = [
  { id: "euro-medieval", label: "European medieval — organic warren, plaza, T-junctions", params: { profile: "euro-medieval" } },
  { id: "euro-continental", label: "European continental — regular blocks, wide angles", params: { profile: "euro-continental" } },
  { id: "na-grid", label: "North American grid — right angles, jogged grids", params: { profile: "na-grid" } },
  { id: "na-suburb", label: "North American suburb — curving streets, cul-de-sacs", params: { profile: "na-suburb" } },
  { id: "superblock", label: "Superblock — modernist megablocks, arterial canyons, dead-ends", params: { profile: "superblock" } },
  { id: "tartan-grid", label: "Tartan grid — coarse arterial grid, fine alley web (Seoul/Tokyo)", params: { profile: "tartan-grid" } },
  { id: "ward-grid", label: "Ward grid — walled modular quarters around squares (Savannah)", params: { profile: "ward-grid" } },
  { id: "eixample", label: "Eixample — uniform blocks, chamfered octagon corners (Barcelona)", params: { profile: "eixample" } },
  { id: "haussmann", label: "Haussmann — boulevards cut through a medieval warren, star plazas (Paris)", params: { profile: "haussmann" } },
  { id: "baroque-axial", label: "Baroque axial — a straight trident of grand corsi from a gate piazza (Rome/Turin)", params: { profile: "baroque-axial" } },
];

const cityAlgorithm: ProcgenAlgorithm = {
  id: "city",
  label: "City",
  appliesTo: ["district"],
  // Stage 3 (settlement): bridges over the meandered channel + a growth-cost
  // bump from canopy → consumes water + vegetation (plan 024 §3; the actual
  // channel/canopy consumption wires in 24-C with the windiness gate). Produces
  // `settlement` for the stage-4 wall elaboration (§7).
  stage: 3,
  produces: ["settlement"],
  consumes: ["water", "vegetation"],
  paramsSchema: cityParamsSchema as unknown as z.ZodType<Record<string, unknown>>,
  presets: CITY_PRESETS,
  defaultPresetId(themeId: string): string {
    // The theme→profile default IS a valid preset id (profile id === preset id).
    return defaultProfileForTheme(themeId);
  },
  defaultParams(themeId: string): Record<string, unknown> {
    const preset = presetById(this, this.defaultPresetId(themeId));
    // Every algorithm guarantees ≥1 preset and a valid defaultPresetId, so the
    // lookup is total; fall back to the profile shape to stay type-total.
    return preset ? { ...preset.params } : { profile: defaultProfileForTheme(themeId) };
  },
  tileGeneratorIds: DOMAIN_TILE_GENERATOR_IDS,
  generate(seed, region, params, constraints): GeoJSON.Feature[] {
    const { profile, center } = cityParamsSchema.parse(params);
    return generateCityNetwork(seed, region, profile, constraints, center);
  },
};

// ─── River (plan 022 §3.1) — the first LINE-kind algorithm ───────────────────

/** River params v1 (plan 022 §3.1). All knobs default to the prior/simplest
 * behavior (§1 additive-params rule): a plain straight uniform channel. */
const riverParamsSchema = z.object({
  windiness: z.number().min(0).max(1).default(0),
  braiding: z.number().min(0).max(1).default(0),
  width: z.number().positive().max(500).default(12),
  widthGrowth: z.number().min(0).max(4).default(0),
  braidBias: z.number().min(0).max(1).default(0),
  /** Box 23-E (plan 022 §3.1): terrain-slope coupling strength — steep ground
   * (from the sketched mountains' elevation field) straightens the meander.
   * ADDITIVE default 1 (coupling on): with no mountain sketch the output is
   * byte-identical for ANY value, so legacy no-mountain rivers are untouched;
   * a legacy river that DOES cross a sketched mountain adapts on its next
   * regenerate — the elevation field was already that river's declared input
   * (§3.1 "when plan 023 lands"), the same additive-output precedent as 23-C
   * contours appearing on existing mountains. Flagged in DECISIONS. */
  slopeSensitivity: z.number().min(0).max(1).default(1),
});

/** River presets (plan 022 §3.1) — the templates Jonah named. Params are the
 * whole truth; the "delta weights braiding toward the end" behavior is carried
 * by `braidBias`, never a preset-id branch. */
const RIVER_PRESETS: readonly ProcgenPreset[] = [
  {
    id: "lazy-lowland",
    label: "Lazy lowland — wide, windy, braided",
    params: { windiness: 0.85, braiding: 0.5, width: 26, widthGrowth: 0.7, braidBias: 0.2, slopeSensitivity: 1 },
  },
  {
    id: "mountain-torrent",
    label: "Mountain torrent — narrow, straight, rocky",
    params: { windiness: 0.15, braiding: 0, width: 8, widthGrowth: 0.2, braidBias: 0, slopeSensitivity: 1 },
  },
  {
    // slopeSensitivity 0: an engineered canal ignores terrain by definition.
    id: "canal",
    label: "Canal — dead straight, uniform width",
    params: { windiness: 0, braiding: 0, width: 12, widthGrowth: 0, braidBias: 0, slopeSensitivity: 0 },
  },
  {
    id: "delta",
    label: "Delta — heavy braiding near the mouth",
    params: { windiness: 0.5, braiding: 1, width: 22, widthGrowth: 1.2, braidBias: 1, slopeSensitivity: 1 },
  },
];

/** River tile-generator ids = the emitted feature buckets (plan 022 §3.1 +
 * plan 028 §1.1): channel water + bank casing lines + island land. Cache keys
 * + paint layers key on these. */
export const RIVER_TILE_GENERATOR_IDS: readonly string[] = [
  "river-channel",
  "river-bank",
  "river-island",
  "river-confluence",
  "river-distributary",
  "river-estuary",
  "river-oxbow",
  "river-point-bar",
  "river-glyph",
];

const riverAlgorithm: ProcgenAlgorithm = {
  id: "river",
  label: "River",
  appliesTo: ["river"],
  // Stage 1 (hydrology): reads the sketched mountains' `elevation` field
  // (slope straightens the meander — box 23-E, already wired); produces the
  // `water` channel the city/forest read.
  stage: 1,
  produces: ["water"],
  consumes: ["elevation"],
  paramsSchema: riverParamsSchema as unknown as z.ZodType<Record<string, unknown>>,
  presets: RIVER_PRESETS,
  defaultPresetId(themeId: string): string {
    // Parchment/ink-soot fantasy reads best as a lazy lowland river; the clean
    // modern/neon themes default to a canal (their palette suits engineered
    // water). Every returned id is a member of RIVER_PRESETS.
    return themeId === "modern-clean" || themeId === "neon-sprawl" ? "canal" : "lazy-lowland";
  },
  defaultParams(themeId: string): Record<string, unknown> {
    const preset = presetById(this, this.defaultPresetId(themeId));
    return preset ? { ...preset.params } : { ...RIVER_PRESETS[0].params };
  },
  tileGeneratorIds: RIVER_TILE_GENERATOR_IDS,
  corridorMaxOffset(params: Record<string, unknown>): number {
    return riverMaxOffset(riverParamsSchema.parse(params));
  },
  generate(seed, region, params, constraints): GeoJSON.Feature[] {
    return generateRiver(seed, region, riverParamsSchema.parse(params), constraints);
  },
};

// ─── Forest (plan 022 §3.2) — masked-noise polygon canopy ────────────────────

/** Forest params v1 (plan 022 §3.2). All knobs have sensible defaults so a bare
 * `{}` validates to a reasonable mixed woodland (additive-params rule §1: a
 * later knob must default to prior behavior; v1 ships all three at once). */
const forestParamsSchema = z.object({
  variety: z.enum(FOREST_VARIETIES).default("mixed"),
  density: z.number().min(0).max(1).default(0.6),
  clearings: z.number().min(0).max(1).default(0.15),
  edgeRaggedness: z.number().min(0).max(1).default(0.5),
});

/** Forest presets (plan 022 §3.2) — the templates Jonah named. Params are the
 * whole truth; `variety` is carried onto features for theme tinting, never a
 * runtime branch in the generator. */
const FOREST_PRESETS: readonly ProcgenPreset[] = [
  { id: "broadleaf", label: "Broadleaf — dense deciduous wood", params: { variety: "broadleaf", density: 0.7, clearings: 0.12, edgeRaggedness: 0.45 } },
  { id: "conifer", label: "Conifer — dark evergreen forest", params: { variety: "conifer", density: 0.8, clearings: 0.08, edgeRaggedness: 0.3 } },
  { id: "mixed", label: "Mixed woodland — varied cover, glades", params: { variety: "mixed", density: 0.6, clearings: 0.18, edgeRaggedness: 0.5 } },
  { id: "swamp", label: "Swamp — patchy wetland trees", params: { variety: "swamp", density: 0.5, clearings: 0.3, edgeRaggedness: 0.65 } },
  { id: "dead-wood", label: "Dead-wood — sparse, ragged, many clearings", params: { variety: "dead-wood", density: 0.35, clearings: 0.35, edgeRaggedness: 0.7 } },
];

/** Forest tile-generator ids = the emitted feature buckets. Plan 026-B: the
 * canopy is ONE `forest-canopy` MultiPolygon (clearings are interior HOLES, no
 * `forest-clearing` features any more) plus its `forest-canopy-rim` outline
 * LineStrings and the `forest-tree` stipple. `forest-clearing` is retained in
 * the list so pre-026-B caches still surface their clearing cells (cache keys +
 * paint layers key on these ids; an uncached gid is silently dropped). */
export const FOREST_TILE_GENERATOR_IDS: readonly string[] = [
  "forest-canopy",
  "forest-canopy-rim",
  "forest-clearing",
  "forest-tree",
];

const forestAlgorithm: ProcgenAlgorithm = {
  id: "forest",
  label: "Forest",
  appliesTo: ["forest"],
  // Stage 2 (vegetation): no canopy in the river → consumes `water` (plan 024
  // §3; consumption wires in 24-C). Produces `vegetation` for the city's
  // growth-cost bump. NEVER consumes `settlement` — the reverse (city clips
  // canopy) is rejected outright (§3, it breaks cycle-freedom); the town reads
  // as a clearing because city fabric paints above canopy within layer 1.
  stage: 2,
  produces: ["vegetation"],
  consumes: ["water"],
  paramsSchema: forestParamsSchema as unknown as z.ZodType<Record<string, unknown>>,
  presets: FOREST_PRESETS,
  defaultPresetId(themeId: string): string {
    // Fantasy parchment/ink-soot read best as a broadleaf wood; the clean
    // modern/neon themes default to mixed. Every returned id is a preset member.
    return themeId === "modern-clean" || themeId === "neon-sprawl" ? "mixed" : "broadleaf";
  },
  defaultParams(themeId: string): Record<string, unknown> {
    const preset = presetById(this, this.defaultPresetId(themeId));
    return preset ? { ...preset.params } : { ...FOREST_PRESETS[2].params };
  },
  tileGeneratorIds: FOREST_TILE_GENERATOR_IDS,
  generate(seed, region, params, constraints): GeoJSON.Feature[] {
    return generateForest(seed, region, forestParamsSchema.parse(params), constraints);
  },
};

// ─── Park (plan 022 §3.3) — the second consumer of the ground-cell + harmonic
// blob primitives; wires up the previously-inert `park` polygon kind ──────────

/** Park params v1 (plan 022 §3.3). All knobs have defaults so a bare `{}`
 * validates to a reasonable city park (additive-params rule §1). `variety`
 * drives layout (like the city algorithm's `profile`), never a preset-id
 * branch; `pond` is a bool, `pathDensity` 0–1. */
const parkParamsSchema = z.object({
  variety: z.enum(PARK_VARIETIES).default("city-park"),
  pathDensity: z.number().min(0).max(1).default(0.5),
  pond: z.boolean().default(false),
});

/** Park presets (plan 022 §3.3) — the four templates. Params are the whole
 * truth; `japanese-garden` forces `pond: true` (its composition anchor). */
const PARK_PRESETS: readonly ProcgenPreset[] = [
  { id: "formal-garden", label: "Formal garden — axial paths, symmetric beds", params: { variety: "formal-garden", pathDensity: 0.6, pond: false } },
  { id: "city-park", label: "City park — curved paths, lawns, a pond", params: { variety: "city-park", pathDensity: 0.5, pond: true } },
  { id: "wild-common", label: "Wild common — sparse paths, scattered trees", params: { variety: "wild-common", pathDensity: 0.3, pond: false } },
  { id: "japanese-garden", label: "Japanese garden — winding circuit, pond, island, rocks", params: { variety: "japanese-garden", pathDensity: 0.4, pond: true } },
];

/** Park tile-generator ids = the emitted feature buckets (plan 022 §3.3):
 * ground fabric + path web + water (pond/island/bridge) + gravel court + rock +
 * tree points. Cache keys + paint layers key on these. */
export const PARK_TILE_GENERATOR_IDS: readonly string[] = [
  "park-lawn",
  "park-canopy",
  "park-bed",
  "park-path",
  "park-pond",
  "park-island",
  "park-bridge",
  "park-court",
  "park-rock",
  "park-tree",
  "park-point",
  "park-canopy-rim",
  "park-pond-shore",
  "park-court-rake",
];

const parkAlgorithm: ProcgenAlgorithm = {
  id: "park",
  label: "Park",
  appliesTo: ["park"],
  // Stage 2 (vegetation), same band as forest: a park pond sits away from a
  // river channel → consumes `water`; produces `vegetation`.
  stage: 2,
  produces: ["vegetation"],
  consumes: ["water"],
  paramsSchema: parkParamsSchema as unknown as z.ZodType<Record<string, unknown>>,
  presets: PARK_PRESETS,
  defaultPresetId(themeId: string): string {
    // Fantasy parchment/ink-soot read best as a formal garden; the clean
    // modern/neon themes default to a city park. Every returned id is a member.
    return themeId === "modern-clean" || themeId === "neon-sprawl" ? "city-park" : "formal-garden";
  },
  defaultParams(themeId: string): Record<string, unknown> {
    const preset = presetById(this, this.defaultPresetId(themeId));
    return preset ? { ...preset.params } : { ...PARK_PRESETS[1].params };
  },
  tileGeneratorIds: PARK_TILE_GENERATOR_IDS,
  generate(seed, region, params, constraints): GeoJSON.Feature[] {
    return generatePark(seed, region, parkParamsSchema.parse(params), constraints);
  },
};

// ─── Wall (plan 022 §3.4) — the second LINE-kind algorithm (after river) ─────

/** Wall params v1 (plan 022 §3.4). All knobs have defaults so a bare `{}`
 * validates to a plain curtain wall (additive-params rule §1). `style` drives
 * layout (like the city `profile` / park `variety`), never a preset-id branch. */
const wallParamsSchema = z.object({
  style: z.enum(WALL_STYLES).default("curtain-wall"),
  towerSpacing: z.number().min(15).max(400).default(60),
  moat: z.boolean().default(false),
  gatehouseScale: z.number().min(0.2).max(3).default(1),
});

/** Wall presets (plan 022 §3.4) — the three templates Jonah named. Params are
 * the whole truth; `palisade` carries `towerSpacing` too (harmless — the
 * generator emits no towers for a palisade), so switching style keeps the knob. */
const WALL_PRESETS: readonly ProcgenPreset[] = [
  { id: "curtain-wall", label: "Curtain wall — stone, regular towers", params: { style: "curtain-wall", towerSpacing: 60, moat: false, gatehouseScale: 1 } },
  { id: "palisade", label: "Palisade — timber stockade, no towers", params: { style: "palisade", towerSpacing: 60, moat: false, gatehouseScale: 0.8 } },
  { id: "bastioned", label: "Bastioned — angular star-fort trace, moat", params: { style: "bastioned", towerSpacing: 90, moat: true, gatehouseScale: 1.4 } },
];

/** Wall tile-generator ids = the emitted feature buckets (plan 022 §3.4): the
 * outboard moat, the masonry band, the towers, and the gate markers. Cache keys
 * + paint layers key on these. */
export const WALL_TILE_GENERATOR_IDS: readonly string[] = ["wall-moat", "wall-quad", "wall-tower", "wall-gate"];

const wallAlgorithm: ProcgenAlgorithm = {
  id: "wall",
  label: "Wall",
  appliesTo: ["wall"],
  // Stage 4 (detail): the procgen wall ELABORATION (towers/gates/moat) consumes
  // stage-3 `settlement` (plan 024 §7 resolution; consumption wires later). The
  // raw wall SKETCH stays a stage-agnostic constraint every stage reads
  // (`fabricConstraints.wallLines`) — that is unchanged and orthogonal to this
  // stage. The cascade never carries stage-4 output downward (produces `detail`,
  // which nothing consumes).
  stage: 4,
  produces: ["detail"],
  consumes: ["settlement"],
  paramsSchema: wallParamsSchema as unknown as z.ZodType<Record<string, unknown>>,
  presets: WALL_PRESETS,
  defaultPresetId(themeId: string): string {
    // Fantasy parchment/ink-soot read best as a stone curtain wall; the clean
    // modern/neon themes default to a bastioned trace (its angular geometry
    // suits their palette). Every returned id is a member of WALL_PRESETS.
    return themeId === "modern-clean" || themeId === "neon-sprawl" ? "bastioned" : "curtain-wall";
  },
  defaultParams(themeId: string): Record<string, unknown> {
    const preset = presetById(this, this.defaultPresetId(themeId));
    return preset ? { ...preset.params } : { ...WALL_PRESETS[0].params };
  },
  tileGeneratorIds: WALL_TILE_GENERATOR_IDS,
  corridorMaxOffset(params: Record<string, unknown>): number {
    return wallMaxOffset(wallParamsSchema.parse(params));
  },
  generate(seed, region, params, constraints): GeoJSON.Feature[] {
    return generateWall(seed, region, wallParamsSchema.parse(params), constraints);
  },
};

// ─── Farmland (plan 022 §3.5) — the new agriculture polygon kind ─────────────

/** Farmland params v1 (plan 022 §3.5). All knobs have defaults so a bare `{}`
 * validates to a reasonable patchwork (additive-params rule §1). `fieldType`
 * drives layout (like the city `profile` / park `variety`), never a preset-id
 * branch. `paddy-terraces` is intentionally absent (deferred to plan 023). */
const farmlandParamsSchema = z.object({
  fieldType: z.enum(FARMLAND_TYPES).default("enclosed-patchwork"),
  fieldSize: z.number().min(0).max(1).default(0.5),
  hedging: z.enum(HEDGING_KINDS).default("hedgerows"),
  laneDensity: z.number().min(0).max(1).default(0.5),
  farmsteads: z.number().min(0).max(1).default(0.4),
});

/** Farmland presets (plan 022 §3.5) — the five templates. `paddy-terraces`
 * landed in box 23-E (the plan-023 field-coupled variant: contour-following
 * banks over the sketched mountains' elevation field, concentric fallback on
 * flat ground). Params are the whole truth; `fieldType` is carried onto
 * features for theme tinting, never a runtime preset-id branch. */
const FARMLAND_PRESETS: readonly ProcgenPreset[] = [
  { id: "open-field-strips", label: "Open-field strips — medieval furlongs off lanes", params: { fieldType: "open-field-strips", fieldSize: 0.55, hedging: "none", laneDensity: 0.66, farmsteads: 0.3 } },
  { id: "enclosed-patchwork", label: "Enclosed patchwork — irregular hedged fields", params: { fieldType: "enclosed-patchwork", fieldSize: 0.5, hedging: "hedgerows", laneDensity: 0.4, farmsteads: 0.45 } },
  { id: "grid-quarters", label: "Grid quarters — rectilinear sections + section roads", params: { fieldType: "grid-quarters", fieldSize: 0.7, hedging: "fences", laneDensity: 0.66, farmsteads: 0.35 } },
  { id: "orchard", label: "Orchard — regular tree rows", params: { fieldType: "orchard", fieldSize: 0.4, hedging: "hedgerows", laneDensity: 0.5, farmsteads: 0.3 } },
  { id: "paddy-terraces", label: "Paddy terraces — contour-following banks", params: { fieldType: "paddy-terraces", fieldSize: 0.35, hedging: "none", laneDensity: 0.4, farmsteads: 0.25 } },
];

/** Farmland tile-generator ids = the emitted feature buckets (plan 022 §3.5 +
 * box 23-E): tilled fields, the lane web, field-edge hedges/fences, farmstead
 * footprints, orchard tree points, and paddy terrace bank lines. Cache keys +
 * paint layers key on these. (`farm-bank` appended — ADDITIVE: a pre-23-E
 * cached farmland tile just misses the new bucket, so its next read re-clips
 * the cached network; the pre-existing gids' bytes are unchanged, the 23-C
 * mountain-contour precedent.) */
export const FARMLAND_TILE_GENERATOR_IDS: readonly string[] = [
  "farm-field",
  "farm-lane",
  "farm-hedge",
  "farm-building",
  "orchard-tree",
  "farm-bank",
];

const farmlandAlgorithm: ProcgenAlgorithm = {
  id: "farmland",
  label: "Farmland",
  appliesTo: ["farmland"],
  // Stage 2 (grouped with vegetation): paddy-terraces follow the sketched
  // mountains' `elevation` contours (box 23-E, already wired) → consumes
  // `elevation`. Produces NOTHING downstream — the city reads a raw farmland
  // SKETCH (`fabricConstraints.farmlandRings`) to suppress its outskirts, not
  // farmland's generated OUTPUT, so there is no farmland → city output edge.
  stage: 2,
  produces: [],
  consumes: ["elevation"],
  paramsSchema: farmlandParamsSchema as unknown as z.ZodType<Record<string, unknown>>,
  presets: FARMLAND_PRESETS,
  defaultPresetId(themeId: string): string {
    // Fantasy parchment/ink-soot read best as open medieval strips or hedged
    // patchwork; the clean modern/na themes default to grid quarters (their
    // rectilinear sections suit the palette). Every returned id is a member.
    return themeId === "modern-clean" || themeId === "neon-sprawl" ? "grid-quarters" : "enclosed-patchwork";
  },
  defaultParams(themeId: string): Record<string, unknown> {
    const preset = presetById(this, this.defaultPresetId(themeId));
    return preset ? { ...preset.params } : { ...FARMLAND_PRESETS[1].params };
  },
  tileGeneratorIds: FARMLAND_TILE_GENERATOR_IDS,
  generate(seed, region, params, constraints): GeoJSON.Feature[] {
    return generateFarmland(seed, region, farmlandParamsSchema.parse(params), constraints);
  },
};

// ─── Mountain (plan 023 §3) — the relief polygon kind, first consumer of the
// elevation field (fields/elevation.ts) ──────────────────────────────────────

/** Mountain params v1 (plan 023 §3). All knobs have defaults so a bare `{}`
 * validates to a reasonable alpine massif (additive-params rule §1). `terrain`
 * drives layout (like the city `profile` / park `variety`), never a preset-id
 * branch. `paddy-terraces` (farmland box, deferred) is unrelated. */
const mountainParamsSchema = z.object({
  terrain: z.enum(MOUNTAIN_TERRAINS).default("alpine"),
  amplitude: z.number().min(0).max(1).default(0.6),
  roughness: z.number().min(0).max(1).default(0.5),
});

/** Mountain presets (plan 023 §3) — the three templates Jonah named. Params are
 * the whole truth; `terrain` is carried onto features for theme tinting, never
 * a runtime preset-id branch. */
const MOUNTAIN_PRESETS: readonly ProcgenPreset[] = [
  { id: "alpine", label: "Alpine — high ridged peaks, steep relief", params: { terrain: "alpine", amplitude: 0.85, roughness: 0.6 } },
  { id: "mesa", label: "Mesa — terraced tablelands, cliff risers", params: { terrain: "mesa", amplitude: 0.55, roughness: 0.4 } },
  { id: "rolling-hills", label: "Rolling hills — gentle rounded uplands", params: { terrain: "rolling-hills", amplitude: 0.3, roughness: 0.35 } },
];

/** Mountain tile-generator ids = the emitted feature buckets (plan 023 §3 +
 * §4.1): the rocky-ground massif, the downslope relief hachures, the summit
 * peaks, and the topographic contour iso-lines (23-C). Cache keys + paint
 * layers key on these — EVERY emitted gid MUST appear here or the tile clip
 * silently drops it (the twice-hit integration bug). */
export const MOUNTAIN_TILE_GENERATOR_IDS: readonly string[] = [
  "mountain-massif",
  "mountain-hachure",
  "mountain-peak",
  "mountain-contour",
];

const mountainAlgorithm: ProcgenAlgorithm = {
  id: "mountain",
  label: "Mountain",
  appliesTo: ["mountain"],
  // Stage 0 (elevation): the base FIELD. Produces `elevation` (the river's
  // slope coupling + farmland's paddy terraces read it via the sketch-derived
  // `elevationFieldFromFabric`, box 23-E). Consumes nothing.
  stage: 0,
  produces: ["elevation"],
  consumes: [],
  paramsSchema: mountainParamsSchema as unknown as z.ZodType<Record<string, unknown>>,
  presets: MOUNTAIN_PRESETS,
  defaultPresetId(themeId: string): string {
    // Fantasy parchment/ink-soot read best as dramatic alpine relief; the clean
    // modern/neon themes default to rolling hills (their flatter palette suits
    // gentle uplands). Every returned id is a member of MOUNTAIN_PRESETS.
    return themeId === "modern-clean" || themeId === "neon-sprawl" ? "rolling-hills" : "alpine";
  },
  defaultParams(themeId: string): Record<string, unknown> {
    const preset = presetById(this, this.defaultPresetId(themeId));
    return preset ? { ...preset.params } : { ...MOUNTAIN_PRESETS[0].params };
  },
  tileGeneratorIds: MOUNTAIN_TILE_GENERATOR_IDS,
  generate(seed, region, params, constraints): GeoJSON.Feature[] {
    return generateMountain(seed, region, mountainParamsSchema.parse(params), constraints);
  },
};

/** v1 registers `city` + `forest` + `park` + `farmland` + `mountain` (polygon) +
 * `river` + `wall` (line). Order matters for `algorithmForKind` (first match
 * wins) — keep the list explicit and small. */
const REGISTRY: readonly ProcgenAlgorithm[] = [
  cityAlgorithm,
  riverAlgorithm,
  forestAlgorithm,
  parkAlgorithm,
  wallAlgorithm,
  farmlandAlgorithm,
  mountainAlgorithm,
];

export function algorithmForKind(kind: FabricKind): ProcgenAlgorithm | undefined {
  return REGISTRY.find((a) => a.appliesTo.includes(kind));
}

export function algorithmById(id: string): ProcgenAlgorithm | undefined {
  return REGISTRY.find((a) => a.id === id);
}

// ─── Preset helpers (plan 022 §1) — pure, host-agnostic ──────────────────────
// Presets are sugar over params; these functions are the ONLY sanctioned way to
// go preset⇆params, and they never touch a persisted block or a generator.

export function presetById(algorithm: ProcgenAlgorithm, presetId: string): ProcgenPreset | undefined {
  return algorithm.presets.find((p) => p.id === presetId);
}

/** True iff every key the preset defines deep-equals the same key in `params`.
 * Params MAY carry orthogonal keys the preset does not define (e.g. the city's
 * `center` placement) — those never affect the match, so a GM who dragged the
 * plaza handle still reads as "on template". Value compare is structural via
 * JSON (params are plain JSON: enums, numbers, bools, tuples). */
function presetParamsMatch(presetParams: Record<string, unknown>, params: Record<string, unknown>): boolean {
  for (const key of Object.keys(presetParams)) {
    if (JSON.stringify(presetParams[key]) !== JSON.stringify(params[key])) return false;
  }
  return true;
}

/** The id of the preset whose params `params` currently matches, or undefined
 * when the params have been customised away from every preset ("Custom"). The
 * host renders the dropdown from this: a hit selects that template; a miss
 * shows "Custom (from …)". Pure — safe to call on every render; it derives the
 * display and MUST NOT be persisted back onto the block. */
export function matchingPresetId(
  algorithm: ProcgenAlgorithm,
  params: Record<string, unknown>
): string | undefined {
  return algorithm.presets.find((p) => presetParamsMatch(p.params, params))?.id;
}
