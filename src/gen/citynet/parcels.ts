/**
 * Stage C2 — OBB parcelling + footprints (procgen v3 §5.3.2–3, Evans's Lots):
 * each block is recursively sliced across its oriented-bounding-box long axis
 * until lots reach profile targets; each lot with street frontage gets one
 * building footprint inset toward — and aligned to — its frontage edge, so
 * buildings face the street. Lots without frontage stay open (courtyards of
 * deep blocks).
 *
 * Determinism argument: recursion is keyed `hashSeed(citySeed, blockId, path)`
 * (same discipline as the legacy blocks.ts) — a parcel's RNG stream depends
 * only on its block identity and its split path, never on sibling order (D2/
 * D6). The OBB search iterates ring-edge directions in ring order with strict
 * `<` (first of ties wins). Rotation trig is FP but only *shapes* geometry;
 * no topology gate compares FP for equality (D4). Everything here is
 * per-block pure — a future per-tile parcel derivation (§3.3 size valve) can
 * call it with any subset of blocks.
 *
 * Anti-Watabou: degenerate slices (sub-3-vertex, near-zero area — possible
 * when Sutherland-Hodgman cuts a concave face) are dropped and counted,
 * never thrown.
 */
import { hashSeed, mulberry32 } from "../rng";
import { clipPolygonToBBox } from "../clip";
import type { CityProfile } from "./profiles";
import type { CitynessFn } from "./cityness";
import type { BlockFace } from "./faces";

type Pt = [number, number];

/** Recursion depth cap (D3 — a budget, not a convergence test). */
export const MAX_SPLIT_DEPTH = 14;
/** Hashed chance a splittable lot stops early anyway — oversized lots are the
 * "violation chances" of §5.3.2, and they read as manors/warehouses. */
export const STOP_VIOLATION_P = 0.07;
/** Both endpoints AND midpoint of a parcel edge must be this close (m) to the
 * block boundary to count as frontage (midpoint excludes interior cut edges
 * that merely start and end on the boundary). */
export const FRONTAGE_EPS_M = 0.05;
/** Minimum emitted footprint area, m². */
export const MIN_FOOTPRINT_AREA_M2 = 12;

export interface ParcelPiece {
  ring: Pt[]; // open ring, world meters
  blockKey: string; // the block's sorted-node-key identity
  path: string; // split path, e.g. "010"
}

export interface ParcelStats {
  degenerate: number;
  /** Per-footprint |long axis vs frontage| deviation, radians (gate d). */
  alignmentDeviations: number[];
}

export interface SubdivisionResult {
  parcels: ParcelPiece[];
  footprints: ParcelPiece[];
  stats: ParcelStats;
}

function shoelace(ring: Pt[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [px, py] = ring[i];
    const [qx, qy] = ring[(i + 1) % ring.length];
    a += px * qy - qx * py;
  }
  return a / 2;
}

function centroid(ring: Pt[]): Pt {
  let sx = 0;
  let sy = 0;
  for (const [x, y] of ring) {
    sx += x;
    sy += y;
  }
  return [sx / ring.length, sy / ring.length];
}

function rotate(ring: Pt[], c: number, s: number): Pt[] {
  return ring.map(([x, y]) => [x * c + y * s, -x * s + y * c]);
}

function unrotate(ring: Pt[], c: number, s: number): Pt[] {
  return ring.map(([u, v]) => [u * c - v * s, u * s + v * c]);
}

interface OBB {
  angle: number;
  uMin: number;
  uMax: number;
  vMin: number;
  vMax: number;
  area: number;
}

/** Best-fit OBB by brute force over the ring's (deduplicated) edge
 * directions — Evans's method. Strict `<` keeps the first of tied
 * directions in ring order (deterministic). */
export function bestOBB(ring: Pt[]): OBB {
  const seen = new Set<number>();
  let best: OBB | null = null;
  for (let i = 0; i < ring.length; i++) {
    const [ax, ay] = ring[i];
    const [bx, by] = ring[(i + 1) % ring.length];
    let angle = Math.atan2(by - ay, bx - ax) % Math.PI;
    if (angle < 0) angle += Math.PI;
    const qk = Math.round(angle * 1000);
    if (seen.has(qk)) continue;
    seen.add(qk);
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    let uMin = Infinity;
    let uMax = -Infinity;
    let vMin = Infinity;
    let vMax = -Infinity;
    for (const [x, y] of ring) {
      const u = x * c + y * s;
      const v = -x * s + y * c;
      if (u < uMin) uMin = u;
      if (u > uMax) uMax = u;
      if (v < vMin) vMin = v;
      if (v > vMax) vMax = v;
    }
    const area = (uMax - uMin) * (vMax - vMin);
    if (best === null || area < best.area) best = { angle, uMin, uMax, vMin, vMax, area };
  }
  return best ?? { angle: 0, uMin: 0, uMax: 0, vMin: 0, vMax: 0, area: 0 };
}

/** Min distance from a point to any segment of a closed ring's boundary. */
function distToRing(p: Pt, ring: Pt[]): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const [ax, ay] = ring[i];
    const [bx, by] = ring[(i + 1) % ring.length];
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / l2));
    const d = Math.hypot(p[0] - (ax + t * dx), p[1] - (ay + t * dy));
    if (d < best) best = d;
  }
  return best;
}

/** Fold the difference of two line angles (mod π) into [0, π/2]. */
function lineAngleDeviation(a: number, b: number): number {
  let d = Math.abs(a - b) % Math.PI;
  if (d > Math.PI / 2) d = Math.PI - d;
  return d;
}

/**
 * Subdivide blocks into parcels and footprints. Per-block pure; see module
 * JSDoc. `blocks` rings must be closed (faces.ts emits closed rings) — the
 * closing vertex is stripped internally.
 */
export function subdivideBlocks(
  citySeed: number,
  blocks: BlockFace[],
  profile: CityProfile,
  cityness: CitynessFn
): SubdivisionResult {
  const parcels: ParcelPiece[] = [];
  const footprints: ParcelPiece[] = [];
  const stats: ParcelStats = { degenerate: 0, alignmentDeviations: [] };
  const minArea = profile.parcelMinArea;
  const targetMax = minArea * 3;

  for (const block of blocks) {
    const blockKey = block.nodeKeys.join("|");
    const blockRing = block.ring.slice(0, -1); // strip closure
    if (blockRing.length < 3) {
      stats.degenerate++;
      continue;
    }

    const leaves: ParcelPiece[] = [];
    const subdivide = (ring: Pt[], path: string): void => {
      const area = Math.abs(shoelace(ring));
      if (ring.length < 3 || area < minArea * 0.25) {
        stats.degenerate++;
        return;
      }
      const rng = mulberry32(hashSeed(citySeed, "parcel", blockKey, path));
      const obb = bestOBB(ring);
      const uExt = obb.uMax - obb.uMin;
      const vExt = obb.vMax - obb.vMin;
      const aspect = Math.max(uExt, vExt) / Math.max(1e-6, Math.min(uExt, vExt));
      const mustSplit = aspect > profile.parcelMaxAspect;
      const wantSplit = area > targetMax;
      const canSplit = area > 2 * minArea && path.length < MAX_SPLIT_DEPTH;
      const violation = rng() < STOP_VIOLATION_P;
      if (!canSplit || (!mustSplit && (!wantSplit || violation))) {
        leaves.push({ ring, blockKey, path });
        return;
      }
      // Slice across the long axis at a hashed 40–60% cut.
      const cutFrac = 0.4 + rng() * 0.2;
      const c = Math.cos(obb.angle);
      const s = Math.sin(obb.angle);
      const rot = rotate(ring, c, s);
      const alongU = uExt >= vExt;
      const cut = alongU ? obb.uMin + uExt * cutFrac : obb.vMin + vExt * cutFrac;
      const lo = clipPolygonToBBox(
        rot,
        alongU
          ? { minX: -Infinity, maxX: cut, minY: -Infinity, maxY: Infinity }
          : { minX: -Infinity, maxX: Infinity, minY: -Infinity, maxY: cut }
      );
      const hi = clipPolygonToBBox(
        rot,
        alongU
          ? { minX: cut, maxX: Infinity, minY: -Infinity, maxY: Infinity }
          : { minX: -Infinity, maxX: Infinity, minY: cut, maxY: Infinity }
      );
      if (lo.length < 3 || hi.length < 3) {
        // Cut failed to produce two pieces (degenerate concavity) — keep whole.
        leaves.push({ ring, blockKey, path });
        return;
      }
      subdivide(unrotate(lo, c, s), path + "0");
      subdivide(unrotate(hi, c, s), path + "1");
    };
    subdivide(blockRing, "r");
    parcels.push(...leaves);

    // ── Footprints: one per parcel with adequate street frontage ──────────
    for (const parcel of leaves) {
      const fp = buildFootprint(citySeed, parcel, blockRing, profile, cityness, stats);
      if (fp) footprints.push(fp);
    }
  }

  return { parcels, footprints, stats };
}

/** Longest parcel edge lying on the block boundary (endpoint + midpoint
 * proximity test), or null when the parcel is interior (courtyard). */
function longestFrontage(ring: Pt[], blockRing: Pt[]): { a: Pt; b: Pt; len: number } | null {
  let best: { a: Pt; b: Pt; len: number } | null = null;
  let frontageTotal = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (
      distToRing(a, blockRing) > FRONTAGE_EPS_M ||
      distToRing(b, blockRing) > FRONTAGE_EPS_M ||
      distToRing(mid, blockRing) > FRONTAGE_EPS_M
    ) {
      continue;
    }
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    frontageTotal += len;
    if (best === null || len > best.len) best = { a, b, len };
  }
  return best && frontageTotal > 0 ? best : null;
}

function buildFootprint(
  citySeed: number,
  parcel: ParcelPiece,
  blockRing: Pt[],
  profile: CityProfile,
  cityness: CitynessFn,
  stats: ParcelStats
): ParcelPiece | null {
  const frontage = longestFrontage(parcel.ring, blockRing);
  if (!frontage || frontage.len < profile.parcelMinFrontage) return null; // courtyard / interior

  const rng = mulberry32(hashSeed(citySeed, "footprint", parcel.blockKey, parcel.path));
  const theta = Math.atan2(frontage.b[1] - frontage.a[1], frontage.b[0] - frontage.a[0]);
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const rot = rotate(parcel.ring, c, s);
  const fa = rotate([frontage.a], c, s)[0];
  const fb = rotate([frontage.b], c, s)[0];
  const u0 = Math.min(fa[0], fb[0]);
  const u1 = Math.max(fa[0], fb[0]);
  const v0 = (fa[1] + fb[1]) / 2;

  // Interior side of the frontage edge = where the parcel mass sits.
  const [, cvY] = centroid(rot);
  const sign = cvY >= v0 ? 1 : -1;
  let vFar = sign > 0 ? -Infinity : Infinity;
  for (const [, v] of rot) vFar = sign > 0 ? Math.max(vFar, v) : Math.min(vFar, v);
  const parcelDepth = Math.abs(vFar - v0);

  const inset = profile.footprintInset;
  const cty = cityness(...centroid(parcel.ring));
  const coverage = Math.min(0.92, Math.max(0.4, profile.footprintCoverage + 0.2 * (cty - 0.5)));
  const width = (u1 - u0 - 2 * inset) * coverage;
  if (width < 3) return null;
  // Depth by cityness + profile, capped so the long axis stays along the
  // frontage (gate d: buildings read as facing the street).
  const depth = Math.min(profile.footprintDepth * (0.7 + 0.6 * cty), 0.85 * width, parcelDepth - inset);
  if (depth < 2.5) return null;

  // Slide the building along its frontage a little (hashed) for variety.
  const slack = (u1 - u0 - 2 * inset - width) / 2;
  const uc = (u0 + u1) / 2 + (rng() * 2 - 1) * slack;
  const vNear = v0 + sign * inset;
  const vDeep = v0 + sign * (inset + depth);
  const rect = {
    minX: uc - width / 2,
    maxX: uc + width / 2,
    minY: Math.min(vNear, vDeep),
    maxY: Math.max(vNear, vDeep),
  };
  const clipped = clipPolygonToBBox(rot, rect);
  if (clipped.length < 3 || Math.abs(shoelace(clipped)) < MIN_FOOTPRINT_AREA_M2) {
    stats.degenerate++;
    return null;
  }
  const ring = unrotate(clipped, c, s);

  // Gate (d) bookkeeping: long axis of the built footprint vs frontage.
  const obb = bestOBB(ring);
  const longAxisAngle =
    obb.uMax - obb.uMin >= obb.vMax - obb.vMin ? obb.angle : obb.angle + Math.PI / 2;
  stats.alignmentDeviations.push(lineAngleDeviation(longAxisAngle, theta));

  return { ring, blockKey: parcel.blockKey, path: parcel.path };
}
