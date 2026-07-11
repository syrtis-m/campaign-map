/**
 * Voronoi districts, built on the shared seam-safe helper in
 * src/gen/voronoiCells.ts.
 */
import { hashSeed } from "../rng";
import type { BBox } from "../spatialHash";
import type { GenerationConstraints } from "../types";
import { generateVoronoiCells } from "../voronoiCells";
import { blockedByWater, indexFabricConstraints, insideSketchedDistrict } from "../fabricConstraints";

export { ensureClosedRing as ensureClosed } from "../voronoiCells";

export const DISTRICT_CELL_SIZE = 220;

/** `(seed, bbox, constraints) => Feature[]` — Polygon features, one per district. */
export function generateDistricts(
  campaignSeed: number,
  bbox: BBox,
  constraints: GenerationConstraints
): GeoJSON.Feature[] {
  const cells = generateVoronoiCells(campaignSeed, bbox, DISTRICT_CELL_SIZE, "district-seed");

  // Sketched fabric constrains districts (plan 019 Phase 3): a cell whose
  // SITE lands in water or inside a GM-drawn district polygon is dropped —
  // the GM has claimed that ground. Site-keyed, so the decision is identical
  // on every tile that sees the site (halo included) — seam-safe.
  const fabric = indexFabricConstraints(constraints.fabricFeatures);
  const kept = cells.filter(
    (cell) =>
      !blockedByWater(fabric, cell.site.x, cell.site.y) &&
      !insideSketchedDistrict(fabric, cell.site.x, cell.site.y)
  );

  const features: GeoJSON.Feature[] = kept.map((cell) => ({
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
  return features;
}
