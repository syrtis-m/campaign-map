/**
 * Voronoi districts, built on the shared seam-safe helper in
 * src/gen/voronoiCells.ts.
 */
import { hashSeed } from "../rng";
import type { BBox } from "../spatialHash";
import type { GenerationConstraints } from "../types";
import { generateVoronoiCells } from "../voronoiCells";

export { ensureClosedRing as ensureClosed } from "../voronoiCells";

export const DISTRICT_CELL_SIZE = 220;

/** `(seed, bbox, constraints) => Feature[]` — Polygon features, one per district. */
export function generateDistricts(
  campaignSeed: number,
  bbox: BBox,
  constraints: GenerationConstraints
): GeoJSON.Feature[] {
  const cells = generateVoronoiCells(campaignSeed, bbox, DISTRICT_CELL_SIZE, "district-seed");

  const features: GeoJSON.Feature[] = cells.map((cell) => ({
    type: "Feature",
    id: hashSeed(campaignSeed, cell.site.cellX, cell.site.cellY, "district"),
    geometry: { type: "Polygon", coordinates: [cell.ring] },
    properties: { generated: true, generatorId: "city-district", type: "district" },
  }));

  features.sort((a, b) => {
    const ca = (a.geometry as GeoJSON.Polygon).coordinates[0][0];
    const cb = (b.geometry as GeoJSON.Polygon).coordinates[0][0];
    return ca[0] - cb[0] || ca[1] - cb[1];
  });
  void constraints; // districts don't yet avoid canon geometry directly — blocks/footprints do
  return features;
}
