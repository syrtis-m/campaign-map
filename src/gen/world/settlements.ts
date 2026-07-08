import { hashSeed, mulberry32 } from "../rng";
import type { BBox } from "../spatialHash";
import type { GenerationConstraints } from "../types";
import { generateVoronoiCells } from "../voronoiCells";
import { classifyBiome, isLand } from "./biomes";
import { heightAt, moistureAt } from "./heightmap";
import { SETTLEMENT_SUITABILITY_THRESHOLD, WORLD_REGION_CELL_SIZE } from "./params";

export interface SettlementSite {
  x: number;
  y: number;
  cellX: number;
  cellY: number;
  tier: "city" | "town" | "village";
}

/**
 * Settlement placement is an independent per-region-site roll — no
 * spacing-aware greedy placement (which would be order-dependent and break
 * seams, same reasoning as streamline seeding). May occasionally cluster;
 * that's a Tier B aesthetic tuning question, not a Tier A blocker.
 */
export function settlementCandidates(
  campaignSeed: number,
  bbox: BBox,
  constraints: GenerationConstraints
): SettlementSite[] {
  const cells = generateVoronoiCells(campaignSeed, bbox, WORLD_REGION_CELL_SIZE, "world-region-seed");
  const out: SettlementSite[] = [];

  for (const cell of cells) {
    const h = heightAt(campaignSeed, cell.site.x, cell.site.y, constraints.worldBounds);
    const m = moistureAt(campaignSeed, cell.site.x, cell.site.y);
    const biome = classifyBiome(h, m);
    if (!isLand(biome) || biome === "mountains") continue;

    const rng = mulberry32(hashSeed(campaignSeed, cell.site.cellX, cell.site.cellY, "settlement"));
    const suitability = rng() * (1 - Math.abs(h - 0.5));
    if (suitability < SETTLEMENT_SUITABILITY_THRESHOLD) continue;

    const tierRoll = rng();
    const tier = tierRoll > 0.85 ? "city" : tierRoll > 0.55 ? "town" : "village";
    out.push({ x: cell.site.x, y: cell.site.y, cellX: cell.site.cellX, cellY: cell.site.cellY, tier });
  }

  out.sort((a, b) => a.x - b.x || a.y - b.y);
  return out;
}

/** `(seed, bbox, constraints) => Feature[]` — Point features, one per settlement whose site lies in `bbox`. */
export function generateSettlements(
  campaignSeed: number,
  bbox: BBox,
  constraints: GenerationConstraints
): GeoJSON.Feature[] {
  const candidates = settlementCandidates(campaignSeed, bbox, constraints).filter(
    (s) => s.x >= bbox.minX && s.x <= bbox.maxX && s.y >= bbox.minY && s.y <= bbox.maxY
  );

  const features: GeoJSON.Feature[] = candidates.map((s) => ({
    type: "Feature",
    id: hashSeed(campaignSeed, s.cellX, s.cellY, "settlement"),
    geometry: { type: "Point", coordinates: [s.x, s.y] },
    properties: { generated: true, generatorId: "world-settlement", type: s.tier },
  }));

  features.sort((a, b) => {
    const ca = (a.geometry as GeoJSON.Point).coordinates;
    const cb = (b.geometry as GeoJSON.Point).coordinates;
    return ca[0] - cb[0] || ca[1] - cb[1];
  });
  return features;
}
