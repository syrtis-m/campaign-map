/**
 * Procgen algorithm registry: the sketch-kind → procgen-algorithm binding.
 * A sketched district IS the request for city
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
import {
  contractGids,
  RIVER_STYLE_CONTRACT,
  FOREST_STYLE_CONTRACT,
  PARK_STYLE_CONTRACT,
  WALL_STYLE_CONTRACT,
  FARMLAND_STYLE_CONTRACT,
  MOUNTAIN_STYLE_CONTRACT,
} from "./styleContract";
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
  RELIEF_POLARITIES,
  LANDFORM_MODES,
  RELIEF_DEFAULTS,
  LANDFORM_DEFAULTS,
  reliefMaxOffset,
  type ReliefParams,
} from "../fields/terrain";
import {
  DOMAIN_TILE_GENERATOR_IDS,
  generateCityNetwork,
  defaultProfileForTheme,
  type ProfileId,
} from "../citynet";

/**
 * A named "template": a bundle of params the host offers as a
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

/** Rough regeneration cost band for an algorithm's generator — declared here,
 * CONSUMED by plan 034's cost-weighted cascade cap (a continental river must
 * not silently redraw 100 expensive cities). Nothing keys on it in plan 033.
 * cheap: field noise / stipple (mountain, forest); medium: corridor + snap or a
 * single field pass (river, park, wall, farmland); expensive: the full city
 * street/block/parcel pipeline. */
export type CostClass = "cheap" | "medium" | "expensive";

/** A region's resolved position in the stage DAG: its stage band + the
 * currencies it produces/consumes (plan 035). Usually the algorithm's static
 * fields; params-dependent for algorithms implementing `dagRole` (park). */
export interface DagRole {
  stage: Stage;
  produces: readonly ConstraintKind[];
  consumes: readonly ConstraintKind[];
}

export interface ProcgenAlgorithm {
  id: string; // "city"
  label: string; // "City"
  /** Generator contract version: params semantics + output bytes, one number.
   * Any change that alters output bytes for the same `(seed, params)` MUST
   * bump this (and then needs no byte-neutrality argument).
   * Host-side routing data only: written into new procgen blocks at creation,
   * compared at edit time to drive the adoption prompt. NEVER a generator
   * input — a generator never branches on version; the code IS the version. */
  currentVersion: number;
  /** Adoption-time params migration: maps params persisted under `oldVersion`
   * to the current shape. Pure; identity when a bump changed no param
   * semantics (then omit it). Called only by the host's adoption flow, never
   * during generation. */
  migrateParams?(oldVersion: number, params: Record<string, unknown>): Record<string, unknown>;
  appliesTo: readonly FabricKind[]; // ["district"]
  /** The fixed stage this algorithm occupies in the cross-layer regen cascade.
   * An algorithm consumes only from STRICTLY LOWER stages, so the global partial
   * order `(stage, regionId)` is cycle-free by construction and drives both
   * replay and cascade order (see `dag.ts`). */
  stage: Stage;
  /** The constraint FIELD(s) this algorithm's output supplies to higher stages
   * (river → `water`; forest/park → `vegetation`; mountain → `elevation`; city
   * → `settlement`; wall → `detail`). `[]` for a terminal producer nothing
   * downstream reads (e.g. farmland). */
  produces: readonly ConstraintKind[];
  /** The constraint FIELD(s) this algorithm reads from lower stages. Declares
   * the DESIGN's intended coupling (river consumes `elevation`; city consumes
   * `water`+`vegetation`; wall consumes `settlement`) — the DAG edge machinery
   * keys on it; a declared-but-not-yet-wired consumption merely triggers a
   * downstream recompute with unchanged output (perf-only), so declaring intent
   * here never re-touches the DAG. */
  consumes: readonly ConstraintKind[];
  /** The raw sketch KINDS this algorithm's generator actually reads as
   * constraints (plan 033-C). Distinct from `consumes` (which is about upstream
   * GENERATED constraint FIELDS / DAG output coupling): this is the raw
   * `Fabric.geojson` sketch geometry the generator folds in directly (city reads
   * water/river/road/wall/farmland; river reads water/river + the sketched
   * mountains' elevation field; park/wall read road; farmland reads mountain;
   * forest/mountain read nothing). VERIFIED — not intended — by the 033-A
   * under-invalidation harness (`underInvalidation.fuzz.test.ts`), which proves
   * that a sketch of any OTHER kind, or of a declared kind beyond
   * `influenceMargin`, is byte-inert. The scoped invalidation walk + scoped
   * fingerprints (033-C/033-D) key on this, so an under-declaration silently
   * serves stale bytes — hence the permanent fuzz-tier gate. */
  consumesSketch: readonly FabricKind[];
  /** How far (meters, bbox-to-bbox) a `consumesSketch` feature can influence
   * this algorithm's output (plan 033-C). A sketch edit of a consumed kind
   * invalidates a region only when its bbox comes within this margin; beyond it
   * the harness proves byte-inertness. MEASURED from the code's own constants
   * (city 1500: the road tensor blend has no distance cutoff and still steers
   * streets at ~1 km; river 30: CONFLUENCE_SNAP_M; park 30: ROAD_ENTRANCE_THRESH_M;
   * wall/farmland 0: exact segment-crossing / compact-support field reads). 0
   * for the no-consumption algorithms. */
  influenceMargin: number;
  /** Regeneration cost band (plan 033-C) — routing data for plan 034's cascade
   * cap; NEVER a generator input. */
  costClass: CostClass;
  /** Params-dependent DAG role (plan 035, park split): an algorithm whose
   * stage/currencies depend on a PARAM (park's `urban-park` variety sits at
   * stage 4 consuming `settlement` while its rural varieties stay stage 2
   * producing `vegetation`) implements this; hosts resolve every region's
   * DagNode through `dagRoleFor` (below), which falls back to the static
   * `stage`/`produces`/`consumes` fields when absent. MUST be a pure total
   * function of the params (it feeds cascade order — determinism), MUST parse
   * defensively (persisted params can be malformed ⇒ return the static role,
   * never throw), and MUST NOT vary `consumesSketch`/`influenceMargin` (the
   * 033 harness verifies those per-ALGORITHM with the most-consuming params). */
  dagRole?(params: Record<string, unknown>): DagRole;
  paramsSchema: z.ZodType<Record<string, unknown>>;
  /** Named templates. Every algorithm has ≥1; the host renders
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
  /** LINE-kind algorithms only: the corridor half-width, a PURE function of the
   * params — all output must sit within this distance of the sketched spine.
   * The host builds the spine corridor region from it (a windiness increase
   * widens the corridor, never violates it) and the cascade reuses it as the
   * influence margin. Absent for polygon algorithms (city), which are contained
   * by their sketched ring instead. */
  corridorMaxOffset?(params: Record<string, unknown>): number;
  generate(
    seed: number,
    region: ProcgenRegion,
    params: Record<string, unknown>,
    constraints: GenerationConstraints
  ): GeoJSON.Feature[];
}

/** City params: `{ profile }`. Room to grow — density, wall override, etc. —
 * behind the persisted `procgen.version`. */
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
  "canal-rings",
  "radial-star",
] as const satisfies readonly ProfileId[];

const cityParamsSchema = z.object({
  profile: z.enum(CITY_PROFILE_IDS).describe("Street-network style: which real-world city pattern the streets, blocks and plaza follow."),
  /** na-grid: promote the quadrant-collision seam into ONE wide diagonal
   * boulevard (Market Street). DEFAULT off. Read only by the `city` generator. */
  seamBoulevard: z
    .boolean()
    .optional()
    .describe("Grid profile only: turn the seam where the two street grids collide into one wide diagonal boulevard."),
  /** euro-medieval: number of successive walls/ring-roads — 1 (default) or 2 (a
   * second, older inner ring, the Paris Châtelet reading). */
  growthRings: z
    .union([z.literal(1), z.literal(2)])
    .optional()
    .describe("Medieval profile only: how many wall/ring-road rings the town grew through \u2014 2 adds an older inner ring."),
  /** Optional GM-placed generation center, gen-space meters, mm-quantized by the
   * host. Present ⇒ the plaza + arterial star anchor here instead of the computed
   * `generationCenter(region)`, so a boundary vertex edit leaves the skeleton in
   * place and only the rim adapts. Absent ⇒ automatic center. If a later edit
   * moves the boundary so this point falls outside the ring, generation falls
   * back to the automatic center deterministically. */
  center: z
    .tuple([z.number().finite(), z.number().finite()])
    .optional()
    .describe("GM-placed generation center (drag the \u25c6 handle on the map): the plaza and main streets anchor here."),
  /** City-site grading (plan 036-D, ratified DEFAULT OFF): level the district
   * interior toward the elevation at `center`, fading to natural ground at the
   * rim. Read ONLY by `terrainAt` (the contour/DEM surface) — the `city`
   * generator's street/block output ignores it, so an ABSENT `grade` reproduces
   * pre-036 bytes exactly and no version bump is needed (param-over-bump). */
  grade: z
    .boolean()
    .optional()
    .describe("Level the terrain under the district toward the center\u2019s elevation, fading back to natural ground at the edge (affects contours and 3D only)."),
  /** Grading falloff band (meters) inside the ring; absent ⇒ default. */
  gradeBand: z
    .number()
    .positive()
    .max(20000)
    .optional()
    .describe("How far inside the boundary (meters) the terrain leveling fades back to natural ground."),
});

/** City presets: each profile becomes a template of the `city` algorithm.
 * Preset id === profile id (they are 1:1 today); a preset's `params` is exactly
 * `{ profile }`. Future city knobs (density, wall override) would join `params`
 * here and default per preset. Labels are concise-but-descriptive and are the
 * single source for both the create modal and the selected-region panel. */
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
  { id: "canal-rings", label: "Canal rings — concentric canals crossed by radial bridges (Amsterdam)", params: { profile: "canal-rings" } },
  { id: "radial-star", label: "Radial star — avenues from a rond-point, concentric connector rings (Paris Étoile)", params: { profile: "radial-star" } },
];

const cityAlgorithm: ProcgenAlgorithm = {
  id: "city",
  label: "City",
  // Version 2 (plan 037): the declared `vegetation` consumption is WIRED — the
  // generated canopy attenuates cityness (streets thin in the woods) and rejects
  // parcels/footprints deep in the canopy (item 3); the outer city treats any
  // strictly-CONTAINED park/district sketch ring as a hole with a perimeter
  // frontage street + hashed entrances (item 5, `consumesSketch` park/district
  // added there). A city with NO upstream vegetation AND no contained region is
  // byte-identical to v1 (golden unchanged); either coupling present changes
  // bytes ⇒ the bump gates adoption.
  // Version 3 (plans 038 + 039 §1.1, coupling wave 2): (038.1) bank-tangent
  // street alignment + building-only setback near the generated river channel;
  // (038.5) an in-region sketched road forces a gate where it crosses the wall
  // inset ring (the frontage/ribbon-lot promotion is DEFERRED — see plans/038);
  // (038.6) adjacent districts sharing a ring edge derive bit-matching arterial
  // stubs/gates by hashing the shared edge (never reading the neighbor's
  // output); (039 §1.1) a typed `market` canon pin anchors the plaza + arterial
  // star. Each coupling is a no-op when its trigger is absent, so a city with no
  // channel / no in-region road crossing a wall / no adjacent district / no
  // market pin is byte-identical to v2; any trigger present changes bytes ⇒ the
  // bump gates adoption.
  currentVersion: 3,
  appliesTo: ["district"],
  // Stage 3 (settlement): bridges over the meandered channel + a growth-cost
  // bump from canopy → consumes water + vegetation. Produces `settlement` for
  // the stage-4 wall elaboration.
  stage: 3,
  produces: ["settlement"],
  consumes: ["water", "vegetation"],
  // Raw sketch reads: water/river (channel banks, bridges), road (street tensor
  // alignment — no distance cutoff, hence the 1500 m margin), wall (street
  // truncation, double-wall suppression), farmland (outskirt-field suppression),
  // and (plan 037 item 5) park/district — a strictly-CONTAINED region's ring
  // becomes a hole (perimeter frontage + hashed entrances). Containment gap is 0,
  // so the existing 1500 m margin covers it; an adjacent/overlapping (non-
  // contained) park/district is byte-inert (033-A harness verifies).
  consumesSketch: ["water", "river", "road", "wall", "farmland", "park", "district"],
  influenceMargin: 1500,
  costClass: "expensive",
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
    const { profile, center, seamBoulevard, growthRings } = cityParamsSchema.parse(params);
    const overrides =
      seamBoulevard !== undefined || growthRings !== undefined ? { seamBoulevard, growthRings } : undefined;
    return generateCityNetwork(seed, region, profile, constraints, center, overrides);
  },
};

// ─── River — the first LINE-kind algorithm ───────────────────────────────────

/** River params. All knobs default to the simplest behavior: a plain straight
 * uniform channel. */
const riverParamsSchema = z.object({
  windiness: z.number().min(0).max(1).default(0).describe("0\u20131: how strongly the channel meanders side to side from the sketched line."),
  braiding: z.number().min(0).max(1).default(0).describe("0\u20131: how often the channel splits into parallel strands around islands."),
  width: z.number().positive().max(500).default(12).describe("Base channel width in meters (also sets how deep the default carve cuts)."),
  widthGrowth: z.number().min(0).max(4).default(0).describe("How much the channel widens toward the mouth (0 = constant width)."),
  braidBias: z.number().min(0).max(1).default(0).describe("0\u20131: pushes braiding toward the mouth (1 = braids mostly near the end, delta-style)."),
  /** Terrain-slope coupling strength — steep ground (from the sketched
   * mountains' elevation field) straightens the meander. DEFAULT 0 (coupling
   * OFF, plan 035 river v2): a river is a canon stroke that terrain conforms to,
   * not the reverse, so a fresh river ignores terrain unless the GM opts in
   * (>0). With no terrain in reach — no mountain/relief/landform stamps AND a
   * zero base field — the output is identical for ANY value; it only matters
   * where a river crosses composed terrain. The opt-in reads the global
   * macro-terrain field (`macroTerrainField` — relief/landform stamps + base fBm
   * over the raw sketch, never the mountain generator's output). */
  slopeSensitivity: z
    .number()
    .min(0)
    .max(1)
    .default(0)
    .describe("0\u20131: how strongly steep terrain straightens the meanders. 0 = the river ignores terrain entirely."),
  /** GM-editable per-vertex carve DEPTH (m), aligned to the sketch spine
   * vertices (plan 040 river depths). Absent (default) ⇒ the uniform
   * width-derived incision `riverCarveDepth(width)` — byte-identical to a river
   * with no depths, so the generator (which never reads this — it drives the
   * TERRAIN CARVE only, not the channel geometry) and its goldens are untouched.
   * Present ⇒ the carve interpolates depth along arc length between vertices;
   * downhill flow is still guaranteed by the carve's cumulative-min (a river can
   * never flow uphill regardless of the GM's input). A length mismatch or a
   * non-finite entry is ignored (falls back to uniform). */
  depths: z
    .array(z.number())
    .optional()
    .describe("Per-vertex gorge depth in meters, edited with the on-map depth grips \u2014 water still always flows downhill."),
});

/** River presets. Params are the whole truth; the "delta weights braiding
 * toward the end" behavior is carried by `braidBias`, never a preset-id branch.
 * slopeSensitivity is DEFAULT OFF (river v2, plan 035) — a lowland/delta river is
 * a canon stroke terrain conforms to; `mountain-torrent` is the one preset that
 * opts INTO slope coupling (its whole identity is terrain-following), the
 * intended exemplar of the durable macro-terrain read. */
const RIVER_PRESETS: readonly ProcgenPreset[] = [
  {
    id: "lazy-lowland",
    label: "Lazy lowland — wide, windy, braided",
    params: { windiness: 0.85, braiding: 0.5, width: 26, widthGrowth: 0.7, braidBias: 0.2, slopeSensitivity: 0 },
  },
  {
    // slopeSensitivity 1: the one preset that opts INTO terrain coupling — a
    // torrent straightens on steep ground (reads the sketched mountains' field).
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
    params: { windiness: 0.5, braiding: 1, width: 22, widthGrowth: 1.2, braidBias: 1, slopeSensitivity: 0 },
  },
];

/** River tile-generator ids = the emitted feature buckets: channel water + bank
 * casing lines + island land. Derived from the style contract (cache keys and
 * paint layers share one manifest). */
export const RIVER_TILE_GENERATOR_IDS: readonly string[] = contractGids(RIVER_STYLE_CONTRACT);

const riverAlgorithm: ProcgenAlgorithm = {
  id: "river",
  label: "River",
  // Version 3 (plan 038 item 3): tributary rank — a Strahler-ish channel-width
  // response to the SKETCHED spine topology (other river sketches within the
  // existing CONFLUENCE_SNAP_M reach, so `consumesSketch`/`influenceMargin` are
  // unchanged). The main half-width steps UP below each tributary junction
  // (discharge adds, W ∝ √Q), CAPPED at maxHalfWidth so the params-only corridor
  // is never exceeded; a tributary's mouth is clamped to a narrower main's width.
  // A river with NO topology (no tributaries, not itself a tributary) is
  // byte-identical to v2 (golden unchanged); topology present changes bytes ⇒ the
  // bump gates adoption. (Rule 3 — junction-angle nudge — deferred: it would
  // deform the generated centerline, risking the corridor/weld invariants.)
  // Version 2 (plan 035, river v2): slopeSensitivity default flipped 1→0 — a
  // river omitting the param and crossing a sketched mountain runs its full
  // meander (uncoupled) instead of straightening.
  currentVersion: 3,
  appliesTo: ["river"],
  // Stage 0 (HYDROLOGY — the canon strokes; plan 035 moved hydrology BELOW
  // terrain). Produces the `water` channel forest/city read. Consumes NOTHING
  // from a lower stage: there is none. The opt-in (slopeSensitivity>0) slope
  // coupling reads the sketched mountains' elevation field
  // (`elevationFieldFromFabric`) as a DURABLE MACRO-TERRAIN input — legal at any
  // stage because it reads the raw sketch layer, not the stage-1 mountain
  // GENERATOR output — so it is declared as a `consumesSketch` reach, never a
  // `consumes` currency (a stage-0 river cannot consume a stage-1 currency; the
  // reorder is exactly what frees rivers from terrain). "Macro terrain, not
  // finished terrain."
  stage: 0,
  produces: ["water"],
  consumes: [],
  // Raw sketch reads: water + a partner river spine (confluence snap,
  // CONFLUENCE_SNAP_M = 30) and the durable global TERRAIN system's stamps —
  // mountain/relief/landform (slope coupling reads the composed field via
  // `macroTerrainField`; ruling 2026-07-15 — DEFAULT OFF as of v2, but the opt-in
  // path reads it, so the declaration stays honest for the most-consuming params
  // the 033-A harness probes). VARIABLE SUPPORT: the terrain kinds use a
  // PER-FEATURE reach (`terrainStampSupport`: relief → halfWidth+apron, mountain/
  // landform → 0), so the 30 m scalar governs only water/river (confluence snap).
  // Because terrain sits ABOVE the river in the stage order, a terrain edit never
  // cascades DOWN via a currency; it can only reach the river through the
  // source→region edge within a stamp's support, and Jonah's litmus fixture keeps
  // the mountain ~110 m away (S7) so a terrain edit does zero river runs.
  consumesSketch: ["water", "river", "mountain", "relief", "landform"],
  influenceMargin: 30,
  costClass: "medium",
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

// ─── Forest — masked-noise polygon canopy ────────────────────────────────────

/** Forest params. All knobs have sensible defaults so a bare `{}` validates to
 * a reasonable mixed woodland. */
const forestParamsSchema = z.object({
  variety: z.enum(FOREST_VARIETIES).default("mixed").describe("Tree-cover family \u2014 sets the canopy look and the theme\u2019s tint."),
  density: z.number().min(0).max(1).default(0.6).describe("0\u20131: how much of the sketched area the canopy fills."),
  clearings: z.number().min(0).max(1).default(0.15).describe("0\u20131: how many open glades break up the canopy."),
  edgeRaggedness: z.number().min(0).max(1).default(0.5).describe("0\u20131: how ragged the outer canopy edge is (0 = smooth hull)."),
});

/** Forest presets. Params are the whole truth; `variety` is carried onto
 * features for theme tinting, never a runtime branch in the generator. */
const FOREST_PRESETS: readonly ProcgenPreset[] = [
  { id: "broadleaf", label: "Broadleaf — dense deciduous wood", params: { variety: "broadleaf", density: 0.7, clearings: 0.12, edgeRaggedness: 0.45 } },
  { id: "conifer", label: "Conifer — dark evergreen forest", params: { variety: "conifer", density: 0.8, clearings: 0.08, edgeRaggedness: 0.3 } },
  { id: "mixed", label: "Mixed woodland — varied cover, glades", params: { variety: "mixed", density: 0.6, clearings: 0.18, edgeRaggedness: 0.5 } },
  { id: "swamp", label: "Swamp — patchy wetland trees", params: { variety: "swamp", density: 0.5, clearings: 0.3, edgeRaggedness: 0.65 } },
  { id: "dead-wood", label: "Dead-wood — sparse, ragged, many clearings", params: { variety: "dead-wood", density: 0.35, clearings: 0.35, edgeRaggedness: 0.7 } },
];

/** Forest tile-generator ids = the emitted feature buckets. The canopy is ONE
 * `forest-canopy` MultiPolygon (clearings are interior HOLES, not
 * `forest-clearing` features) plus its `forest-canopy-rim` outline LineStrings
 * and the `forest-tree` stipple. `forest-clearing` is retained in the list so
 * older caches still surface their clearing cells (cache keys + paint layers
 * key on these ids; an uncached gid is silently dropped). */
export const FOREST_TILE_GENERATOR_IDS: readonly string[] = contractGids(FOREST_STYLE_CONTRACT);

const forestAlgorithm: ProcgenAlgorithm = {
  id: "forest",
  label: "Forest",
  // Version 4 (plan 038 item 7): sketch adjacency — where the forest ring abuts a
  // farmland or park SKETCH, a woodland-bank / hedgerow line runs along the shared
  // edge, computed by the SYMMETRIC hashed rule so the neighbour's line is
  // bit-identical (`sharedBoundary.ts`). Adds farmland/park to `consumesSketch`
  // (influenceMargin = HEDGE_ADJ_EPS 8: a region farther than eps cannot share a
  // boundary ⇒ byte-inert). No adjacent farmland/park in reach ⇒ byte-identical
  // to v3.
  // Version 3 (plan 038 item 4): terrain reading — timberline thinning + drop,
  // conifer-upslope `standConifer`, contour-sag; reads the mountain SKETCH.
  // Version 2 (plan 037, river → forest): the `water` consumption WIRED — no
  // canopy/tree inside the generated channel + a riparian density ramp.
  currentVersion: 4,
  appliesTo: ["forest"],
  // Stage 2 (vegetation): no canopy in the river → consumes `water` (WIRED, plan
  // 037). Produces `vegetation` for the city's growth-cost bump. NEVER consumes
  // `settlement` — the reverse (city clips canopy) is rejected outright (it
  // breaks cycle-freedom); the town reads as a clearing because city fabric
  // paints above canopy within layer 1.
  stage: 2,
  produces: ["vegetation"],
  consumes: ["water"],
  // Raw sketch reads: the durable global TERRAIN system's stamps —
  // mountain/relief/landform (ruling 2026-07-15: the forest timberline reads the
  // composed terrain field, not a mountain polygon; a relief RIDGE thins the
  // canopy above its treeline with no mountain present) + adjacent FARMLAND/PARK
  // rings (item 7 shared-boundary hedgerow, within HEDGE_ADJ_EPS). The
  // `consumes: ["water"]` above is a DAG OUTPUT edge, not a raw-sketch read.
  consumesSketch: ["mountain", "relief", "landform", "farmland", "park"],
  // VARIABLE SUPPORT (ruling 2026-07-15): the terrain-stamp kinds use a
  // PER-FEATURE reach (`terrainStampSupport`: relief → its halfWidth+apron, mountain/
  // landform → 0, all compact-support) wherever invalidation is computed
  // (fingerprint scope + DAG source→region edge), so this scalar governs only the
  // NON-terrain kinds. 8 = HEDGE_ADJ_EPS (farmland/park adjacency reach): a region
  // whose bbox is farther than this cannot put a ring vertex within eps of ours ⇒
  // byte-inert.
  influenceMargin: 8,
  costClass: "cheap",
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

// ─── Park — the second consumer of the ground-cell + harmonic blob primitives ─

/** Park params. All knobs have defaults so a bare `{}` validates to a reasonable
 * city park. `variety` drives layout (like the city algorithm's `profile`),
 * never a preset-id branch; `pond` is a bool, `pathDensity` 0–1. */
const parkParamsSchema = z.object({
  variety: z
    .enum(PARK_VARIETIES)
    .default("city-park")
    .describe("Park composition family \u2014 formal axes, curved city paths, street-aligned urban park, wild common, or a Japanese circuit."),
  pathDensity: z.number().min(0).max(1).default(0.5).describe("0\u20131: how dense the path web is."),
  pond: z.boolean().default(false).describe("Include a pond (with an island and bridge where the composition allows)."),
});

/** Park presets. Params are the whole truth; `japanese-garden` forces
 * `pond: true` (its composition anchor). `urban-park` (plan 035) is the
 * peri-urban variety: same composition family as city-park, but its entrances
 * align to the GENERATED city street crossings on the ring (stage 4, consumes
 * `settlement` — see `dagRole`). */
const PARK_PRESETS: readonly ProcgenPreset[] = [
  { id: "formal-garden", label: "Formal garden — axial paths, symmetric beds", params: { variety: "formal-garden", pathDensity: 0.6, pond: false } },
  { id: "city-park", label: "City park — curved paths, lawns, a pond", params: { variety: "city-park", pathDensity: 0.5, pond: true } },
  { id: "urban-park", label: "Urban park — entrances off the generated city streets", params: { variety: "urban-park", pathDensity: 0.5, pond: true } },
  { id: "wild-common", label: "Wild common — sparse paths, scattered trees", params: { variety: "wild-common", pathDensity: 0.3, pond: false } },
  { id: "japanese-garden", label: "Japanese garden — winding circuit, pond, island, rocks", params: { variety: "japanese-garden", pathDensity: 0.4, pond: true } },
];

/** Park tile-generator ids = the emitted feature buckets: ground fabric + path
 * web + water (pond/island/bridge) + gravel court + rock + tree points. Cache
 * keys + paint layers key on these. */
export const PARK_TILE_GENERATOR_IDS: readonly string[] = contractGids(PARK_STYLE_CONTRACT);

const parkAlgorithm: ProcgenAlgorithm = {
  id: "park",
  label: "Park",
  // Version 5 (plan 038 item 7): sketch adjacency — where the park ring abuts a
  // forest sketch the two canopies read CONTINUOUS across the seam, and where it
  // abuts a farmland sketch the same shared-edge line reads as a hedgerow; both
  // are the SAME line the neighbour derives (symmetric hashed agreement,
  // `sharedBoundary.ts`). Adds forest/farmland to `consumesSketch` (the existing
  // 30 m road margin already covers the 8 m adjacency reach). No adjacent
  // forest/farmland in reach ⇒ byte-identical to v4. (Park pond-at-low-point,
  // plan 038 item 4, was DEFERRED — the pond is entangled with the interiorPole-
  // anchored radial composition; see the plan-038 report.)
  // Version 4 (plan 037, river → park): the `water` consumption WIRED — no
  // canopy/tree/path/lawn-dressing inside the generated channel; a pond anchored
  // in the channel is dropped.
  // Version 3 (plan 035, park split): the `urban-park` variety joined the
  // schema/varieties. Rural varieties are byte-identical to v2 (the golden is
  // unchanged — bump is bookkeeping for the schema/variety surface); one
  // algorithm id serves both roles (the zod enum grew a member — no schema
  // pressure for a second id).
  // Version 2: blobFeature mm-quantizes its ring (D5), snapping the
  // formal-garden bed / japanese bridge / court coordinates to sub-mm.
  currentVersion: 5,
  appliesTo: ["park"],
  // Rural varieties: stage 2 (vegetation), same band as forest — a park pond
  // sits away from a river channel → consumes `water` (WIRED, plan 037);
  // produces `vegetation`. The `urban-park` variety re-homes to stage 4 via
  // `dagRole` below (and still consumes `water` — a river crossing an urban park
  // is excluded exactly as for a rural one).
  stage: 2,
  produces: ["vegetation"],
  consumes: ["water"],
  // Park reads road (a path enters where a sketched road meets the ring,
  // ROAD_ENTRANCE_THRESH_M = 30) + adjacent FOREST/FARMLAND rings (item 7
  // shared-boundary line, within HEDGE_ADJ_EPS 8 ≤ the 30 m margin). urban-park's
  // street alignment reads GENERATED settlement via `constraints.upstream`, never
  // a raw sketch, so it changes nothing here.
  consumesSketch: ["road", "forest", "farmland"],
  influenceMargin: 30,
  costClass: "medium",
  // PARK SPLIT (plan 035): variety drives the stage — `urban-park` sits in the
  // stage-4 peri-urban band, consumes the generated `settlement` (entrances/axes
  // align to street crossings on the ring) and produces NOTHING (the cycle-guard
  // invariant: nothing may consume settlement while producing a currency the
  // city consumes — rural varieties are the vegetation producers). Malformed
  // params fall back to the static rural role (never throw — replay must not
  // die on a corrupt block; the schema rejects it loudly at the IO boundary).
  dagRole(params: Record<string, unknown>): DagRole {
    return params.variety === "urban-park"
      ? { stage: 4, produces: [], consumes: ["settlement", "water"] }
      : { stage: this.stage, produces: this.produces, consumes: this.consumes };
  },
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

// ─── Wall — the second LINE-kind algorithm (after river) ─────────────────────

/** Wall params. All knobs have defaults so a bare `{}` validates to a plain
 * curtain wall. `style` drives layout (like the city `profile` / park
 * `variety`), never a preset-id branch. */
const wallParamsSchema = z.object({
  style: z
    .enum(WALL_STYLES)
    .default("curtain-wall")
    .describe("Construction style: stone curtain wall with towers, timber palisade (no towers), or an angular star-fort trace."),
  towerSpacing: z.number().min(15).max(400).default(60).describe("Distance in meters between towers along the wall."),
  moat: z.boolean().default(false).describe("Dig a water moat just outside the wall (bridged at the gates)."),
  gatehouseScale: z.number().min(0.2).max(3).default(1).describe("Size multiplier for the gatehouses (1 = standard)."),
});

/** Wall presets. Params are the whole truth; `palisade` carries `towerSpacing`
 * too (harmless — the generator emits no towers for a palisade), so switching
 * style keeps the knob. */
const WALL_PRESETS: readonly ProcgenPreset[] = [
  { id: "curtain-wall", label: "Curtain wall — stone, regular towers", params: { style: "curtain-wall", towerSpacing: 60, moat: false, gatehouseScale: 1 } },
  { id: "palisade", label: "Palisade — timber stockade, no towers", params: { style: "palisade", towerSpacing: 60, moat: false, gatehouseScale: 0.8 } },
  { id: "bastioned", label: "Bastioned — angular star-fort trace, moat", params: { style: "bastioned", towerSpacing: 90, moat: true, gatehouseScale: 1.4 } },
];

/** Wall tile-generator ids = the emitted feature buckets: the outboard moat, the
 * masonry band, the towers, and the gate markers. Cache keys + paint layers key
 * on these. */
export const WALL_TILE_GENERATOR_IDS: readonly string[] = contractGids(WALL_STYLE_CONTRACT);

const wallAlgorithm: ProcgenAlgorithm = {
  id: "wall",
  label: "Wall",
  // Version 4 (plan 033 glacis apron): the wall now emits an outboard earthwork
  // `wall-glacis` band beyond the moat (or beyond the masonry band when there is
  // no moat), on the away-from-interior side, gapped at gates and over generated
  // water. It is emitted for EVERY style, so every wall's bytes change vs v3 (the
  // golden re-accepts) — but the band/tower/moat/gate features are byte-untouched;
  // the glacis is purely additive, and the corridor widens to bound its far edge.
  // Version 3 (plan 038 item 8): water-gate refinements — a `wall-gate`
  // (`waterGate: true`) sluice marker where the spine crosses the GENERATED
  // channel or a city canal, and (with a moat) a leat quad snapping the offset
  // moat to that bank crossing. The city canal is now fed into the settlement
  // payload (`buildSettlementPayload.canalLines`); the wall gaps its moat/band
  // over canals too. A wall with NO upstream water AND no canal in reach is
  // byte-identical to v2 (golden unchanged); water in reach changes bytes ⇒ the
  // bump gates adoption.
  // Version 2 (plan 037 item 4): the `settlement` payload wired — gates fall
  // where GENERATED streets cross the spine (class precedence, gatehouse axis =
  // crossing bearing), the moat sits AWAY from the town interior, and the
  // moat/masonry band gaps over the generated channel (river-is-the-moat) →
  // `water` joins consumes. The 035 cycle guard holds: wall consumes settlement
  // at stage 5 and produces `detail`, which the city never reads — no
  // city→wall→city cycle.
  currentVersion: 4,
  appliesTo: ["wall"],
  // Stage 5 (DETAIL — plan 035 renumber): the procgen wall ELABORATION
  // (towers/gates/moat) consumes stage-3 `settlement` (gates/gatehouses, moat
  // side) and stage-0 `water` (moat/band gap over the channel — plan 037). The
  // raw wall SKETCH stays a stage-agnostic constraint every stage reads
  // (`fabricConstraints.wallLines`) — orthogonal to this stage. The cascade never
  // carries stage-5 output downward (produces `detail`, which nothing consumes).
  stage: 5,
  produces: ["detail"],
  consumes: ["settlement", "water"],
  // Wall reads road only: gates fall where a road crosses the wall spine (exact
  // segment intersection). A road strictly outside the corridor bbox cannot
  // cross the spine, so the margin is 0.
  consumesSketch: ["road"],
  influenceMargin: 0,
  costClass: "medium",
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

// ─── Farmland — the agriculture polygon kind ─────────────────────────────────

/** Farmland params. All knobs have defaults so a bare `{}` validates to a
 * reasonable patchwork. `fieldType` drives layout (like the city `profile` /
 * park `variety`), never a preset-id branch. */
const farmlandParamsSchema = z.object({
  fieldType: z
    .enum(FARMLAND_TYPES)
    .default("enclosed-patchwork")
    .describe("Field pattern family \u2014 medieval strips, hedged patchwork, rectilinear grid sections, orchard rows, or contour-following paddies."),
  fieldSize: z.number().min(0).max(1).default(0.5).describe("0\u20131: typical field size (0 = many small plots, 1 = a few large ones)."),
  hedging: z.enum(HEDGING_KINDS).default("hedgerows").describe("What separates the fields: hedgerows, fences, or nothing."),
  laneDensity: z.number().min(0).max(1).default(0.5).describe("0\u20131: how dense the farm-lane web is."),
  farmsteads: z.number().min(0).max(1).default(0.4).describe("0\u20131: how many farmstead buildings dot the fields."),
});

/** Farmland presets. `paddy-terraces` is the field-coupled variant:
 * contour-following banks over the sketched mountains' elevation field,
 * concentric fallback on flat ground. Params are the whole truth; `fieldType` is
 * carried onto features for theme tinting, never a runtime preset-id branch. */
const FARMLAND_PRESETS: readonly ProcgenPreset[] = [
  { id: "open-field-strips", label: "Open-field strips — medieval furlongs off lanes", params: { fieldType: "open-field-strips", fieldSize: 0.55, hedging: "none", laneDensity: 0.66, farmsteads: 0.3 } },
  { id: "enclosed-patchwork", label: "Enclosed patchwork — irregular hedged fields", params: { fieldType: "enclosed-patchwork", fieldSize: 0.5, hedging: "hedgerows", laneDensity: 0.4, farmsteads: 0.45 } },
  { id: "grid-quarters", label: "Grid quarters — rectilinear sections + section roads", params: { fieldType: "grid-quarters", fieldSize: 0.7, hedging: "fences", laneDensity: 0.66, farmsteads: 0.35 } },
  { id: "orchard", label: "Orchard — regular tree rows", params: { fieldType: "orchard", fieldSize: 0.4, hedging: "hedgerows", laneDensity: 0.5, farmsteads: 0.3 } },
  { id: "paddy-terraces", label: "Paddy terraces — contour-following banks", params: { fieldType: "paddy-terraces", fieldSize: 0.35, hedging: "none", laneDensity: 0.4, farmsteads: 0.25 } },
];

/** Farmland tile-generator ids = the emitted feature buckets: tilled fields, the
 * lane web, field-edge hedges/fences, farmstead footprints, orchard tree points,
 * and paddy terrace bank lines. Cache keys + paint layers key on these. (An
 * older cached farmland tile missing the `farm-bank` bucket re-clips the cached
 * network on its next read; the other gids' bytes are unchanged.) */
export const FARMLAND_TILE_GENERATOR_IDS: readonly string[] = contractGids(FARMLAND_STYLE_CONTRACT);

const farmlandAlgorithm: ProcgenAlgorithm = {
  id: "farmland",
  label: "Farmland",
  // Version 7 (2026-07-15 riverine REACH rewrite): the rang holdings now share
  // ONE orientation per river REACH (a `RANG_REACH_LEN_M` arc-length window of the
  // bank) — every lot in a reach runs parallel to a single inland normal, packed
  // edge-to-edge with snapped frontage, and the lattice fields AND lanes inside
  // the whole band footprint are suppressed. v4–v6 gave each lot its own
  // per-sample bank normal, so a meandering bank sprayed a fan of crossing ribbons
  // that overlapped each other and the grid fields on both banks ("that's not how
  // farms work" — Jonah, Vailmarch Marnside, twice). Bytes change ONLY for a
  // region a generated river borders (the rang path is `channel !== null`); a
  // farmland with no upstream channel is byte-identical to v6 (golden unchanged —
  // the bump gates adoption).
  // Version 6 (2026-07-15 riverine long-lot rescale): the rang holdings' inland
  // DEPTH is a fixed multiple of their own frontage (`rangDepthM` ≈ 4:1 lot,
  // capped), not a multiple of the coarse field-cell. The v4/v5 `1.6·cell` reach
  // ran the lots 4–6× deeper than the ambient fields, so against a river crossing
  // the region the rang band covered the WHOLE patch and each long straight lot
  // amplified a meandering bank's swinging normal into sweeping crossing ribbons
  // (Jonah, Vailmarch Marnside). Bytes change ONLY for a region a generated river
  // borders (the rang path is `channel !== null`); a farmland with no upstream
  // channel is byte-identical to v5 (golden unchanged — the bump gates adoption).
  // Version 5 (make-it-look-real shortlist, items 8 + 9): (item 8) the peri-urban
  // GATE LANES no longer ray straight across the belt to a distant junction — each
  // is a short diagonal stub (clipped at the first field-cell boundary, with
  // deterministic per-lane angle jitter) that then follows the field edges
  // (axis-aligned gridline legs) to the junction; (item 9) a FAUBOURG transition
  // band — orchard rows + garden plots tagged `faubourg: true` in the outermost
  // strip where the belt's ring faces the generated city, between the wall/city
  // edge and the first fields. Both read ONLY the settlement payload farmland
  // already consumes (035); a farmland with NO settlement in reach is
  // byte-identical to v4 (golden unchanged — the bump gates adoption).
  // Version 4 (plan 038): riverine long-lots (item 2) — near a generated river
  // bank the fields become narrow rang holdings PERPENDICULAR to the water, the
  // near end tagged `waterMeadow`; the normal lattice fields in that band are
  // suppressed. A farmland with NO upstream channel is byte-identical to v3
  // (golden unchanged); one the river borders changes bytes ⇒ the bump gates
  // adoption. (Plan 038 items 3/4 — terrain slope-gating / contour strips and
  // forest sketch-adjacency hedgerows — ride this same v4 bump; each stays
  // byte-identical to v3 when its upstream/adjacency is absent.)
  // Version 3 (plan 037, river → farmland): `water` joins the consumed set —
  // no field/lane/bank/farmstead geometry crosses the generated channel.
  // Version 2 (plan 035, peri-urban move): farmland reads the generated city
  // street network (`upstream.settlement`) — gate lanes radiate from the
  // arterial exits, a field-size gradient runs toward the wall line.
  currentVersion: 7,
  appliesTo: ["farmland"],
  // Stage 4 (PERI-URBAN, plan 035): farmland is the city's apron, generated
  // AFTER it. Consumes `settlement` (WIRED: lanes orient to the generated
  // gates/arterials, field size grades toward the wall line), `elevation`
  // (paddy-terraces follow the mountain contours — Jonah's litmus: a terrain
  // edit reaches farmland, never a river) and `water` (plan 037: fields/lanes
  // stop at the generated river channel). Produces NOTHING downstream — the
  // city reads a raw farmland SKETCH (`fabricConstraints.farmlandRings`) to
  // suppress its outskirts ("ring = land claim, output = interior dressing"),
  // not farmland's generated OUTPUT, so there is no farmland → city edge and
  // the cycle guard holds.
  stage: 4,
  produces: [],
  consumes: ["elevation", "settlement", "water"],
  // Farmland reads the durable global TERRAIN system's stamps —
  // mountain/relief/landform (paddy contours + item-4 slope-gating via
  // `macroTerrainField`; ruling 2026-07-15 — a landform PLATEAU edge banks
  // paddies with no mountain present) + adjacent FOREST/PARK rings (item 7
  // shared-boundary hedgerow, within HEDGE_ADJ_EPS). The city reads a raw farmland
  // SKETCH, but that is the CITY's consumesSketch, not farmland's.
  consumesSketch: ["mountain", "relief", "landform", "forest", "park"],
  // VARIABLE SUPPORT (ruling 2026-07-15): the terrain-stamp kinds use a
  // PER-FEATURE reach (`terrainStampSupport`: relief → halfWidth+apron, mountain/
  // landform → 0), so this scalar governs only the NON-terrain kinds. 8 =
  // HEDGE_ADJ_EPS (item 7 forest/park adjacency reach); beyond it, byte-inert.
  influenceMargin: 8,
  costClass: "medium",
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

// ─── Mountain — the relief polygon kind, first consumer of the elevation field
// (fields/elevation.ts) ──────────────────────────────────────────────────────

/** Mountain params. All knobs have defaults so a bare `{}` validates to a
 * reasonable alpine massif. `terrain` drives layout (like the city `profile` /
 * park `variety`), never a preset-id branch. */
const mountainParamsSchema = z.object({
  terrain: z
    .enum(MOUNTAIN_TERRAINS)
    .default("alpine")
    .describe("Mountain family \u2014 alpine ridges, terraced mesa, or rolling hills; sets the character of the height field."),
  amplitude: z
    .number()
    .min(0)
    .max(1)
    .default(0.6)
    .describe("0\u20131: overall height of the massif (0 \u2248 200 m foothills, 1 \u2248 1400 m walls)."),
  roughness: z.number().min(0).max(1).default(0.5).describe("0\u20131: how jagged the surface detail is."),
});

/** Mountain presets. Params are the whole truth; `terrain` is carried onto
 * features for theme tinting, never a runtime preset-id branch. */
const MOUNTAIN_PRESETS: readonly ProcgenPreset[] = [
  { id: "alpine", label: "Alpine — high ridged peaks, steep relief", params: { terrain: "alpine", amplitude: 0.85, roughness: 0.6 } },
  { id: "mesa", label: "Mesa — terraced tablelands, cliff risers", params: { terrain: "mesa", amplitude: 0.55, roughness: 0.4 } },
  { id: "rolling-hills", label: "Rolling hills — gentle rounded uplands", params: { terrain: "rolling-hills", amplitude: 0.3, roughness: 0.35 } },
];

/** Mountain tile-generator ids = the emitted feature buckets: the rocky-ground
 * massif, the downslope relief hachures, and the summit peaks. Cache keys + paint
 * layers key on these — EVERY emitted gid MUST appear here or the tile clip
 * silently drops it. (The `mountain-contour` bucket was RETIRED in v2 — iso-lines
 * are now a global surface off the composed terrain field, not a mountain gid.) */
export const MOUNTAIN_TILE_GENERATOR_IDS: readonly string[] = contractGids(MOUNTAIN_STYLE_CONTRACT);

const mountainAlgorithm: ProcgenAlgorithm = {
  id: "mountain",
  label: "Mountain",
  // Version 2 (Jonah 2026-07-15, contour retirement): the mountain generator no
  // longer emits `mountain-contour` iso-lines — relief lines are now a global
  // viewport-keyed surface off the composed campaign terrain field
  // (`fields/terrainContours.ts` → the `terrain-contour` paint role), rendering
  // EVERYWHERE the field has relief, not only inside a mountain ring. The
  // massif/hachure/peak dressing is byte-IDENTICAL to v1 (asserted in
  // mountain.test.ts — only the contour features disappear); this is a pure
  // emit-shape shrink, so any existing region re-goldens under the bump and a
  // pinned-v1 region without cache shows the needs-adoption badge until adopted.
  currentVersion: 2,
  appliesTo: ["mountain"],
  // Stage 1 (TERRAIN — plan 035 moved it ABOVE hydrology; terrain conforms to
  // the rivers below it). Produces `elevation`. That currency reaches farmland
  // (stage 4, `consumes: ["elevation"]`) as a real region→region edge; the
  // river above it (stage 0) reads the SKETCH-derived elevation field as a
  // durable macro-input, NOT this generated currency (a terrain edit reaches
  // farmland, never a river). Consumes nothing.
  stage: 1,
  produces: ["elevation"],
  consumes: [],
  // The base field — generateMountain reads no constraints at all.
  consumesSketch: [],
  influenceMargin: 0,
  costClass: "cheap",
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

// ─── Relief — ridge/valley polyline ADD-stamp (plan 036 terrain) ─────────────

/** Relief params: a signed cross-profile stamp read by `terrainAt`. `polarity`
 * drives layout (ridge raises, valley lowers), never a preset-id branch. */
const reliefParamsSchema = z.object({
  polarity: z
    .enum(RELIEF_POLARITIES)
    .default(RELIEF_DEFAULTS.polarity)
    .describe("Ridge raises the ground along the drawn line; valley lowers it."),
  height: z
    .number()
    .positive()
    .max(4000)
    .default(RELIEF_DEFAULTS.height)
    .describe("Peak height (or valley depth) in meters along the drawn line \u2014 the extrude grip edits this too."),
  halfWidth: z
    .number()
    .positive()
    .max(20000)
    .default(RELIEF_DEFAULTS.halfWidth)
    .describe("Core width in meters (the GUI presents halfWidth + apron as one total \u2018width\u2019 \u2014 the terrain reads only their sum)."),
  /** Foothill apron (meters): a skirt that decays the cross-profile to 0 over
   * `halfWidth + apron` instead of hitting 0 at `halfWidth`, so a stamp rises out
   * of foothills rather than as a vertical-walled mesa in 3D. OPTIONAL — absent ⇒
   * 0 ⇒ byte-identical to the pre-apron stamp (no version bump; the
   * absent-param-reproduces-old-bytes discipline). The `reliefReach`/corridor/
   * support all fold it in. */
  apron: z
    .number()
    .min(0)
    .max(20000)
    .optional()
    .describe("Foothill skirt in meters beyond the half-width (the GUI presents halfWidth + apron as one total \u2018width\u2019)."),
});

const RELIEF_PRESETS: readonly ProcgenPreset[] = [
  // Presets carry a modest apron so a FRESH relief stamp reads as a foothill
  // skirt by default (the make-it-look-real goal); an existing stamp with no
  // persisted `apron` key stays byte-identical.
  { id: "ridge", label: "Ridge — a raised spine over foothills", params: { polarity: "ridge", height: 300, halfWidth: 180, apron: 220 } },
  { id: "valley", label: "Valley — an incised trough", params: { polarity: "valley", height: 200, halfWidth: 220, apron: 180 } },
];

const reliefAlgorithm: ProcgenAlgorithm = {
  id: "relief",
  label: "Relief",
  currentVersion: 1,
  appliesTo: ["relief"],
  // Stage 1 (TERRAIN, with mountains): a durable add-stamp of the composed
  // elevation field. Produces `elevation`; the generator itself emits NO
  // per-region fabric — the stamp's visible form is the composed-field contours/
  // hillshade (plan 036-C), and its arithmetic effect flows through `terrainAt`.
  stage: 1,
  produces: ["elevation"],
  consumes: [],
  // A base terrain stamp reads no other sketch — pure function of its own spine
  // + params.
  consumesSketch: [],
  influenceMargin: 0,
  costClass: "cheap",
  paramsSchema: reliefParamsSchema as unknown as z.ZodType<Record<string, unknown>>,
  presets: RELIEF_PRESETS,
  defaultPresetId(): string {
    return "ridge";
  },
  defaultParams(): Record<string, unknown> {
    return { ...RELIEF_PRESETS[0].params };
  },
  // No emitted fabric buckets: the field is the product (contours re-home to the
  // composed field in 036-C).
  tileGeneratorIds: [],
  corridorMaxOffset(params: Record<string, unknown>): number {
    return reliefMaxOffset(reliefParamsSchema.parse(params) as unknown as ReliefParams);
  },
  generate(): GeoJSON.Feature[] {
    return [];
  },
};

// ─── Landform — plateau/basin/sea polygon REPLACE-stamp (plan 036 terrain) ───

/** Landform params: a replace-toward-target stamp read by `terrainAt`. `mode`
 * drives the default target (plateau raises, basin lowers, sea → seaDatum);
 * `priority` (Q4) makes id-order last-wins overridable where masks overlap. */
const landformParamsSchema = z.object({
  mode: z
    .enum(LANDFORM_MODES)
    .default(LANDFORM_DEFAULTS.mode)
    .describe("Plateau raises the interior to a target height, basin lowers it, sea drops it to the campaign\u2019s sea level."),
  target: z
    .number()
    .finite()
    .optional()
    .describe("Target elevation in meters the interior is pulled to \u2014 leave empty for the mode\u2019s default (plateau 400, basin \u2212200, sea = sea level)."),
  band: z
    .number()
    .min(0)
    .max(20000)
    .default(LANDFORM_DEFAULTS.band)
    .describe("Width in meters of the rim over which the terrain blends from natural ground to the target \u2014 the on-map band grip edits this too."),
  priority: z
    .number()
    .int()
    .default(LANDFORM_DEFAULTS.priority)
    .describe("Where landforms overlap, the higher priority wins."),
  /** Island-from-coastline (plan 041): on a `sea` stamp, draw the COAST (the land
   * boundary) and treat the ring's EXTERIOR as sea instead of its interior — the
   * natural gesture for an island. OPTIONAL — absent/false ⇒ the drawn ring's
   * interior is the sea (the pre-041 behavior), byte-identical (no version bump).
   * Ignored for plateau/basin (only sea inverts). */
  invert: z
    .boolean()
    .optional()
    .describe("Island coast: you drew the SHORELINE \u2014 everything outside it becomes sea instead of the inside (sea mode only)."),
});

const LANDFORM_PRESETS: readonly ProcgenPreset[] = [
  { id: "plateau", label: "Plateau — flat tableland raised to a target", params: { mode: "plateau", band: 120, priority: 0 } },
  { id: "basin", label: "Basin — a lowered depression", params: { mode: "basin", band: 120, priority: 0 } },
  { id: "sea", label: "Sea — dropped to the sea datum", params: { mode: "sea", band: 60, priority: 0 } },
  // Draw the COAST; everything outside becomes ocean (plan 041 island-from-coastline).
  { id: "island", label: "Island coast — draw the shore, outside is sea", params: { mode: "sea", band: 60, priority: 0, invert: true } },
];

const landformAlgorithm: ProcgenAlgorithm = {
  id: "landform",
  label: "Landform",
  currentVersion: 1,
  appliesTo: ["landform"],
  // Stage 1 (TERRAIN): a replace-stamp of the composed field; emits no per-region
  // fabric (visible form is the composed-field contours, plan 036-C).
  //
  // MULTI-RING (Cradle learning 2026-07-15): the landform polygon HONOURS HOLES —
  // the mask is `min(outerMask, 1 − holeMask_i)` per hole, so a hole interior
  // stays at base elevation (a donut sea leaves the island in its hole dry, the
  // exact bug found). Single-ring landforms are byte-identical (no version bump).
  // `influenceMargin` stays 0: every hole bbox is INSIDE the outer ring bbox, so
  // the outer bbox still bounds the whole stamp's support — a landform disjoint
  // from a region is byte-inert regardless of its holes (the 033 under-invalidation
  // harness rides on this reach-0 assertion).
  stage: 1,
  produces: ["elevation"],
  consumes: [],
  consumesSketch: [],
  influenceMargin: 0,
  costClass: "cheap",
  paramsSchema: landformParamsSchema as unknown as z.ZodType<Record<string, unknown>>,
  presets: LANDFORM_PRESETS,
  defaultPresetId(): string {
    return "plateau";
  },
  defaultParams(): Record<string, unknown> {
    return { ...LANDFORM_PRESETS[0].params };
  },
  tileGeneratorIds: [],
  generate(): GeoJSON.Feature[] {
    return [];
  },
};

/** v1 registers `city` + `forest` + `park` + `farmland` + `mountain` + `relief` +
 * `landform` (polygon) + `river` + `wall` (line). Order matters for
 * `algorithmForKind` (first match wins) — keep the list explicit and small. */
const REGISTRY: readonly ProcgenAlgorithm[] = [
  cityAlgorithm,
  riverAlgorithm,
  forestAlgorithm,
  parkAlgorithm,
  wallAlgorithm,
  farmlandAlgorithm,
  mountainAlgorithm,
  reliefAlgorithm,
  landformAlgorithm,
];

export function algorithmForKind(kind: FabricKind): ProcgenAlgorithm | undefined {
  return REGISTRY.find((a) => a.appliesTo.includes(kind));
}

/** Does this algorithm's params schema accept a GM-placed generation `center`?
 * Drives the host's center-handle/panel affordance (Jonah 2026-07-16: a relief
 * or landform must not grow a city-center ◆ its generator never reads).
 * SCHEMA-derived — params are the whole truth (invariant #10), so the schema
 * key IS the capability; no per-algorithm flag to drift out of sync. */
export function algorithmSupportsCenter(algorithm: ProcgenAlgorithm): boolean {
  const shape = (algorithm.paramsSchema as unknown as { shape?: Record<string, unknown> }).shape;
  return !!shape && "center" in shape;
}

/** Every registered algorithm, in registry order. Read-only enumeration for
 * hosts (adopt-all), scripts (goldens), and contract tests. */
export function allAlgorithms(): readonly ProcgenAlgorithm[] {
  return REGISTRY;
}

export function algorithmById(id: string): ProcgenAlgorithm | undefined {
  return REGISTRY.find((a) => a.id === id);
}

/** The resolved DAG role of a region: the algorithm's `dagRole(params)` when it
 * defines one (park's variety-driven split, plan 035), its static
 * `stage`/`produces`/`consumes` otherwise. The ONLY sanctioned way for a host
 * to read a region's stage/currencies — reading `algorithm.stage` directly is
 * wrong for any params-dependent algorithm. Pure; never throws (implementors
 * fall back to the static role on malformed params). */
export function dagRoleFor(algorithm: ProcgenAlgorithm, params: Record<string, unknown>): DagRole {
  if (algorithm.dagRole) return algorithm.dagRole(params);
  return { stage: algorithm.stage, produces: algorithm.produces, consumes: algorithm.consumes };
}

// ─── Preset helpers — pure, host-agnostic ────────────────────────────────────
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

/** Params for adopting a region pinned at `fromVersion` into the current
 * contract: the algorithm's `migrateParams` when it defines one, identity
 * otherwise. Always returns a fresh object (callers persist it into a new
 * block). Pure — the ONLY sanctioned path from pinned-old params to
 * current-shape params. */
export function migrateParamsForAdoption(
  algorithm: ProcgenAlgorithm,
  fromVersion: number,
  params: Record<string, unknown>
): Record<string, unknown> {
  if (fromVersion >= algorithm.currentVersion || !algorithm.migrateParams) return { ...params };
  return algorithm.migrateParams(fromVersion, { ...params });
}
