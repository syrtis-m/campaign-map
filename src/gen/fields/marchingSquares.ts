/**
 * Marching squares over a point-evaluable scalar field (plan 023 §4.1) — the
 * shared iso-line / iso-band machinery. Pure/headless, D1–D6 binding: the only
 * inputs are the field (itself `f(x, y)` from durable inputs — plan 023 §0) and
 * a WORLD-ALIGNED lattice, so two callers sampling overlapping regions see
 * identical crossings on shared lattice edges → contours meet seam-free and the
 * output is byte-deterministic.
 *
 * Reusable by design (NOT mountain-private): plan 023-C's `mountain` contours
 * are the first consumer; plan 026-B's forest canopy will trace a density
 * field's single iso-level into closed rings with the SAME module. Hence the
 * return shape carries `closed` (a summit ring / canopy boundary vs. an open
 * contour that runs off the lattice) and closed loops are canonicalized to a
 * fixed start vertex + winding so a whole-artifact regenerate is byte-identical
 * (a closed loop has no natural first vertex — determinism rides entirely on
 * that canonicalization, adversarial-review 2026-07-14).
 *
 * Algorithm: sample the field on the world-aligned lattice ONCE (shared corners,
 * no double evaluation), then per cell per level classify corners above/below,
 * linearly interpolate crossings on the four edges, and connect them. Non-saddle
 * cells have 0 or 2 crossings (one segment); saddle cells (4 crossings) pair by
 * the cell-center average so the two segments never cross — a deterministic
 * closed-form choice, no RNG. Segments then stitch into polylines by
 * mm-quantized endpoint keys (crossings on a shared edge quantize identically →
 * they join).
 */
import type { BBox } from "../spatialHash";
import type { Field, Pt } from "./sdf";

/** A single traced iso-line at one level. `closed` ⇒ `points[0]` deep-equals
 * `points[points.length-1]` (a ring); open ⇒ the line runs off the lattice
 * bounds. Coordinates are mm-quantized. */
export interface Contour {
  level: number;
  points: Pt[];
  closed: boolean;
}

export interface MarchingSquaresOptions {
  /** Region of interest; the lattice is world-aligned and covers this bbox
   * (grown to the enclosing lattice cells). */
  bbox: BBox;
  /** World-aligned lattice spacing, meters. Lattice nodes sit at integer
   * multiples of `step` (like the costField / hachure lattices) so abutting
   * callers agree on shared samples. */
  step: number;
  /** Iso-values to trace. Order-independent (output is canonically sorted). */
  levels: readonly number[];
}

/** mm quantization (D5), matched to region.ts `q`. */
function q(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** Stable string key for a mm-quantized point (stitching adjacency). */
function key(p: Pt): string {
  return `${p[0]},${p[1]}`;
}

/** Lexicographic point compare (x then y) — the canonical tie-break used for
 * both start-vertex selection and winding. */
function ptLess(a: Pt, b: Pt): boolean {
  return a[0] !== b[0] ? a[0] < b[0] : a[1] < b[1];
}

interface Seg {
  a: Pt;
  b: Pt;
}

/**
 * Trace every requested iso-line of `field` over the world-aligned lattice.
 * Returns contours canonically sorted (by level, then first vertex) with
 * mm-quantized coordinates. Never throws: a degenerate bbox (fewer than 2
 * lattice nodes on an axis) simply yields no cells → `[]`.
 */
export function marchingSquares(field: Field, opts: MarchingSquaresOptions): Contour[] {
  const { bbox, step, levels } = opts;
  if (!(step > 0) || levels.length === 0) return [];

  // World-aligned lattice covering the bbox (inclusive on both ends).
  const ix0 = Math.floor(bbox.minX / step);
  const ix1 = Math.ceil(bbox.maxX / step);
  const iy0 = Math.floor(bbox.minY / step);
  const iy1 = Math.ceil(bbox.maxY / step);
  const nx = ix1 - ix0 + 1;
  const ny = iy1 - iy0 + 1;
  if (nx < 2 || ny < 2) return [];

  // Sample the field once per lattice node (shared corners). s[i][j] is the
  // value at world (x=(ix0+i)*step, y=(iy0+j)*step).
  const s: number[][] = [];
  for (let i = 0; i < nx; i++) {
    const col: number[] = new Array(ny);
    const x = (ix0 + i) * step;
    for (let j = 0; j < ny; j++) {
      col[j] = field(x, (iy0 + j) * step);
    }
    s[i] = col;
  }

  const out: Contour[] = [];
  for (const level of levels) {
    const segs = segmentsForLevel(s, ix0, iy0, nx, ny, step, level);
    for (const c of stitch(segs)) out.push({ level, points: c.points, closed: c.closed });
  }

  // Canonical order: level ascending, then first-vertex lexicographic. Stable
  // regardless of cell-scan / stitch order.
  out.sort((a, b) => {
    if (a.level !== b.level) return a.level - b.level;
    const pa = a.points[0];
    const pb = b.points[0];
    return pa[0] !== pb[0] ? pa[0] - pb[0] : pa[1] - pb[1];
  });
  return out;
}

/** All contour segments for one level, in deterministic cell-scan order. */
function segmentsForLevel(
  s: number[][],
  ix0: number,
  iy0: number,
  nx: number,
  ny: number,
  step: number,
  level: number
): Seg[] {
  const segs: Seg[] = [];
  for (let i = 0; i < nx - 1; i++) {
    for (let j = 0; j < ny - 1; j++) {
      // Corner values (CCW from bottom-left).
      const v0 = s[i][j]; // (i,   j)     bottom-left
      const v1 = s[i + 1][j]; // (i+1, j)     bottom-right
      const v2 = s[i + 1][j + 1]; // (i+1, j+1)   top-right
      const v3 = s[i][j + 1]; // (i,   j+1)   top-left

      // Fast skip: cell entirely above or below the level.
      const b0 = v0 >= level;
      const b1 = v1 >= level;
      const b2 = v2 >= level;
      const b3 = v3 >= level;
      if (b0 === b1 && b1 === b2 && b2 === b3) continue;

      // World coordinates of the cell corners.
      const x0 = (ix0 + i) * step;
      const y0 = (iy0 + j) * step;
      const x1 = x0 + step;
      const y1 = y0 + step;

      // Edge crossings (bottom, right, top, left). Each edge crosses iff its
      // two corners straddle the level; the crossing is the linear interpolant.
      const cross: Pt[] = [];
      if (b0 !== b1) cross.push([lerp(x0, x1, tCross(v0, v1, level)), y0]); // e0 bottom
      if (b1 !== b2) cross.push([x1, lerp(y0, y1, tCross(v1, v2, level))]); // e1 right
      if (b2 !== b3) cross.push([lerp(x1, x0, tCross(v2, v3, level)), y1]); // e2 top
      if (b3 !== b0) cross.push([x0, lerp(y1, y0, tCross(v3, v0, level))]); // e3 left

      if (cross.length === 2) {
        segs.push({ a: [q(cross[0][0]), q(cross[0][1])], b: [q(cross[1][0]), q(cross[1][1])] });
      } else if (cross.length === 4) {
        // Saddle: pair by the cell-center average so segments never cross.
        // cross[] here is [bottom, right, top, left]. center >= level connects
        // {bottom-right, top-left}; else {right-top, left-bottom}.
        const center = (v0 + v1 + v2 + v3) / 4;
        const [eB, eR, eT, eL] = cross;
        if (center >= level) {
          segs.push({ a: qp(eB), b: qp(eR) });
          segs.push({ a: qp(eT), b: qp(eL) });
        } else {
          segs.push({ a: qp(eR), b: qp(eT) });
          segs.push({ a: qp(eL), b: qp(eB) });
        }
      }
    }
  }
  return segs;
}

function qp(p: Pt): Pt {
  return [q(p[0]), q(p[1])];
}

/** Interpolation parameter where the level crosses the va→vb edge. */
function tCross(va: number, vb: number, level: number): number {
  const d = vb - va;
  if (d === 0) return 0.5; // straddle with equal values is impossible; defensive
  const t = (level - va) / d;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Stitch undirected segments into polylines by shared mm-quantized endpoints.
 * Open chains (an endpoint used once) are walked first from their
 * lexicographically-smallest free end; remaining segments form closed loops,
 * each canonicalized to start at its lex-min vertex with a fixed winding. Both
 * canonicalizations make the byte output independent of segment/scan order.
 */
function stitch(segs: Seg[]): { points: Pt[]; closed: boolean }[] {
  // Adjacency: point key → list of { segIndex, otherEnd }.
  const adj = new Map<string, { seg: number; other: Pt }[]>();
  const add = (p: Pt, seg: number, other: Pt): void => {
    const k = key(p);
    const list = adj.get(k);
    if (list) list.push({ seg, other });
    else adj.set(k, [{ seg, other }]);
  };
  for (let i = 0; i < segs.length; i++) {
    add(segs[i].a, i, segs[i].b);
    add(segs[i].b, i, segs[i].a);
  }

  const used = new Array<boolean>(segs.length).fill(false);
  const results: { points: Pt[]; closed: boolean }[] = [];

  const degree = (p: Pt): number => adj.get(key(p))?.length ?? 0;

  // Walk a chain from `start` following unused segments; returns the ordered
  // point list. Stops at a dead end (degree-1 vertex) or when it loops back.
  const walk = (start: Pt): Pt[] => {
    const pts: Pt[] = [start];
    let cur = start;
    for (;;) {
      const list = adj.get(key(cur));
      if (!list) break;
      let nextSeg = -1;
      let next: Pt | null = null;
      for (const e of list) {
        if (!used[e.seg]) {
          nextSeg = e.seg;
          next = e.other;
          break;
        }
      }
      if (nextSeg < 0 || !next) break;
      used[nextSeg] = true;
      pts.push(next);
      cur = next;
      if (key(cur) === key(start)) break; // closed
    }
    return pts;
  };

  // 1) Open chains: start at each degree-1 endpoint (sorted for determinism).
  const openStarts: Pt[] = [];
  for (const [k, list] of adj) {
    if (list.length === 1) {
      const [xs, ys] = k.split(",");
      openStarts.push([Number(xs), Number(ys)]);
    }
  }
  openStarts.sort((a, b) => (a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1]));
  for (const start of openStarts) {
    // A degree-1 vertex may already be consumed by an earlier chain's tail.
    const list = adj.get(key(start));
    if (!list || list.every((e) => used[e.seg])) continue;
    let pts = walk(start);
    if (pts.length < 2) continue;
    pts = orientOpen(pts);
    results.push({ points: pts, closed: false });
  }

  // 2) Closed loops: any segment still unused belongs to a cycle.
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    const pts = walk(segs[i].a);
    if (pts.length < 3) continue;
    results.push({ points: canonicalLoop(pts), closed: true });
  }

  return results;
}

/** Orient an open chain so its first endpoint is lex-≤ its last (deterministic
 * direction independent of which end the walk started from). */
function orientOpen(pts: Pt[]): Pt[] {
  const first = pts[0];
  const last = pts[pts.length - 1];
  return ptLess(last, first) ? [...pts].reverse() : pts;
}

/**
 * Canonicalize a closed loop: rotate so it starts at its lex-min vertex, and
 * choose the winding whose second vertex is the lex-smaller of the two
 * neighbors. Returns a closed ring (`first === last`).
 */
function canonicalLoop(pts: Pt[]): Pt[] {
  // The walk returns [start, ..., start]; drop the duplicated closing vertex.
  const open = pts.slice(0, -1);
  const n = open.length;
  // Find lex-min vertex index.
  let m = 0;
  for (let i = 1; i < n; i++) if (ptLess(open[i], open[m])) m = i;
  const prev = open[(m - 1 + n) % n];
  const next = open[(m + 1) % n];
  // Winding: step toward the lex-smaller neighbor.
  const forward = ptLess(next, prev);
  const rot: Pt[] = [];
  for (let k = 0; k < n; k++) {
    rot.push(open[forward ? (m + k) % n : (m - k + n) % n]);
  }
  rot.push(rot[0]); // re-close
  return rot;
}
