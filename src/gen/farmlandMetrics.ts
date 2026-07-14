/**
 * Farmland metrics — a PURE measurement pass over `generateFarmland` output:
 * how many fields the patchwork is split into, and how much lane threads
 * between them. Reads features + region only; never generates, never mutates →
 * zero generator bytes touched.
 *
 * `FARMLAND_BAND` is the tunable regression net (versioned-determinism policy):
 * a generous window around the committed golden, catching a field split or lane
 * network that collapses without pinning exact bytes.
 */
import type { ProcgenRegion } from "./region";
import { byGid, totalLineLength, inBand } from "./metricsGeom";

export interface FarmlandMetrics {
  /** Enclosed fields (farm-field polygons). */
  fieldCount: number;
  /** Total lane length ÷ √(region area) — a scale-free "how laced with lanes". */
  laneLengthPerSpan: number;

  laneLength: number;
  regionArea: number;
}

export interface FarmlandBand {
  fieldCount: [number, number];
  laneLengthPerSpan: [number, number];
}

/** Band measured on the committed golden (enclosed-patchwork, fieldSize 0.5,
 * seed 4242): fields = 231, laneLengthPerSpan ≈ 12.0 — widened. */
export const FARMLAND_BAND: FarmlandBand = {
  fieldCount: [100, 400],
  laneLengthPerSpan: [5, 20],
};

export function computeFarmlandMetrics(features: GeoJSON.Feature[], region: ProcgenRegion): FarmlandMetrics {
  const fieldCount = byGid(features, "farm-field").length;
  const laneLength = totalLineLength(byGid(features, "farm-lane"));
  const span = Math.sqrt(region.area);

  return {
    fieldCount,
    laneLengthPerSpan: span > 0 ? laneLength / span : 0,
    laneLength,
    regionArea: region.area,
  };
}

/** Every metric of `m` outside `band` (empty ⇒ all pass). */
export function farmlandBandViolations(m: FarmlandMetrics, band: FarmlandBand = FARMLAND_BAND): string[] {
  const out: string[] = [];
  const chk = (name: string, v: number, b: [number, number]): void => {
    if (!inBand(v, b)) out.push(`${name} ${v.toFixed(2)} ∉ [${b[0]}, ${b[1]}]`);
  };
  chk("fieldCount", m.fieldCount, band.fieldCount);
  chk("laneLengthPerSpan", m.laneLengthPerSpan, band.laneLengthPerSpan);
  return out;
}
