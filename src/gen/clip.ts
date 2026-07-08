/**
 * Liang-Barsky segment-vs-rectangle clipping. Given the same two endpoints
 * and the same rectangle edge (a shared tile boundary has bit-identical
 * coordinates on both sides), this produces a bit-identical intersection
 * point regardless of which tile is doing the clipping — the property the
 * seam gate depends on.
 */
import type { BBox } from "./spatialHash";

export interface Vec2 {
  x: number;
  y: number;
}

function liangBarsky(p0: Vec2, p1: Vec2, bbox: BBox): [number, number] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const checks: [number, number][] = [
    [-dx, p0.x - bbox.minX],
    [dx, bbox.maxX - p0.x],
    [-dy, p0.y - bbox.minY],
    [dy, bbox.maxY - p0.y],
  ];
  for (const [p, q] of checks) {
    if (p === 0) {
      if (q < 0) return null;
    } else {
      const r = q / p;
      if (p < 0) {
        if (r > t1) return null;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return null;
        if (r < t1) t1 = r;
      }
    }
  }
  if (t0 > t1) return null;
  return [t0, t1];
}

type Pt = [number, number];

function lerpAt(a: Pt, b: Pt, axis: "x" | "y", value: number): Pt {
  const ai = axis === "x" ? a[0] : a[1];
  const bi = axis === "x" ? b[0] : b[1];
  const t = (value - ai) / (bi - ai);
  return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
}

function clipHalfPlane(poly: Pt[], inside: (p: Pt) => boolean, edgeAxis: "x" | "y", edgeValue: number): Pt[] {
  if (poly.length === 0) return poly;
  const out: Pt[] = [];
  for (let i = 0; i < poly.length; i++) {
    const curr = poly[i];
    const prev = poly[(i - 1 + poly.length) % poly.length];
    const currIn = inside(curr);
    const prevIn = inside(prev);
    if (currIn) {
      if (!prevIn) out.push(lerpAt(prev, curr, edgeAxis, edgeValue));
      out.push(curr);
    } else if (prevIn) {
      out.push(lerpAt(prev, curr, edgeAxis, edgeValue));
    }
  }
  return out;
}

/**
 * Sutherland-Hodgman clip of a (possibly closed) polygon ring against an
 * axis-aligned bbox. Two tiles clipping the same pre-clip polygon against
 * their shared edge value compute the same `lerpAt` formula on the same
 * vertex pair — bit-identical boundary points, mirroring `clipPolylineToBBox`.
 * `bbox` fields may be +/-Infinity to cut along a single axis (used by block
 * subdivision to bisect a polygon without a full rectangle).
 */
export function clipPolygonToBBox(ring: Pt[], bbox: BBox): Pt[] {
  let poly = ring;
  if (poly.length > 1) {
    const first = poly[0];
    const last = poly[poly.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) poly = poly.slice(0, -1);
  }
  if (Number.isFinite(bbox.minX)) poly = clipHalfPlane(poly, (p) => p[0] >= bbox.minX, "x", bbox.minX);
  if (Number.isFinite(bbox.maxX)) poly = clipHalfPlane(poly, (p) => p[0] <= bbox.maxX, "x", bbox.maxX);
  if (Number.isFinite(bbox.minY)) poly = clipHalfPlane(poly, (p) => p[1] >= bbox.minY, "y", bbox.minY);
  if (Number.isFinite(bbox.maxY)) poly = clipHalfPlane(poly, (p) => p[1] <= bbox.maxY, "y", bbox.maxY);
  return poly;
}

/** Clips an open polyline to a bbox, returning zero or more contiguous sub-polylines. */
export function clipPolylineToBBox(points: Vec2[], bbox: BBox): Vec2[][] {
  const parts: Vec2[][] = [];
  let current: Vec2[] = [];

  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];
    const clip = liangBarsky(p0, p1, bbox);
    if (!clip) {
      if (current.length > 1) parts.push(current);
      current = [];
      continue;
    }
    const [t0, t1] = clip;
    const cp0: Vec2 = { x: p0.x + t0 * (p1.x - p0.x), y: p0.y + t0 * (p1.y - p0.y) };
    const cp1: Vec2 = { x: p0.x + t1 * (p1.x - p0.x), y: p0.y + t1 * (p1.y - p0.y) };

    if (current.length === 0) {
      current.push(cp0);
    } else {
      const last = current[current.length - 1];
      if (Math.hypot(last.x - cp0.x, last.y - cp0.y) > 1e-9) {
        if (current.length > 1) parts.push(current);
        current = [cp0];
      }
    }
    current.push(cp1);
  }
  if (current.length > 1) parts.push(current);
  return parts;
}
