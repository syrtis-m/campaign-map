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

// ── Riverine rang composition (plan 038 item 2, v7 REACH rewrite) ─────────────
// Three measurements that prove the rang reads as coherent parallel blocks, not
// the pre-v7 per-sample fan (Jonah, Vailmarch Marnside):
//   (1) per-reach orientation spread ≈ 0 — every lot in a river REACH shares one
//       inland normal, so their long axes are parallel within the reach;
//   (2) zero strip-strip overlap — lots never cross (parallel side edges +
//       monotone frontage), so no two bankLots cover the same ground;
//   (3) zero lattice overlap — the grid fields inside the band are suppressed, so
//       no ambient field paints through the strips.
// All read `bankLot` / `reach` feature tags only — pure measurement, zero bytes.

type Pt = [number, number];

/** The `bankLot` rang lots (v7 riverine long-lots). */
function bankLots(features: GeoJSON.Feature[]): GeoJSON.Feature[] {
  return features.filter((f) => (f.properties as { bankLot?: boolean } | null)?.bankLot === true);
}

/** Long-axis orientation of a 4-corner (+closing) lot, as an angle in [0, π)
 * (mod π — a lot and its 180°-flip share an orientation). */
function lotOrientation(f: GeoJSON.Feature): number {
  const r = (f.geometry as GeoJSON.Polygon).coordinates[0] as Pt[];
  const e1: Pt = [r[1][0] - r[0][0], r[1][1] - r[0][1]];
  const e3: Pt = [r[3][0] - r[0][0], r[3][1] - r[0][1]];
  const e = Math.hypot(e1[0], e1[1]) >= Math.hypot(e3[0], e3[1]) ? e1 : e3;
  let a = Math.atan2(e[1], e[0]);
  if (a < 0) a += Math.PI;
  return a;
}

/** Ray-cast point-in-polygon on a feature's outer ring. */
function pointInField(f: GeoJSON.Feature, x: number, y: number): boolean {
  const r = (f.geometry as GeoJSON.Polygon).coordinates[0] as Pt[];
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const xi = r[i][0];
    const yi = r[i][1];
    const xj = r[j][0];
    const yj = r[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Max WITHIN-REACH long-axis orientation spread (radians) over all rang lots —
 * grouped by the `reach` tag. ≈ 0 when every lot in a reach is parallel (the v7
 * contract). No bankLots ⇒ 0. Cross-reach differences (a bank bend changes the
 * range's heading) are deliberately NOT measured — the fan bug was WITHIN a
 * reach, and rangs genuinely re-orient at bends.
 */
export function rangReachOrientationSpread(features: GeoJSON.Feature[]): number {
  const byReach = new Map<number, number[]>();
  for (const f of bankLots(features)) {
    const r = (f.properties as { reach?: number } | null)?.reach;
    if (r === undefined) continue;
    if (!byReach.has(r)) byReach.set(r, []);
    byReach.get(r)!.push(lotOrientation(f));
  }
  let worst = 0;
  for (const angles of byReach.values()) {
    for (let i = 0; i < angles.length; i++) {
      for (let k = i + 1; k < angles.length; k++) {
        let d = Math.abs(angles[i] - angles[k]);
        if (d > Math.PI / 2) d = Math.PI - d;
        if (d > worst) worst = d;
      }
    }
  }
  return worst;
}

export interface RangOverlapAreas {
  /** Ground (m²) covered by ≥ 2 rang lots — strip-strip overlap. */
  selfOverlap: number;
  /** Ground (m²) covered by a rang lot AND an ambient lattice field. */
  latticeOverlap: number;
  /** Ground (m²) covered by at least one rang lot (the band footprint). */
  bandArea: number;
}

/**
 * Sampled overlap areas over the region bbox (a `step`-metre grid). The rang band
 * should carry ZERO self-overlap and ZERO lattice overlap (v7); a small residual
 * self-overlap can occur only in the seam wedge where two reaches re-orient — the
 * caller bands it generously, never asserting bit-zero on the sampled area.
 */
export function rangOverlapAreas(features: GeoJSON.Feature[], region: ProcgenRegion, step = 4): RangOverlapAreas {
  const lots = bankLots(features);
  const lattice = features.filter(
    (f) =>
      (f.properties as { generatorId?: string; bankLot?: boolean } | null)?.generatorId === "farm-field" &&
      (f.properties as { bankLot?: boolean } | null)?.bankLot !== true
  );
  const { minX, minY, maxX, maxY } = region.bbox;
  const cellArea = step * step;
  let selfOverlap = 0;
  let latticeOverlap = 0;
  let bandArea = 0;
  for (let x = minX; x <= maxX; x += step) {
    for (let y = minY; y <= maxY; y += step) {
      let nb = 0;
      for (const f of lots) {
        if (pointInField(f, x, y)) {
          nb++;
          if (nb > 1) break;
        }
      }
      if (nb === 0) continue;
      bandArea += cellArea;
      if (nb > 1) selfOverlap += cellArea;
      for (const f of lattice) {
        if (pointInField(f, x, y)) {
          latticeOverlap += cellArea;
          break;
        }
      }
    }
  }
  return { selfOverlap, latticeOverlap, bandArea };
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
