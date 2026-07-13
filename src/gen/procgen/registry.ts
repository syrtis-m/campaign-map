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
];

const cityAlgorithm: ProcgenAlgorithm = {
  id: "city",
  label: "City",
  appliesTo: ["district"],
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

/** v1 registers only `city`. Order matters for `algorithmForKind` (first
 * match wins) — keep the list explicit and small. */
const REGISTRY: readonly ProcgenAlgorithm[] = [cityAlgorithm];

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
