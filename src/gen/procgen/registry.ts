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

export interface ProcgenAlgorithm {
  id: string; // "city"
  label: string; // "City"
  appliesTo: readonly FabricKind[]; // ["district"]
  paramsSchema: z.ZodType<Record<string, unknown>>;
  /** Theme-appropriate defaults for a fresh region (e.g. parchment →
   * euro-medieval), shown pre-filled in the host's params form. */
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
});

const cityAlgorithm: ProcgenAlgorithm = {
  id: "city",
  label: "City",
  appliesTo: ["district"],
  paramsSchema: cityParamsSchema as unknown as z.ZodType<Record<string, unknown>>,
  defaultParams(themeId: string): Record<string, unknown> {
    return { profile: defaultProfileForTheme(themeId) };
  },
  tileGeneratorIds: DOMAIN_TILE_GENERATOR_IDS,
  generate(seed, region, params, constraints): GeoJSON.Feature[] {
    const { profile } = cityParamsSchema.parse(params);
    return generateCityNetwork(seed, region, profile, constraints);
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
