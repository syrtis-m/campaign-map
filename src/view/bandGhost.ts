/**
 * Pure geometry + descriptors for the band-ghost visualization (plan 040
 * Phase 2). No DOM / map / Obsidian imports — unit-tested headlessly; the
 * SketchController consumes it to paint the display-only ghost outlines and to
 * place + drive the band-edge grips.
 *
 * A relief/landform stamp's *effective band* is the ground footprint its
 * cross-profile reaches: relief → the ±`width` fade-out corridor around the
 * spine (ONE presented value = halfWidth + apron, 2026-07-16 — the field's
 * profile is a single smoothstep over the sum, so the raw split never
 * surfaces); landform → the `band` transition ring inset inside the polygon.
 * This module offsets the base geometry to draw that footprint and reports
 * which presented param each draggable edge SETS.
 *
 * NB: this is DISPLAY-ONLY ghost geometry, never persisted and never fed to a
 * generator — so the offsetting is a plain deterministic per-segment normal
 * offset (miter joins, bevel fallback). It draws in the base geometry's own
 * planar units; the caller converts metres → units before calling. A drag
 * commit is translated to zod params (`presentedParamPatch`) and written
 * through the normal `setRegionParams` path, so determinism (D1–D6) is
 * untouched.
 */
import type { FabricKind } from "../model/fabric";

export type Pt = [number, number];

/** Beyond this miter length (1/cos(θ/2)) a sharp corner is bevelled instead of
 * mitred, so a near-reflex vertex never throws a long spike — a ghost join. */
const MITER_LIMIT = 4;

function sub(a: Pt, b: Pt): Pt {
  return [a[0] - b[0], a[1] - b[1]];
}
function add(a: Pt, b: Pt): Pt {
  return [a[0] + b[0], a[1] + b[1]];
}
function scale(a: Pt, s: number): Pt {
  return [a[0] * s, a[1] * s];
}
function length(a: Pt): number {
  return Math.hypot(a[0], a[1]);
}
function normalize(a: Pt): Pt {
  const l = length(a) || 1;
  return [a[0] / l, a[1] / l];
}
/** Left-hand (CCW 90°) unit normal of a unit direction. `+d` offsets to this
 * side; the grip helpers use the same convention so a grip sits on its edge. */
function leftNormal(dir: Pt): Pt {
  return [-dir[1], dir[0]];
}
function dot(a: Pt, b: Pt): number {
  return a[0] * b[0] + a[1] * b[1];
}

/** Drop consecutive coincident points so a zero-length segment never yields a
 * NaN direction. */
function dedupe(points: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  return out;
}

/** Shoelace signed area of an open ring (no closing duplicate). >0 ⇒ CCW. */
function signedArea(ring: Pt[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/**
 * Offset an OPEN polyline by signed distance `d` (left = +d) with miter joins
 * (bevel fallback at sharp corners), butt endpoints. Deterministic, pure —
 * display-only ghost geometry. Fewer than 2 distinct points or `d === 0`
 * returns the input unchanged.
 */
export function offsetPolyline(points: Pt[], d: number): Pt[] {
  const pts = dedupe(points);
  if (pts.length < 2 || d === 0) return pts.map((p) => [p[0], p[1]] as Pt);
  const segNorm: Pt[] = [];
  for (let i = 0; i < pts.length - 1; i++) segNorm.push(leftNormal(normalize(sub(pts[i + 1], pts[i]))));
  const out: Pt[] = [];
  out.push(add(pts[0], scale(segNorm[0], d)));
  for (let i = 1; i < pts.length - 1; i++) {
    const n0 = segNorm[i - 1];
    const n1 = segNorm[i];
    const miter = normalize(add(n0, n1));
    const cos = dot(miter, n0); // cos(θ/2)
    if (cos > 1 / MITER_LIMIT) {
      out.push(add(pts[i], scale(miter, d / cos)));
    } else {
      out.push(add(pts[i], scale(n0, d)));
      out.push(add(pts[i], scale(n1, d)));
    }
  }
  out.push(add(pts[pts.length - 1], scale(segNorm[segNorm.length - 1], d)));
  return out;
}

/**
 * Inset a CLOSED ring (given as an OPEN vertex list, no closing duplicate)
 * inward by `d` (>0). Returns a CLOSED ring (first point repeated at the end)
 * for drawing. Inward is resolved from the ring's winding, so it is correct
 * regardless of orientation. Ghost-quality: a large inset on a concave ring may
 * self-intersect — the caller clamps `d` (`safeInsetDistance`) so it never
 * inverts on screen. `d ≤ 0` or <3 points returns the closed input.
 */
export function insetRing(openRing: Pt[], d: number): Pt[] {
  const pts = dedupe(openRing);
  const n = pts.length;
  if (n < 3 || d <= 0) return [...pts.map((p) => [p[0], p[1]] as Pt), pts[0]];
  // Left normal points INWARD for a CCW ring (interior on the left of each
  // directed edge), so an inward inset uses +d there and −d for a CW ring.
  const s = signedArea(pts) > 0 ? d : -d;
  const segNorm: Pt[] = [];
  for (let i = 0; i < n; i++) segNorm.push(leftNormal(normalize(sub(pts[(i + 1) % n], pts[i]))));
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const n0 = segNorm[(i - 1 + n) % n];
    const n1 = segNorm[i];
    const miter = normalize(add(n0, n1));
    const cos = dot(miter, n0);
    if (cos > 1 / MITER_LIMIT) out.push(add(pts[i], scale(miter, s / cos)));
    else {
      out.push(add(pts[i], scale(n0, s)));
      out.push(add(pts[i], scale(n1, s)));
    }
  }
  out.push(out[0]);
  return out;
}

/** Clamp an inset distance (planar units) so a ring can never invert on screen:
 * never more than 45% of the ring's smaller bbox half-extent. Ghost-only visual
 * guard — the PARAM keeps its true metres (the readout shows the real value). */
export function safeInsetDistance(openRing: Pt[], d: number): number {
  if (openRing.length < 3) return d;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of openRing) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const cap = 0.45 * Math.min(maxX - minX, maxY - minY);
  return Math.min(d, cap);
}

/** Anchor (planar) + left-side unit normal at a polyline's middle segment — the
 * relief band grip sits at `anchor + normal · offsetUnits`, on the +offset
 * ghost line. Empty/degenerate ⇒ origin + up. */
export function polylineMidNormal(points: Pt[]): { anchor: Pt; normal: Pt } {
  const pts = dedupe(points);
  if (pts.length < 2) return { anchor: pts[0] ?? [0, 0], normal: [0, 1] };
  const seg = Math.floor((pts.length - 1) / 2);
  const a = pts[seg];
  const b = pts[seg + 1];
  return { anchor: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], normal: leftNormal(normalize(sub(b, a))) };
}

/** Anchor (planar) + INWARD unit normal at a ring's first edge — the landform
 * band grip sits at `anchor + normal · insetUnits`, on the inset ghost ring. */
export function ringInsetNormal(openRing: Pt[]): { anchor: Pt; normal: Pt } {
  const pts = dedupe(openRing);
  if (pts.length < 3) return { anchor: pts[0] ?? [0, 0], normal: [0, 1] };
  const a = pts[0];
  const b = pts[1];
  // Left normal points INWARD for a CCW ring, OUTWARD for a CW ring.
  const left = leftNormal(normalize(sub(b, a)));
  const inward = signedArea(pts) > 0 ? left : scale(left, -1);
  return { anchor: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], normal: inward };
}

/** A single draggable band edge: which presented param it SETS, the
 * ghost-outline offset (metres) it is drawn at, its offset bounds, and whether
 * it is a fainter secondary line. */
export interface BandEdge {
  param: "width" | "band";
  /** Offset from the base geometry the ghost line + grip are drawn at (m). */
  offsetMeters: number;
  minOffset: number;
  maxOffset: number;
  faint: boolean;
}

const BAND_MAX_M = 20000; // matches the zod schema caps (halfWidth/band)

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/**
 * The draggable band edges for a stamp kind's current param values. relief →
 * ONE `width` edge at the total reach (2026-07-16 — the field's cross-profile
 * is a single smoothstep over `halfWidth + apron`, so the two schema params
 * are a pure SUM: two grips were one knob in disguise, and Jonah found them
 * "very confusing". The GM edits the one thing the terrain actually responds
 * to: how far the relief reaches from its ridge line); landform → the `band`
 * ring edge. Any other kind ⇒ no band (empty).
 */
export function bandEdges(kind: FabricKind, params: Record<string, unknown>): BandEdge[] {
  if (kind === "relief") {
    const width = Math.max(1, num(params.width, Math.max(1, num(params.halfWidth, 180)) + Math.max(0, num(params.apron, 0))));
    return [{ param: "width", offsetMeters: width, minOffset: 1, maxOffset: BAND_MAX_M, faint: false }];
  }
  if (kind === "landform") {
    const band = Math.max(0, num(params.band, 120));
    return [{ param: "band", offsetMeters: band, minOffset: 0, maxOffset: BAND_MAX_M, faint: false }];
  }
  return [];
}

/** Starting param values (metres) a controller tracks live during band drags.
 * Relief exposes the PRESENTED `width` (= halfWidth + apron), never the raw
 * schema split. */
export function bandValuesFromParams(kind: FabricKind, params: Record<string, unknown>): Record<string, number> {
  if (kind === "relief")
    return { width: Math.max(1, num(params.halfWidth, 180)) + Math.max(0, num(params.apron, 0)) };
  if (kind === "landform") return { band: Math.max(0, num(params.band, 120)) };
  return {};
}

/** Map a band edge's new OFFSET (m) back to the presented param it SETS.
 * (Translation of a presented `width` back into the persisted halfWidth/apron
 * schema split happens at the commit boundary — `presentedParamPatch`.) */
export function bandParamFromOffset(param: "width" | "band", offsetMeters: number): { key: string; value: number } {
  if (param === "width") return { key: "width", value: Math.max(1, Math.round(offsetMeters)) };
  return { key: "band", value: Math.max(0, Math.round(offsetMeters)) };
}

/** Map a perpendicular screen-drag to a new signed OFFSET (m). `deltaPx` is the
 * pixel delta along the outward screen normal; `metresPerPixel` folds in the
 * live map scale so the grip tracks the true ghost edge. Clamped + rounded. */
export function offsetFromBandDrag(
  startOffset: number,
  deltaPx: number,
  metresPerPixel: number,
  minOffset: number,
  maxOffset: number
): number {
  return Math.max(minOffset, Math.min(maxOffset, Math.round(startOffset + deltaPx * metresPerPixel)));
}

/** Live readout for a band drag ("width 400 m" / "band 120 m"). */
export function formatBandReadout(param: "width" | "band", value: number): string {
  return `${param} ${Math.abs(Math.round(value))} m`;
}
