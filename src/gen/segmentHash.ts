/**
 * Segment spatial hash — nearest-point-on-polyline in O(local segments) instead
 * of O(all segments). Plan 036 BINDING: every polyline-keyed terrain stamp/carve
 * (ridge/valley relief, river carve) queries the sketched spine through this
 * hash, NEVER a naive scan over the whole polyline — a continental river spine is
 * thousands of segments and a naive nearest-point over it is ~1e9 ops per lattice
 * fill (the cold-carve blow-up the plan calls out).
 *
 * Pure/headless, point-evaluable, deterministic: the answer at (x,y) is a pure
 * function of the polyline + query — no global pass, no scan order, so it composes
 * into `terrainAt` the same way every other field does. The nearest DISTANCE and
 * its gradient are byte-identical to a naive scan (the hash only prunes which
 * segments are tested); a shared self-test asserts that equivalence.
 *
 * Bins each segment into every uniform grid cell its bbox overlaps; a query
 * spirals outward ring-by-ring from the query cell and stops as soon as the
 * closest possible point in the next ring is farther than the best found so far
 * (the standard grid-nearest early-out). `segmentTests` counts the exact segments
 * distance-tested for the LAST query — the perf-budget counter plan 036-B gates
 * (`segment tests per sample ≤ bound`).
 */
import type { BBox } from "./spatialHash";

type Pt = [number, number];

/** Nearest-point answer: the distance (meters) and the UNIT gradient of that
 * distance — the direction from the nearest point on the line toward (x,y),
 * which is exactly ∇(distance) away from the line. Zero-length answer at dist 0
 * (on the line) reports a zero gradient (the kink is not differentiable). */
export interface NearestResult {
  dist: number;
  gradX: number;
  gradY: number;
  /** Index of the nearest segment (0-based; the segment from vertex i to i+1).
   * −1 for an empty polyline. */
  segIndex: number;
  /** Projection parameter along that segment, clamped to [0,1] — so the nearest
   * point is `lerp(vertex[segIndex], vertex[segIndex+1], t)`. Lets a caller
   * interpolate a per-vertex profile (the river bed) at the nearest point. */
  t: number;
}

export interface SegmentHashOptions {
  /** Grid cell size (meters). Pick ~ the stamp's influence band so a query
   * touches O(1) cells; too small ⇒ many empty rings, too large ⇒ many
   * segments per cell. Defaults to 128 m. */
  cellSize?: number;
}

interface Seg {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  /** Index of this segment (from vertex `idx` to `idx+1`). */
  idx: number;
}

/** Distance² + the raw (unnormalized) offset vector from the nearest point on a
 * segment to (x,y). Byte-identical arithmetic to `sdf.ts#distanceToPolyline`'s
 * per-segment body (projection clamp), so the hash's nearest DISTANCE matches a
 * naive scan to the float. */
function segNearest(s: Seg, x: number, y: number): { d2: number; ox: number; oy: number; t: number } {
  const dx = s.bx - s.ax;
  const dy = s.by - s.ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - s.ax) * dx + (y - s.ay) * dy) / l2));
  const px = s.ax + t * dx;
  const py = s.ay + t * dy;
  const ox = x - px;
  const oy = y - py;
  return { d2: ox * ox + oy * oy, ox, oy, t };
}

export class SegmentHash {
  private readonly cellSize: number;
  private readonly cells = new Map<string, Seg[]>();
  private readonly segs: Seg[] = [];
  readonly bounds: BBox;
  /** Segments distance-tested during the most recent `nearest` call. */
  segmentTests = 0;

  constructor(line: Pt[], opts: SegmentHashOptions = {}) {
    this.cellSize = Math.max(1, opts.cellSize ?? 128);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < line.length - 1; i++) {
      const seg: Seg = { ax: line[i][0], ay: line[i][1], bx: line[i + 1][0], by: line[i + 1][1], idx: i };
      this.segs.push(seg);
      const c0x = Math.floor(Math.min(seg.ax, seg.bx) / this.cellSize);
      const c1x = Math.floor(Math.max(seg.ax, seg.bx) / this.cellSize);
      const c0y = Math.floor(Math.min(seg.ay, seg.by) / this.cellSize);
      const c1y = Math.floor(Math.max(seg.ay, seg.by) / this.cellSize);
      for (let cy = c0y; cy <= c1y; cy++) {
        for (let cx = c0x; cx <= c1x; cx++) {
          const key = `${cx}:${cy}`;
          let bucket = this.cells.get(key);
          if (!bucket) this.cells.set(key, (bucket = []));
          bucket.push(seg);
        }
      }
      minX = Math.min(minX, seg.ax, seg.bx);
      minY = Math.min(minY, seg.ay, seg.by);
      maxX = Math.max(maxX, seg.ax, seg.bx);
      maxY = Math.max(maxY, seg.ay, seg.by);
    }
    this.bounds = Number.isFinite(minX) ? { minX, minY, maxX, maxY } : { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }

  get segmentCount(): number {
    return this.segs.length;
  }

  /**
   * Nearest distance from (x,y) to the polyline + the unit gradient of that
   * distance. Spirals cells outward from the query cell, distance-testing each
   * segment at most once per query (a `tested` set dedups a segment binned into
   * several cells), and stops when the nearest cell ring can no longer beat the
   * current best. Empty polyline ⇒ +Infinity distance, zero gradient.
   */
  nearest(x: number, y: number): NearestResult {
    this.segmentTests = 0;
    if (this.segs.length === 0) return { dist: Infinity, gradX: 0, gradY: 0, segIndex: -1, t: 0 };
    const cx = Math.floor(x / this.cellSize);
    const cy = Math.floor(y / this.cellSize);
    let bestD2 = Infinity;
    let bestOx = 0;
    let bestOy = 0;
    let bestIdx = -1;
    let bestT = 0;
    const tested = new Set<Seg>();
    const consider = (seg: Seg): void => {
      if (tested.has(seg)) return;
      tested.add(seg);
      this.segmentTests++;
      const r = segNearest(seg, x, y);
      if (r.d2 < bestD2) {
        bestD2 = r.d2;
        bestOx = r.ox;
        bestOy = r.oy;
        bestIdx = seg.idx;
        bestT = r.t;
      }
    };
    // Ring 0 is the query cell; each subsequent ring is the square shell at
    // Chebyshev radius `ring`. The closest any point in ring `ring` can be is
    // `(ring - 1) * cellSize` from the query point (the near edge of the shell),
    // so once that lower bound exceeds the best distance found, no farther ring
    // can improve it. A hard cap (grid diagonal) guarantees termination for a
    // query outside the populated area.
    const maxRing =
      Math.ceil(
        (Math.max(this.bounds.maxX - this.bounds.minX, this.bounds.maxY - this.bounds.minY) +
          Math.max(Math.abs(x), Math.abs(y))) /
          this.cellSize
      ) + 2;
    for (let ring = 0; ring <= maxRing; ring++) {
      if (ring > 0) {
        const lower = (ring - 1) * this.cellSize;
        if (lower * lower > bestD2) break;
      }
      if (ring === 0) {
        const bucket = this.cells.get(`${cx}:${cy}`);
        if (bucket) for (const seg of bucket) consider(seg);
        continue;
      }
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dy = -ring; dy <= ring; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue; // shell only
          const bucket = this.cells.get(`${cx + dx}:${cy + dy}`);
          if (bucket) for (const seg of bucket) consider(seg);
        }
      }
    }
    if (bestD2 === Infinity) return { dist: Infinity, gradX: 0, gradY: 0, segIndex: -1, t: 0 };
    // Math.hypot (not sqrt(d2)) so the distance is byte-identical to
    // `sdf.ts#distanceToPolyline`'s per-segment `Math.hypot` — the hash prunes
    // which segments are tested, never the arithmetic.
    const dist = Math.hypot(bestOx, bestOy);
    if (dist === 0) return { dist: 0, gradX: 0, gradY: 0, segIndex: bestIdx, t: bestT };
    return { dist, gradX: bestOx / dist, gradY: bestOy / dist, segIndex: bestIdx, t: bestT };
  }
}
