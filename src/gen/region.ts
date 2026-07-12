/**
 * Procgen regions (plan 020 §4): the polygonal replacement for the v3 city
 * disc. A ProcgenRegion is built once per generation run from a sketched
 * fabric polygon (converted to generation-space meters by the host) and
 * threaded through the whole pipeline as the container of ALL generated
 * output — nothing spills past the GM's line.
 *
 * Determinism argument (procgen_v3_design.md §4, restated for regions in
 * plan 020 §7):
 *  - D4: everything here is closed-form arithmetic (products, divisions,
 *    Math.hypot/sqrt) on the mm-quantized ring. The ONLY trig lives in
 *    `boundaryPointAt`/`boundaryPointFrom` direction vectors, which is
 *    sampling — no topology decision compares trig output for equality.
 *  - D5: the ring is quantized to the millimeter at ingest; every derived
 *    coordinate this module emits (centroid, boundary crossings, inset
 *    vertices) is mm-quantized before it leaves.
 *  - `maxInteriorDistance`/`interiorPole` come from a deterministic
 *    world-anchored 10 m lattice over the bbox restricted to contained
 *    points (coarse but pure — robust for concave polygons where
 *    polar-from-centroid breaks). APPROXIMATION: the true pole can sit up to
 *    half a lattice diagonal (~7 m) from a sample, so `maxInteriorDistance`
 *    slightly UNDERESTIMATES the true value and `interiorT` can dip a hair
 *    below 0 at the very deepest interior. Callers treat interiorT as
 *    "0-ish deep inside, 1 at boundary, >1 outside" — never as exact.
 *    Argmax tie-break: lattice points are scanned y-ascending then
 *    x-ascending with a strict `>` improvement test, so the lowest-y (then
 *    lowest-x) point of any tie wins — scan order can never leak.
 */
import type { BBox } from "./spatialHash";

type Pt = [number, number];

/** D5 coordinate quantization: millimeter lattice. */
function q(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** World-anchored lattice spacing for the interior-distance scan, meters. */
export const INTERIOR_LATTICE_M = 10;
/** Area clamp (plan 020 §4): below the useful minimum / the perf valve —
 * mirrors the old 150–2500 m radius envelope. */
export const REGION_MIN_AREA_M2 = Math.PI * 150 * 150;
export const REGION_MAX_AREA_M2 = Math.PI * 2500 * 2500;
/** Miter clamp for `insetRing`: a vertex may move at most this many insets. */
export const INSET_MITER_LIMIT = 4;
/** Bounded fallback halvings when an inset degenerates (never throw). */
export const INSET_MAX_FALLBACKS = 3;

export interface ProcgenRegion {
  /** Fabric feature id (or a shim id during the v4.0/v4.1 transition). */
  id: string;
  /** Closed polygon ring (first === last), gen-space meters, mm-quantized,
   * normalized CCW (positive shoelace) so inward normals are well-defined. */
  ring: Pt[];
  bbox: BBox;
  /** Area centroid (closed-form shoelace centroid), mm-quantized. May lie
   * OUTSIDE the ring for concave polygons — see `generationCenter`. */
  centroid: Pt;
  /** |signed shoelace area|, m². */
  area: number;
  /** sqrt(area/π) — replaces the disc `radius` in size-scaled parameters. */
  effectiveRadius: number;
  /** Max distanceToBoundary over the contained 10 m lattice (see module
   * JSDoc for the approximation + tie-break). Always > 0. */
  maxInteriorDistance: number;
  /** The lattice argmax of distanceToBoundary — a guaranteed-interior
   * "deepest point", used as the generation center when the centroid falls
   * outside a concave ring. mm-quantized (lattice points are integral). */
  interiorPole: Pt;
}

/** Open ring (closing vertex stripped) — every loop here iterates open. */
function openRing(ring: Pt[]): Pt[] {
  if (ring.length >= 2) {
    const a = ring[0];
    const b = ring[ring.length - 1];
    if (a[0] === b[0] && a[1] === b[1]) return ring.slice(0, -1);
  }
  return ring;
}

/** Signed shoelace area (positive = CCW) of an open ring. */
function signedArea(open: Pt[]): number {
  let a = 0;
  for (let i = 0; i < open.length; i++) {
    const [px, py] = open[i];
    const [qx, qy] = open[(i + 1) % open.length];
    a += px * qy - qx * py;
  }
  return a / 2;
}

/**
 * Build a region from a polygon ring. Ingest normalization (all
 * deterministic): mm-quantize every vertex, drop consecutive duplicates,
 * close the ring, and orient CCW (reverse if the signed area is negative) so
 * `insetRing`'s inward normals are consistent. Never throws — validation is
 * `validateRegionRing`'s job (host-side); this constructor does its best
 * with what it is given.
 */
export function makeRegion(id: string, ring: Pt[]): ProcgenRegion {
  // Quantize + dedupe consecutive vertices.
  const quantized: Pt[] = [];
  for (const [x, y] of openRing(ring)) {
    const p: Pt = [q(x), q(y)];
    const last = quantized[quantized.length - 1];
    if (last && last[0] === p[0] && last[1] === p[1]) continue;
    quantized.push(p);
  }
  // Also drop a duplicated first-vertex at the end after quantization.
  if (quantized.length >= 2) {
    const a = quantized[0];
    const b = quantized[quantized.length - 1];
    if (a[0] === b[0] && a[1] === b[1]) quantized.pop();
  }

  let open = quantized;
  const sArea = signedArea(open);
  if (sArea < 0) open = [...open].reverse(); // normalize CCW
  const area = Math.abs(sArea);

  const bbox: BBox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const [x, y] of open) {
    if (x < bbox.minX) bbox.minX = x;
    if (y < bbox.minY) bbox.minY = y;
    if (x > bbox.maxX) bbox.maxX = x;
    if (y > bbox.maxY) bbox.maxY = y;
  }

  // Closed-form area centroid: (1/6A) Σ (p+q)·cross(p,q).
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < open.length; i++) {
    const [px, py] = open[i];
    const [qx, qy] = open[(i + 1) % open.length];
    const cross = px * qy - qx * py;
    cx += (px + qx) * cross;
    cy += (py + qy) * cross;
  }
  const a6 = 6 * signedArea(open); // recompute on the (possibly reversed) ring
  const centroid: Pt =
    a6 !== 0
      ? [q(cx / a6), q(cy / a6)]
      : [q((bbox.minX + bbox.maxX) / 2), q((bbox.minY + bbox.maxY) / 2)]; // degenerate fallback

  const closed: Pt[] = [...open, open[0]];
  const effectiveRadius = Math.sqrt(area / Math.PI);

  const region: ProcgenRegion = {
    id,
    ring: closed,
    bbox,
    centroid,
    area,
    effectiveRadius,
    maxInteriorDistance: 0, // filled below (needs ring/bbox in place)
    interiorPole: centroid,
  };

  // Interior-distance scan on the world-anchored 10 m lattice (module JSDoc:
  // approximation + lowest-y-then-lowest-x tie-break via strict `>`).
  let maxD = 0;
  let pole: Pt | null = null;
  const x0 = Math.ceil(bbox.minX / INTERIOR_LATTICE_M) * INTERIOR_LATTICE_M;
  const y0 = Math.ceil(bbox.minY / INTERIOR_LATTICE_M) * INTERIOR_LATTICE_M;
  for (let y = y0; y <= bbox.maxY; y += INTERIOR_LATTICE_M) {
    for (let x = x0; x <= bbox.maxX; x += INTERIOR_LATTICE_M) {
      if (!regionContains(region, x, y)) continue;
      const d = distanceToRingBoundary(closed, x, y);
      if (d > maxD) {
        maxD = d;
        pole = [x, y];
      }
    }
  }
  if (pole) {
    region.maxInteriorDistance = maxD;
    region.interiorPole = [q(pole[0]), q(pole[1])];
  } else {
    // Degenerate (region thinner than the lattice / smaller than validation
    // allows — only reachable through unvalidated test input): fall back to
    // the centroid's boundary distance, floored so interiorT never divides
    // by zero. Deterministic, documented, never thrown.
    region.maxInteriorDistance = Math.max(distanceToBoundary(region, centroid[0], centroid[1]), 1e-6);
    region.interiorPole = centroid;
  }
  return region;
}

/** Even-odd ray cast (same predicate family as fabricConstraints.pointInRing). */
export function regionContains(r: ProcgenRegion, x: number, y: number): boolean {
  const ring = r.ring;
  let inside = false;
  // Iterate the open portion: ring is closed, so stop before the closure.
  for (let i = 0, j = ring.length - 2; i < ring.length - 1; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Min distance from a point to any boundary segment of a closed ring. */
function distanceToRingBoundary(closed: Pt[], x: number, y: number): number {
  let best = Infinity;
  for (let i = 0; i < closed.length - 1; i++) {
    const [ax, ay] = closed[i];
    const [bx, by] = closed[i + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
    const d = Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
    if (d < best) best = d;
  }
  return best;
}

/** Exact per-segment distance to the region boundary, signed: positive
 * inside, negative outside (plan 020 §4). */
export function distanceToBoundary(r: ProcgenRegion, x: number, y: number): number {
  const d = distanceToRingBoundary(r.ring, x, y);
  return regionContains(r, x, y) ? d : -d;
}

/**
 * Interior parameter: ~0 at the deepest interior, 1 at the boundary, >1
 * outside — `1 − distanceToBoundary / maxInteriorDistance`. Replaces the
 * disc's `|p − center| / radius`. Can dip slightly below 0 near the true
 * pole (lattice approximation, module JSDoc) — callers must not assume ≥ 0.
 */
export function interiorT(r: ProcgenRegion, x: number, y: number): number {
  return 1 - distanceToBoundary(r, x, y) / r.maxInteriorDistance;
}

/**
 * First ray/boundary crossing from `(ox, oy)` toward `angle` (radians). The
 * direction vector is the module's only trig (D4 sampling); the crossing
 * itself is a closed-form line/segment solve, mm-quantized (D5). Ties (ray
 * through a vertex shared by two segments) resolve to the smaller ray
 * parameter, then the smaller segment index — total order. Returns null when
 * the ray never crosses the boundary (origin outside, aimed away).
 */
export function boundaryPointFrom(r: ProcgenRegion, ox: number, oy: number, angle: number): Pt | null {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const ring = r.ring;
  let bestT = Infinity;
  let best: Pt | null = null;
  for (let i = 0; i < ring.length - 1; i++) {
    const [ax, ay] = ring[i];
    const [bx, by] = ring[i + 1];
    const ex = bx - ax;
    const ey = by - ay;
    const denom = dx * ey - dy * ex;
    if (denom === 0) continue; // parallel — vertex-crossing ties go to the neighbor segment
    const t = ((ax - ox) * ey - (ay - oy) * ex) / denom;
    const u = ((ax - ox) * dy - (ay - oy) * dx) / denom;
    if (t <= 1e-9 || u < 0 || u > 1) continue;
    if (t < bestT) {
      bestT = t;
      best = [q(ox + t * dx), q(oy + t * dy)];
    }
  }
  return best;
}

/**
 * First ray/boundary crossing from the CENTROID at `angle`. Null when the
 * centroid lies outside the ring (possible for concave polygons) — callers
 * must handle null; `generationCenter` + `boundaryPointFrom` is the concave
 * fallback path.
 */
export function boundaryPointAt(r: ProcgenRegion, angle: number): Pt | null {
  if (!regionContains(r, r.centroid[0], r.centroid[1])) return null;
  return boundaryPointFrom(r, r.centroid[0], r.centroid[1], angle);
}

/**
 * The point generation treats as "the center": the area centroid when it is
 * contained, else the interior pole (deepest contained lattice point — the
 * deterministic concave fallback, plan-020 §6 brief). Always inside.
 */
export function generationCenter(r: ProcgenRegion): Pt {
  return regionContains(r, r.centroid[0], r.centroid[1]) ? r.centroid : r.interiorPole;
}

/** Proper-crossing test between segment a→b and any boundary segment —
 * closed-form arithmetic, same style as fabricConstraints.crossesWall.
 * Endpoint-grazing (t/u exactly 0 or 1) counts as crossing here: callers use
 * this to KEEP output inside, so erring toward "crosses" is the safe side. */
export function segmentCrossesBoundary(r: ProcgenRegion, ax: number, ay: number, bx: number, by: number): boolean {
  const ring = r.ring;
  for (let i = 0; i < ring.length - 1; i++) {
    const [px, py] = ring[i];
    const [qx, qy] = ring[i + 1];
    const d = (bx - ax) * (qy - py) - (by - ay) * (qx - px);
    if (d === 0) continue;
    const t = ((px - ax) * (qy - py) - (py - ay) * (qx - px)) / d;
    const u = ((px - ax) * (by - ay) - (py - ay) * (bx - ax)) / d;
    if (t > 1e-9 && t < 1 - 1e-9 && u >= 0 && u <= 1) return true;
  }
  return false;
}

/**
 * Clip a polyline to the region, returning the contiguous runs inside —
 * the polygonal generalization of the old `clipToDisc`. Deterministic
 * closed-form: each input segment collects its boundary-crossing parameters,
 * splits into sub-intervals, and keeps those whose midpoint is contained.
 * Crossing points are the same lerp both directions (clip.ts discipline), so
 * a polyline clipped by any caller yields bit-identical run endpoints. A
 * concave region can split one polyline into many runs — callers emit each
 * run with its own stable sub-index.
 */
export function clipPolylineToRegion(r: ProcgenRegion, line: Pt[]): Pt[][] {
  const runs: Pt[][] = [];
  let run: Pt[] = [];
  const flush = (): void => {
    if (run.length >= 2) runs.push(run);
    run = [];
  };
  const ring = r.ring;
  for (let i = 0; i < line.length - 1; i++) {
    const [ax, ay] = line[i];
    const [bx, by] = line[i + 1];
    // Crossing parameters along a→b, plus the 0/1 sentinels.
    const ts: number[] = [0, 1];
    for (let j = 0; j < ring.length - 1; j++) {
      const [px, py] = ring[j];
      const [qx, qy] = ring[j + 1];
      const d = (bx - ax) * (qy - py) - (by - ay) * (qx - px);
      if (d === 0) continue;
      const t = ((px - ax) * (qy - py) - (py - ay) * (qx - px)) / d;
      const u = ((px - ax) * (by - ay) - (py - ay) * (bx - ax)) / d;
      if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
    }
    ts.sort((a, b) => a - b);
    for (let k = 0; k < ts.length - 1; k++) {
      const t0 = ts[k];
      const t1 = ts[k + 1];
      if (t1 - t0 < 1e-12) continue;
      const mx = ax + ((t0 + t1) / 2) * (bx - ax);
      const my = ay + ((t0 + t1) / 2) * (by - ay);
      const p0: Pt = [ax + t0 * (bx - ax), ay + t0 * (by - ay)];
      const p1: Pt = [ax + t1 * (bx - ax), ay + t1 * (by - ay)];
      if (!regionContains(r, mx, my)) {
        flush();
        continue;
      }
      if (run.length === 0) {
        run.push(p0);
      } else {
        const last = run[run.length - 1];
        if (Math.hypot(last[0] - p0[0], last[1] - p0[1]) > 1e-9) {
          flush();
          run = [p0];
        }
      }
      run.push(p1);
    }
  }
  flush();
  return runs;
}

/**
 * Deterministic miter-clamped polygon inset (plan 020 §4) — the wall /
 * ring-road path: sketch the city limits and the wall traces them. Each
 * edge's offset line moves `inset` along its inward (left, ring is CCW)
 * normal; each vertex is the intersection of its two adjacent offset lines,
 * with the displacement clamped to `INSET_MITER_LIMIT × inset` along the
 * vertex bisector (sharp reflex vertices can't sling the miter to infinity).
 * Degenerate results (flipped orientation, collapsed area, self-intersection
 * — possible for concave rings with large insets) retry with half the inset
 * up to INSET_MAX_FALLBACKS times, then return [] — never throw. Output is a
 * closed, mm-quantized ring (or []).
 */
export function insetRing(r: ProcgenRegion, inset: number): Pt[] {
  const open = r.ring.slice(0, -1);
  if (open.length < 3) return [];
  let d = inset;
  for (let attempt = 0; attempt <= INSET_MAX_FALLBACKS; attempt++, d /= 2) {
    const result = insetOnce(open, d, r.area);
    if (result) return result;
  }
  return [];
}

function insetOnce(open: Pt[], inset: number, originalArea: number): Pt[] | null {
  const n = open.length;
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const prev = open[(i - 1 + n) % n];
    const cur = open[i];
    const next = open[(i + 1) % n];
    // Edge directions (unit) around vertex `cur`.
    const d1x = cur[0] - prev[0];
    const d1y = cur[1] - prev[1];
    const l1 = Math.hypot(d1x, d1y) || 1;
    const u1x = d1x / l1;
    const u1y = d1y / l1;
    const d2x = next[0] - cur[0];
    const d2y = next[1] - cur[1];
    const l2 = Math.hypot(d2x, d2y) || 1;
    const u2x = d2x / l2;
    const u2y = d2y / l2;
    // Inward (left) normals for a CCW ring.
    const n1x = -u1y;
    const n1y = u1x;
    const n2x = -u2y;
    const n2y = u2x;
    // Intersect the two offset lines: (prev+in·n1)→dir u1 and (cur+in·n2)→dir u2.
    const p1x = cur[0] + inset * n1x;
    const p1y = cur[1] + inset * n1y;
    const p2x = cur[0] + inset * n2x;
    const p2y = cur[1] + inset * n2y;
    const denom = u1x * u2y - u1y * u2x;
    let vx: number;
    let vy: number;
    if (Math.abs(denom) < 1e-12) {
      // Collinear edges: plain normal offset.
      vx = p1x;
      vy = p1y;
    } else {
      const t = ((p2x - p1x) * u2y - (p2y - p1y) * u2x) / denom;
      vx = p1x + t * u1x;
      vy = p1y + t * u1y;
    }
    // Miter clamp: displacement from the source vertex bounded along the
    // bisector so reflex corners stay finite.
    const mx = vx - cur[0];
    const my = vy - cur[1];
    const mLen = Math.hypot(mx, my);
    const limit = INSET_MITER_LIMIT * inset;
    if (mLen > limit && mLen > 0) {
      vx = cur[0] + (mx / mLen) * limit;
      vy = cur[1] + (my / mLen) * limit;
    }
    const p: Pt = [q(vx), q(vy)];
    const last = out[out.length - 1];
    if (last && last[0] === p[0] && last[1] === p[1]) continue; // collapsed vertex
    out.push(p);
  }
  if (out.length >= 2) {
    const a = out[0];
    const b = out[out.length - 1];
    if (a[0] === b[0] && a[1] === b[1]) out.pop();
  }
  if (out.length < 3) return null;
  // Degeneracy gates: orientation must survive, area must stay meaningful,
  // and the result must be simple (O(n²) proper-crossing test — rings are
  // small; determinism over cleverness).
  const area = signedArea(out);
  if (area <= 0 || area < 0.01 * originalArea) return null;
  if (ringSelfIntersects(out)) return null;
  return [...out, out[0]];
}

/** O(n²) proper-crossing self-intersection test over an OPEN ring. */
function ringSelfIntersects(open: Pt[]): boolean {
  const n = open.length;
  for (let i = 0; i < n; i++) {
    const a = open[i];
    const b = open[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      // Skip adjacent segments (they share a vertex by construction).
      if (j === i || (j + 1) % n === i || (i + 1) % n === j) continue;
      const c = open[j];
      const e = open[(j + 1) % n];
      const d = (b[0] - a[0]) * (e[1] - c[1]) - (b[1] - a[1]) * (e[0] - c[0]);
      if (d === 0) continue;
      const t = ((c[0] - a[0]) * (e[1] - c[1]) - (c[1] - a[1]) * (e[0] - c[0])) / d;
      const u = ((c[0] - a[0]) * (b[1] - a[1]) - (c[1] - a[1]) * (b[0] - a[0])) / d;
      if (t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9) return true;
    }
  }
  return false;
}

/** `region.bbox` grown by `margin` meters — the `domainBBox(d, margin)`
 * replacement (the cost field uses a 200 m margin). */
export function bboxWithMargin(bbox: BBox, margin: number): BBox {
  return {
    minX: bbox.minX - margin,
    minY: bbox.minY - margin,
    maxX: bbox.maxX + margin,
    maxY: bbox.maxY + margin,
  };
}

/** Is the ring convex (all turns the same way, CCW after normalization)?
 * Used by wards to pick the exact convex clip vs. the conservative concave
 * drop (plan 020 approved v1 tradeoff). Collinear vertices are tolerated. */
export function ringIsConvex(closed: Pt[]): boolean {
  const open = closed.slice(0, -1);
  const n = open.length;
  for (let i = 0; i < n; i++) {
    const a = open[i];
    const b = open[(i + 1) % n];
    const c = open[(i + 2) % n];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (cross < 0) return false;
  }
  return true;
}

export type RingValidation = { ok: true } | { ok: false; reason: string };

/**
 * Host-side ingest validation (plan 020 §4): ≥3 distinct vertices, simple
 * (no self-intersection, O(n²) is fine), area within the useful envelope.
 * Pure and side-effect free — the host turns a failure into a Notice.
 */
export function validateRegionRing(ring: Pt[]): RingValidation {
  const seen = new Set<string>();
  const open: Pt[] = [];
  for (const [x, y] of openRing(ring)) {
    const p: Pt = [q(x), q(y)];
    const key = `${p[0]},${p[1]}`;
    const last = open[open.length - 1];
    if (last && last[0] === p[0] && last[1] === p[1]) continue;
    seen.add(key);
    open.push(p);
  }
  if (open.length >= 2) {
    const a = open[0];
    const b = open[open.length - 1];
    if (a[0] === b[0] && a[1] === b[1]) open.pop();
  }
  if (seen.size < 3 || open.length < 3) {
    return { ok: false, reason: "needs at least 3 distinct vertices" };
  }
  if (ringSelfIntersects(open)) {
    return { ok: false, reason: "outline crosses itself" };
  }
  const area = Math.abs(signedArea(open));
  if (area < REGION_MIN_AREA_M2) {
    return { ok: false, reason: "area below the useful minimum (~150 m radius)" };
  }
  if (area > REGION_MAX_AREA_M2) {
    return { ok: false, reason: "area above the supported maximum (~2500 m radius)" };
  }
  return { ok: true };
}
