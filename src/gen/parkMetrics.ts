/**
 * Park metrics — a PURE measurement pass over `generatePark` output: how much
 * path threads the grounds, how much water sits in them, how many point
 * landmarks dot them. Reads features + region only; never generates, never
 * mutates → zero generator bytes touched.
 *
 * `PARK_BAND` is the tunable regression net (versioned-determinism policy): a
 * generous window around the committed golden, catching paths or water that
 * disappear without pinning exact bytes.
 */
import type { ProcgenRegion } from "./region";
import { byGid, totalLineLength, polygonNetArea, inBand } from "./metricsGeom";

export interface ParkMetrics {
  /** Total path length ÷ √(region area) — a scale-free "how threaded". */
  pathLengthPerSpan: number;
  /** Pond net area ÷ region area, 0–1. */
  waterShare: number;
  /** Point landmarks (fountains, lanterns, teahouses, …). */
  pointCount: number;

  pathLength: number;
  pondArea: number;
  regionArea: number;
}

export interface ParkBand {
  pathLengthPerSpan: [number, number];
  waterShare: [number, number];
  pointCount: [number, number];
}

/** Band measured on the committed golden (japanese-garden, seed 4242):
 * pathLengthPerSpan ≈ 2.04, waterShare ≈ 0.072, points = 7 — widened. */
export const PARK_BAND: ParkBand = {
  pathLengthPerSpan: [0.8, 3.6],
  waterShare: [0.02, 0.18],
  pointCount: [2, 20],
};

export function computeParkMetrics(features: GeoJSON.Feature[], region: ProcgenRegion): ParkMetrics {
  const pathLength = totalLineLength(byGid(features, "park-path"));
  const pondArea = byGid(features, "park-pond").reduce((a, f) => a + polygonNetArea(f), 0);
  const pointCount = byGid(features, "park-point").length;
  const span = Math.sqrt(region.area);

  return {
    pathLengthPerSpan: span > 0 ? pathLength / span : 0,
    waterShare: region.area > 0 ? pondArea / region.area : 0,
    pointCount,
    pathLength,
    pondArea,
    regionArea: region.area,
  };
}

/** Every metric of `m` outside `band` (empty ⇒ all pass). */
export function parkBandViolations(m: ParkMetrics, band: ParkBand = PARK_BAND): string[] {
  const out: string[] = [];
  const chk = (name: string, v: number, b: [number, number]): void => {
    if (!inBand(v, b)) out.push(`${name} ${v.toFixed(3)} ∉ [${b[0]}, ${b[1]}]`);
  };
  chk("pathLengthPerSpan", m.pathLengthPerSpan, band.pathLengthPerSpan);
  chk("waterShare", m.waterShare, band.waterShare);
  chk("pointCount", m.pointCount, band.pointCount);
  return out;
}
