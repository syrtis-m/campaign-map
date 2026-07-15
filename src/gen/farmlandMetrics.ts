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

/**
 * The spoke-fan metric (shortlist item 8): the longest DIAGONAL (non-axis-aligned)
 * straight run of any `farm-lane`, in units of the field-cell size. Gate lanes
 * used to ray straight across the whole belt to a distant junction; the tamed
 * design emits only a short diagonal STUB (clipped at the first field-cell
 * boundary) before following axis-aligned field edges. Axis-aligned runs (the
 * regular lane web + the gate lanes' edge-following legs) run ALONG field
 * boundaries, cross no cell interiors, and are excluded; only the diagonal stub
 * is measured. A farmland with no upstream city has no gate lanes ⇒ 0.
 *
 * `cellM` is the field-cell size (`fieldCellM(fieldSize)`); a run of length L is
 * `L / cellM` cells. Collinear consecutive segments are merged into one run so a
 * long diagonal split across vertices still counts once.
 */
export function maxDiagonalLaneRunCells(features: GeoJSON.Feature[], cellM: number): number {
  if (!(cellM > 0)) return 0;
  const AXIS_EPS_M = 1e-3; // a run with |Δx| or |Δy| below this hugs a gridline
  let maxCells = 0;
  for (const f of byGid(features, "farm-lane")) {
    const g = f.geometry;
    if (!g || g.type !== "LineString") continue;
    const c = g.coordinates as [number, number][];
    let i = 0;
    while (i + 1 < c.length) {
      // Extend the run while the next segment stays collinear + same-direction.
      const dirx0 = c[i + 1][0] - c[i][0];
      const diry0 = c[i + 1][1] - c[i][1];
      let end = i + 1;
      while (end + 1 < c.length) {
        const nx = c[end + 1][0] - c[end][0];
        const ny = c[end + 1][1] - c[end][1];
        const cross = dirx0 * ny - diry0 * nx;
        if (Math.abs(cross) < 1e-6 && dirx0 * nx + diry0 * ny > 0) end++;
        else break;
      }
      const rx = c[end][0] - c[i][0];
      const ry = c[end][1] - c[i][1];
      if (Math.abs(rx) > AXIS_EPS_M && Math.abs(ry) > AXIS_EPS_M) {
        const cells = Math.hypot(rx, ry) / cellM;
        if (cells > maxCells) maxCells = cells;
      }
      i = end;
    }
  }
  return maxCells;
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
