import type { BBox } from "../spatialHash";
import type { GenerationConstraints } from "../types";
import { generateWorldRegions } from "./regions";
import { generateSettlements } from "./settlements";
import { generateRoutes } from "./routes";

export { generateWorldRegions } from "./regions";
export { generateSettlements, settlementCandidates } from "./settlements";
export { generateRoutes } from "./routes";
export { heightAt, moistureAt } from "./heightmap";
export { classifyBiome, isLand, type Biome } from "./biomes";

/** Combines regions + settlements + routes into one tile's worth of world fabric. */
export function generateWorld(
  campaignSeed: number,
  bbox: BBox,
  constraints: GenerationConstraints
): GeoJSON.Feature[] {
  return [
    ...generateWorldRegions(campaignSeed, bbox, constraints),
    ...generateSettlements(campaignSeed, bbox, constraints),
    ...generateRoutes(campaignSeed, bbox, constraints),
  ];
}
