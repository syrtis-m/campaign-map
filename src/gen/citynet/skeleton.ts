/**
 * Stage A skeleton (procgen v3 §5.1): the deterministic bones of a city —
 * radial arterials A*-routed from the center to the domain boundary, the
 * bridges where they cross sketched rivers, waterfront quay streets offset
 * from those rivers, and a central plaza with one or two landmark footprints
 * facing it. v3.0 scope: no ring/wall (v3.3), no growth (v3.1), no faces
 * (v3.2) — just the skeleton the later stages will hang off.
 *
 * Determinism/seam argument: every decision lives on the integer cost lattice
 * (D1). Destinations come from `routeHints` or from `hashSeed`-seeded compass
 * bearings — never insertion order (D2). The A* open set is popped by a *total*
 * comparator ending in raw cell coordinates, so a 32-bit hash collision at
 * equal `(f,g)` still resolves identically (D2). A* is bounded by
 * `MAX_ASTAR_EXPANSIONS` with a straight-line `degraded` fallback rather than a
 * throw (D3). This module returns raw world-coordinate geometry; `index.ts`
 * quantizes, ids, and canonically sorts it (D5). Because the whole skeleton is
 * a pure function of `(citySeed, domain, constraints)`, every tile that clips
 * it sees the identical bytes — that is the seam story for the city tier.
 */
import { hashSeed, mulberry32 } from "../rng";
import type { CityDomain } from "./domain";
import type { CityProfile } from "./profiles";
import type { CostField } from "./costField";
import { COST_CELL_M } from "./costField";
import type { GenerationConstraints } from "../types";
import { chaikinSmooth } from "../city/corridor";
import {
  indexFabricConstraints,
  nearestOnLine,
  RIVER_HALF_WIDTH,
} from "../fabricConstraints";

type Pt = [number, number];
type Cell = { cx: number; cy: number };

/** A* expansion budget (D3). Bounds pathological searches; the closed set
 * already caps normal searches at the cell count of the field. */
export const MAX_ASTAR_EXPANSIONS = 250000;
/** How many arterials chaikin-smoothing passes (matches the corridor avenue). */
export const ARTERIAL_SMOOTH_ITERATIONS = 2;
/** Two river crossings closer than this share one bridge (§5.1.3). */
export const BRIDGE_SHARE_DIST_M = 40;

export interface ArterialPath {
  coords: Pt[];
  degraded: boolean;
}
export interface LandmarkFootprint {
  kind: "church" | "market";
  ring: Pt[];
}
export interface SkeletonOutput {
  arterials: ArterialPath[];
  bridges: { coords: Pt[] }[];
  waterfront: { coords: Pt[] }[];
  plaza: Pt[];
  landmarks: LandmarkFootprint[];
}

// Fixed neighbor order N, E, S, W, NE, SE, SW, NW (y up) — §5.1.3.
const NEIGHBORS: [number, number][] = [
  [0, 1],
  [1, 0],
  [0, -1],
  [-1, 0],
  [1, 1],
  [1, -1],
  [-1, -1],
  [-1, 1],
];

const worldOf = (cell: number): number => cell * COST_CELL_M;
const cellOf = (world: number): number => Math.round(world / COST_CELL_M);

// ── A* open set: binary min-heap over a total comparator ───────────────────

interface OpenNode {
  cx: number;
  cy: number;
  g: number;
  f: number;
  h: number; // hashSeed tiebreak (before raw coords for un-biased order)
}

/** Total order: f, then g, then hash, then raw cellX, cellY. The trailing raw
 * coordinates make the comparator total — a 32-bit hash collision cannot leave
 * two nodes unordered (D2). */
function lessThan(a: OpenNode, b: OpenNode): boolean {
  if (a.f !== b.f) return a.f < b.f;
  if (a.g !== b.g) return a.g < b.g;
  if (a.h !== b.h) return a.h < b.h;
  if (a.cx !== b.cx) return a.cx < b.cx;
  return a.cy < b.cy;
}

class MinHeap {
  private items: OpenNode[] = [];
  get size(): number {
    return this.items.length;
  }
  push(n: OpenNode): void {
    const items = this.items;
    items.push(n);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (lessThan(items[i], items[parent])) {
        [items[i], items[parent]] = [items[parent], items[i]];
        i = parent;
      } else break;
    }
  }
  pop(): OpenNode | undefined {
    const items = this.items;
    if (items.length === 0) return undefined;
    const top = items[0];
    const last = items.pop() as OpenNode;
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        let smallest = i;
        if (l < items.length && lessThan(items[l], items[smallest])) smallest = l;
        if (r < items.length && lessThan(items[r], items[smallest])) smallest = r;
        if (smallest === i) break;
        [items[i], items[smallest]] = [items[smallest], items[i]];
        i = smallest;
      }
    }
    return top;
  }
}

/**
 * A* on the cost lattice from `start` to `goal`. Returns the cell path and a
 * `degraded` flag: on budget exhaustion or an unreachable goal it never throws
 * (D3) — it returns a straight-line cell path so the arterial still reaches its
 * endpoint, marked degraded for downstream flagging.
 */
function astar(citySeed: number, start: Cell, goal: Cell, cost: CostField): { path: Cell[]; degraded: boolean } {
  // Cell keys are field-relative so they are unique and exactly decodable for
  // any world position (a global `cx<<16` pack would collide past ±32767 m).
  const { minX, minY, maxY } = cost.cellBounds;
  const stride = maxY - minY + 1;
  const keyOf = (cx: number, cy: number): number => (cx - minX) * stride + (cy - minY);
  const decode = (key: number): Cell => ({ cx: Math.floor(key / stride) + minX, cy: (key % stride) + minY });

  const gScore = new Map<number, number>();
  const cameFrom = new Map<number, number>();
  const open = new MinHeap();

  const heuristic = (cx: number, cy: number): number => Math.hypot(cx - goal.cx, cy - goal.cy);
  gScore.set(keyOf(start.cx, start.cy), 0);
  open.push({ cx: start.cx, cy: start.cy, g: 0, f: heuristic(start.cx, start.cy), h: hashSeed(citySeed, "astar", start.cx, start.cy) });

  let expansions = 0;
  let reached = false;
  while (open.size > 0) {
    if (++expansions > MAX_ASTAR_EXPANSIONS) break;
    const cur = open.pop() as OpenNode;
    const curKey = keyOf(cur.cx, cur.cy);
    // Stale heap entry (a better g was committed after this was pushed).
    if (cur.g > (gScore.get(curKey) ?? Infinity)) continue;
    if (cur.cx === goal.cx && cur.cy === goal.cy) {
      reached = true;
      break;
    }
    for (const [dx, dy] of NEIGHBORS) {
      const nx = cur.cx + dx;
      const ny = cur.cy + dy;
      if (!cost.inBounds(nx, ny)) continue;
      const cellC = cost.cellCost(nx, ny);
      if (!Number.isFinite(cellC)) continue; // blocked (water)
      const moveLen = dx !== 0 && dy !== 0 ? Math.SQRT2 : 1;
      const tentativeG = cur.g + cellC * moveLen;
      const nKey = keyOf(nx, ny);
      if (tentativeG < (gScore.get(nKey) ?? Infinity)) {
        gScore.set(nKey, tentativeG);
        cameFrom.set(nKey, curKey);
        open.push({ cx: nx, cy: ny, g: tentativeG, f: tentativeG + heuristic(nx, ny), h: hashSeed(citySeed, "astar", nx, ny) });
      }
    }
  }

  if (!reached) return { path: straightLine(start, goal), degraded: true };

  // Reconstruct start→goal by walking the parent chain of unique keys.
  const rev: Cell[] = [];
  let key: number | undefined = keyOf(goal.cx, goal.cy);
  const startKey = keyOf(start.cx, start.cy);
  while (key !== undefined) {
    rev.push(decode(key));
    if (key === startKey) break;
    key = cameFrom.get(key);
  }
  rev.reverse();
  return { path: rev, degraded: false };
}

/** Deterministic straight-line cell path (degraded fallback), one cell per step. */
function straightLine(start: Cell, goal: Cell): Cell[] {
  const dx = goal.cx - start.cx;
  const dy = goal.cy - start.cy;
  const steps = Math.max(Math.abs(dx), Math.abs(dy));
  if (steps === 0) return [start];
  const path: Cell[] = [];
  for (let i = 0; i <= steps; i++) {
    path.push({ cx: start.cx + Math.round((dx * i) / steps), cy: start.cy + Math.round((dy * i) / steps) });
  }
  return path;
}

// ── Destinations ───────────────────────────────────────────────────────────

/** Arterial endpoint bearings (radians). From `routeHints` if present, else
 * `profile.arterialCount` compass bearings spread evenly with ≤30% jitter,
 * each seeded by `hashSeed(citySeed,"bearing",i)` (D2). */
function destinationBearings(citySeed: number, domain: CityDomain, profile: CityProfile, constraints: GenerationConstraints): number[] {
  const hints = constraints.routeHints;
  if (hints && hints.length > 0) {
    return hints.map((h) => Math.atan2(h.y - domain.cy, h.x - domain.cx));
  }
  const n = Math.max(1, profile.arterialCount);
  const spacing = (2 * Math.PI) / n;
  const bearings: number[] = [];
  for (let i = 0; i < n; i++) {
    const rng = mulberry32(hashSeed(citySeed, "bearing", i));
    const jitter = (rng() - 0.5) * 2 * 0.3 * spacing;
    bearings.push(i * spacing + jitter);
  }
  return bearings;
}

// ── Bridges ──────────────────────────────────────────────────────────────

/** Consecutive bridge-span cells of a cell path — cells within one cost cell of
 * the river-crossing penalty band (so bridge coords stay within
 * `RIVER_HALF_WIDTH + COST_CELL_M` of the river, matching the seam tolerance). */
function bridgeSpans(cells: Cell[], cost: CostField): Cell[][] {
  const band = RIVER_HALF_WIDTH + COST_CELL_M;
  const spans: Cell[][] = [];
  let run: Cell[] = [];
  for (const c of cells) {
    if (cost.riverDist(c.cx, c.cy) < band) {
      run.push(c);
    } else if (run.length > 0) {
      spans.push(run);
      run = [];
    }
  }
  if (run.length > 0) spans.push(run);
  return spans.filter((s) => s.length >= 2);
}

// ── Waterfront ─────────────────────────────────────────────────────────────

/** Offset a polyline by `dist` on `side` (+1/−1) along per-vertex normals.
 * Returns null when the result folds back on itself (a segment reverses) — the
 * area/length degeneracy test of §5.1.4. */
function offsetPolyline(line: Pt[], dist: number, side: number): Pt[] | null {
  if (line.length < 2) return null;
  const normals: Pt[] = [];
  for (let i = 0; i < line.length - 1; i++) {
    const dx = line[i + 1][0] - line[i][0];
    const dy = line[i + 1][1] - line[i][1];
    const len = Math.hypot(dx, dy) || 1;
    normals.push([-dy / len, dx / len]);
  }
  const out: Pt[] = [];
  for (let i = 0; i < line.length; i++) {
    const na = normals[Math.min(i, normals.length - 1)];
    const nb = normals[Math.max(0, i - 1)];
    let mx = na[0] + nb[0];
    let my = na[1] + nb[1];
    const ml = Math.hypot(mx, my) || 1;
    mx /= ml;
    my /= ml;
    out.push([line[i][0] + side * dist * mx, line[i][1] + side * dist * my]);
  }
  // Degeneracy: any offset segment that reversed direction relative to its
  // source segment folded the polyline — drop the whole quay.
  for (let i = 0; i < out.length - 1; i++) {
    const sdx = line[i + 1][0] - line[i][0];
    const sdy = line[i + 1][1] - line[i][1];
    const odx = out[i + 1][0] - out[i][0];
    const ody = out[i + 1][1] - out[i][1];
    if (sdx * odx + sdy * ody <= 0) return null;
  }
  return out;
}

/** The parameter interval [lo,hi] ⊂ [0,1] of segment a→b that lies inside the
 * disc, or null if none. Handles the both-endpoints-outside chord case (a river
 * spanning the world crosses the disc with both ends far outside it). */
function insideInterval(a: Pt, b: Pt, cx: number, cy: number, r: number): [number, number] | null {
  const inside = (p: Pt): boolean => (p[0] - cx) ** 2 + (p[1] - cy) ** 2 <= r * r;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const fx = a[0] - cx;
  const fy = a[1] - cy;
  const A = dx * dx + dy * dy;
  const B = 2 * (fx * dx + fy * dy);
  const C = fx * fx + fy * fy - r * r;
  const disc = B * B - 4 * A * C;
  if (A === 0 || disc < 0) return inside(a) ? [0, 1] : null; // line misses circle
  const sq = Math.sqrt(disc);
  const t1 = (-B - sq) / (2 * A);
  const t2 = (-B + sq) / (2 * A);
  const lo = Math.max(0, t1);
  const hi = Math.min(1, t2);
  return lo < hi ? [lo, hi] : null;
}

/** Clip a polyline to the domain disc, returning the contiguous runs inside.
 * Mirrors `clipPolylineToBBox`'s run-splitting so a quay that leaves and
 * re-enters the disc yields separate parts. Exported for `growth.ts`, which
 * pre-seeds sketched roads into the street graph clipped the same way. */
export function clipToDisc(line: Pt[], cx: number, cy: number, r: number): Pt[][] {
  const at = (a: Pt, b: Pt, t: number): Pt => [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
  const runs: Pt[][] = [];
  let run: Pt[] = [];
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i];
    const b = line[i + 1];
    const interval = insideInterval(a, b, cx, cy, r);
    if (!interval) {
      if (run.length >= 2) runs.push(run);
      run = [];
      continue;
    }
    const [lo, hi] = interval;
    const pLo = at(a, b, lo);
    const pHi = at(a, b, hi);
    if (run.length === 0) {
      run.push(pLo);
    } else {
      const last = run[run.length - 1];
      if (Math.hypot(last[0] - pLo[0], last[1] - pLo[1]) > 1e-9) {
        if (run.length >= 2) runs.push(run);
        run = [pLo];
      }
    }
    run.push(pHi);
  }
  if (run.length >= 2) runs.push(run);
  return runs;
}

// ── Plaza + landmarks ────────────────────────────────────────────────────

/** Central plaza: an 8-gon around the domain center, radius `plazaRadius` with
 * per-vertex hash jitter (§5.1.6). Closed ring. */
function buildPlaza(citySeed: number, domain: CityDomain, profile: CityProfile): Pt[] {
  const ring: Pt[] = [];
  const sides = 8;
  for (let i = 0; i < sides; i++) {
    const rng = mulberry32(hashSeed(citySeed, "plaza", i));
    const ang = (i / sides) * 2 * Math.PI;
    const rad = profile.plazaRadius * (0.85 + 0.3 * rng());
    ring.push([domain.cx + rad * Math.cos(ang), domain.cy + rad * Math.sin(ang)]);
  }
  ring.push(ring[0]);
  return ring;
}

/** Landmark footprints adjacent to the plaza, each a rectangle offset outward
 * at a hashed bearing and oriented to face the plaza (§5.1.6). */
function buildLandmarks(citySeed: number, domain: CityDomain, profile: CityProfile): LandmarkFootprint[] {
  const out: LandmarkFootprint[] = [];
  const kinds = profile.landmarks.slice(0, 2);
  for (let i = 0; i < kinds.length; i++) {
    const kind = kinds[i];
    const rng = mulberry32(hashSeed(citySeed, "landmark", i));
    const bearing = (i / Math.max(1, kinds.length)) * 2 * Math.PI + (rng() - 0.5) * 0.6;
    const half = kind === "church" ? { w: 12, d: 20 } : { w: 16, d: 10 };
    const gap = 6;
    const dist = profile.plazaRadius + gap + half.d;
    const bcx = domain.cx + dist * Math.cos(bearing);
    const bcy = domain.cy + dist * Math.sin(bearing);
    // Local axes: `along` faces the plaza (toward center), `across` is tangent.
    const ax = -Math.cos(bearing);
    const ay = -Math.sin(bearing);
    const px = -ay;
    const py = ax;
    const corner = (sd: number, sw: number): Pt => [
      bcx + ax * half.d * sd + px * half.w * sw,
      bcy + ay * half.d * sd + py * half.w * sw,
    ];
    const ring: Pt[] = [corner(1, 1), corner(1, -1), corner(-1, -1), corner(-1, 1)];
    ring.push(ring[0]);
    out.push({ kind, ring });
  }
  return out;
}

// ── Orchestration ──────────────────────────────────────────────────────────

/**
 * Build the whole Stage-A skeleton for a domain. Pure — reads only its
 * arguments and the cost field derived from them. Returns raw world geometry;
 * `index.ts` handles quantization, ids, and canonical ordering.
 */
export function buildSkeleton(
  citySeed: number,
  domain: CityDomain,
  profile: CityProfile,
  constraints: GenerationConstraints,
  cost: CostField
): SkeletonOutput {
  const centerCell: Cell = { cx: cellOf(domain.cx), cy: cellOf(domain.cy) };

  // 1) Arterials + their bridge sub-spans.
  const bearings = destinationBearings(citySeed, domain, profile, constraints);
  const arterials: ArterialPath[] = [];
  const rawBridgeSpans: { cells: Cell[]; crossing: Pt }[] = [];
  bearings.forEach((theta) => {
    const ex = domain.cx + domain.radius * Math.cos(theta);
    const ey = domain.cy + domain.radius * Math.sin(theta);
    const goalCell: Cell = { cx: cellOf(ex), cy: cellOf(ey) };
    const { path, degraded } = astar(citySeed, centerCell, goalCell, cost);
    if (path.length < 2) return;
    const world: Pt[] = path.map((c) => [worldOf(c.cx), worldOf(c.cy)]);
    arterials.push({ coords: chaikinSmooth(world, ARTERIAL_SMOOTH_ITERATIONS), degraded });
    for (const span of bridgeSpans(path, cost)) {
      const mid = span[Math.floor(span.length / 2)];
      rawBridgeSpans.push({ cells: span, crossing: [worldOf(mid.cx), worldOf(mid.cy)] });
    }
  });

  // Share bridges: crossings within BRIDGE_SHARE_DIST keep one span. Process in
  // a canonical order (crossing x, then y) so the survivor is deterministic.
  rawBridgeSpans.sort((a, b) => a.crossing[0] - b.crossing[0] || a.crossing[1] - b.crossing[1]);
  const bridges: { coords: Pt[] }[] = [];
  const kept: Pt[] = [];
  for (const cand of rawBridgeSpans) {
    if (kept.some((k) => Math.hypot(k[0] - cand.crossing[0], k[1] - cand.crossing[1]) < BRIDGE_SHARE_DIST_M)) continue;
    kept.push(cand.crossing);
    bridges.push({ coords: cand.cells.map((c) => [worldOf(c.cx), worldOf(c.cy)]) });
  }

  // 2) Waterfront quay streets (euro profiles only, via non-empty offsets).
  const waterfront: { coords: Pt[] }[] = [];
  if (profile.waterfrontOffsets.length > 0) {
    const idx = indexFabricConstraints(constraints.fabricFeatures);
    for (const river of idx.riverLines) {
      // Only rivers that actually reach the domain get quays.
      if (nearestOnLine(river, domain.cx, domain.cy).dist > domain.radius) continue;
      for (const off of profile.waterfrontOffsets) {
        for (const side of [1, -1]) {
          const offsetLine = offsetPolyline(river, off, side);
          if (!offsetLine) continue;
          for (const run of clipToDisc(offsetLine, domain.cx, domain.cy, domain.radius)) {
            if (run.length >= 2) waterfront.push({ coords: run });
          }
        }
      }
    }
  }

  // 3) Plaza + landmarks.
  const plaza = buildPlaza(citySeed, domain, profile);
  const landmarks = buildLandmarks(citySeed, domain, profile);

  return { arterials, bridges, waterfront, plaza, landmarks };
}
