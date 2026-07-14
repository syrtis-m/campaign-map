/**
 * Mountain metrics — a PURE measurement pass over `generateMountain` output:
 * how many peaks crown the massif, how many contour rings wrap it, how dense
 * the hachure shading is. Reads features + region only; never generates, never
 * mutates → zero generator bytes touched.
 *
 * `MOUNTAIN_BAND` is the tunable regression net (versioned-determinism policy):
 * a generous window around the committed golden, catching contours or hachures
 * that thin out without pinning exact bytes.
 */
import type { ProcgenRegion } from "./region";
import { byGid, inBand } from "./metricsGeom";

export interface MountainMetrics {
  /** Local-maximum peak markers (mountain-peak points). */
  peakCount: number;
  /** Contour rings drawn around the elevation field. */
  contourCount: number;
  /** Hachure ticks per km² — the slope-shading density. */
  hachureDensityPerKm2: number;

  hachureCount: number;
  areaKm2: number;
}

export interface MountainBand {
  peakCount: [number, number];
  contourCount: [number, number];
  hachureDensityPerKm2: [number, number];
}

/** Band measured on the committed golden (alpine, amplitude 0.6, seed 4242, on
 * the 1200 m square): peaks = 29, contours = 84, hachure density ≈ 1311 /km² —
 * widened to a regression window. */
export const MOUNTAIN_BAND: MountainBand = {
  peakCount: [12, 55],
  contourCount: [40, 140],
  hachureDensityPerKm2: [700, 2200],
};

export function computeMountainMetrics(features: GeoJSON.Feature[], region: ProcgenRegion): MountainMetrics {
  const peakCount = byGid(features, "mountain-peak").length;
  const contourCount = byGid(features, "mountain-contour").length;
  const hachureCount = byGid(features, "mountain-hachure").length;
  const areaKm2 = region.area / 1e6;

  return {
    peakCount,
    contourCount,
    hachureDensityPerKm2: areaKm2 > 0 ? hachureCount / areaKm2 : 0,
    hachureCount,
    areaKm2,
  };
}

/** Every metric of `m` outside `band` (empty ⇒ all pass). */
export function mountainBandViolations(m: MountainMetrics, band: MountainBand = MOUNTAIN_BAND): string[] {
  const out: string[] = [];
  const chk = (name: string, v: number, b: [number, number]): void => {
    if (!inBand(v, b)) out.push(`${name} ${v.toFixed(1)} ∉ [${b[0]}, ${b[1]}]`);
  };
  chk("peakCount", m.peakCount, band.peakCount);
  chk("contourCount", m.contourCount, band.contourCount);
  chk("hachureDensityPerKm2", m.hachureDensityPerKm2, band.hachureDensityPerKm2);
  return out;
}
