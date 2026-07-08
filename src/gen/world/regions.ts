import { hashSeed } from "../rng";
import type { BBox } from "../spatialHash";
import type { GenerationConstraints } from "../types";
import { generateVoronoiCells } from "../voronoiCells";
import { classifyBiome } from "./biomes";
import { heightAt, moistureAt } from "./heightmap";
import { WORLD_REGION_CELL_SIZE } from "./params";

/** `(seed, bbox, constraints) => Feature[]` — one Polygon per world region, tagged with its biome. */
export function generateWorldRegions(
  campaignSeed: number,
  bbox: BBox,
  constraints: GenerationConstraints
): GeoJSON.Feature[] {
  const cells = generateVoronoiCells(campaignSeed, bbox, WORLD_REGION_CELL_SIZE, "world-region-seed");

  const features: GeoJSON.Feature[] = cells.map((cell) => {
    const h = heightAt(campaignSeed, cell.site.x, cell.site.y, constraints.worldBounds);
    const m = moistureAt(campaignSeed, cell.site.x, cell.site.y);
    const biome = classifyBiome(h, m);
    return {
      type: "Feature",
      id: hashSeed(campaignSeed, cell.site.cellX, cell.site.cellY, "world-region"),
      geometry: { type: "Polygon", coordinates: [cell.ring] },
      properties: { generated: true, generatorId: "world-region", type: "nation/region", biome, height: h, moisture: m },
    };
  });

  features.sort((a, b) => {
    const ca = (a.geometry as GeoJSON.Polygon).coordinates[0][0];
    const cb = (b.geometry as GeoJSON.Polygon).coordinates[0][0];
    return ca[0] - cb[0] || ca[1] - cb[1];
  });
  return features;
}
