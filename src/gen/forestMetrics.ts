/**
 * Forest metrics — a PURE measurement pass over `generateForest` output:
 * how much of the region the canopy covers, how many clearings punch through
 * it, how dense the tree scatter is. Reads features + region only; never
 * generates, never mutates → zero generator bytes touched.
 *
 * `FOREST_BAND` is the tunable regression net (versioned-determinism policy):
 * a generous window around the committed golden, catching a canopy that
 * collapses or a tree scatter that vanishes without pinning exact bytes.
 */
import type { ProcgenRegion } from "./region";
import { byGid, polygonNetArea, holeCount, inBand } from "./metricsGeom";

export interface ForestMetrics {
  /** Canopy net area (exterior minus clearing holes) ÷ region area, 0–1. */
  canopyCoverFrac: number;
  /** Interior clearing holes punched through the canopy mass. */
  clearingHoleCount: number;
  /** Scattered individual trees (forest-tree points). */
  treeCount: number;

  canopyArea: number;
  regionArea: number;
}

export interface ForestBand {
  canopyCoverFrac: [number, number];
  clearingHoleCount: [number, number];
  treeCount: [number, number];
}

/** Band measured on the committed golden (broadleaf, density 0.7, seed 4242):
 * cover ≈ 0.91, holes = 2, trees = 246 — widened to a regression window. */
export const FOREST_BAND: ForestBand = {
  canopyCoverFrac: [0.6, 0.98],
  clearingHoleCount: [0, 10],
  treeCount: [120, 420],
};

export function computeForestMetrics(features: GeoJSON.Feature[], region: ProcgenRegion): ForestMetrics {
  const canopy = byGid(features, "forest-canopy");
  const canopyArea = canopy.reduce((a, f) => a + polygonNetArea(f), 0);
  const clearingHoleCount = canopy.reduce((n, f) => n + holeCount(f), 0);
  const treeCount = byGid(features, "forest-tree").length;

  return {
    canopyCoverFrac: region.area > 0 ? canopyArea / region.area : 0,
    clearingHoleCount,
    treeCount,
    canopyArea,
    regionArea: region.area,
  };
}

/** Every metric of `m` outside `band` (empty ⇒ all pass). */
export function forestBandViolations(m: ForestMetrics, band: ForestBand = FOREST_BAND): string[] {
  const out: string[] = [];
  const chk = (name: string, v: number, b: [number, number]): void => {
    if (!inBand(v, b)) out.push(`${name} ${v.toFixed(3)} ∉ [${b[0]}, ${b[1]}]`);
  };
  chk("canopyCoverFrac", m.canopyCoverFrac, band.canopyCoverFrac);
  chk("clearingHoleCount", m.clearingHoleCount, band.clearingHoleCount);
  chk("treeCount", m.treeCount, band.treeCount);
  return out;
}
