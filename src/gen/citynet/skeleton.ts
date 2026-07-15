/**
 * Stage A skeleton: the deterministic bones of a city — radial arterials
 * A*-routed from the generation center to the region boundary, the bridges
 * where they cross sketched rivers, waterfront quay streets offset from those
 * rivers, a central plaza with landmark footprints facing it, and
 * (profile-gated) the wall: a ring road that TRACES the sketched region outline
 * via `insetRing`, with gates where the arterials cross it and a wall band
 * along it. Growth treats the wall as a barrier passable only at gates.
 *
 * Region mapping: the center is `generationCenter` — the area centroid, or the
 * interior pole when a concave ring puts the centroid outside (deterministic
 * fallback, documented in region.ts). Arterial endpoints come from
 * `boundaryPointFrom(center, bearing)`. Every emitted polyline is clipped to
 * the region (`clipPolylineToRegion`) so no skeleton geometry ever crosses the
 * GM's line — a concave region can split an arterial into several parts, each
 * carrying a stable `key` for its feature id. The wall is
 * `insetRing(region, (1 − ringRadiusFrac) × effectiveRadius)` with the arterial
 * crossings inserted as ring VERTICES in ring-parameter order (position-keyed),
 * so every gate lies exactly on both the emitted ring and its arterial.
 *
 * Determinism/seam argument: every routing decision lives on the integer
 * cost lattice (D1). Destinations come from `routeHints` or from
 * `hashSeed`-seeded compass bearings — never insertion order (D2). The A*
 * open set is popped by a *total* comparator ending in raw cell coordinates
 * (D2). A* is bounded by `MAX_ASTAR_EXPANSIONS` with a straight-line
 * `degraded` fallback rather than a throw (D3). Gate/clip intersections are
 * closed-form segment solves on deterministic inputs (D4); this module
 * returns raw world-coordinate geometry and `index.ts` quantizes, ids, and
 * canonically sorts it (D5) — except gate points and the inset ring, which
 * arrive pre-quantized so "gate === ring vertex" holds bit-exactly. Because
 * the whole skeleton is a pure function of `(citySeed, region, constraints)`,
 * every tile that clips it sees identical bytes — the city-tier seam story.
 */
import { hashSeed, mulberry32 } from "../rng";
import {
  boundaryPointFrom,
  clipPolylineToRegion,
  generationCenter,
  insetRing,
  regionContains,
  type ProcgenRegion,
} from "../region";
import type { CityProfile } from "./profiles";
import type { CostField } from "./costField";
import { COST_CELL_M } from "./costField";
import type { GenerationConstraints } from "../types";
import { chaikinSmooth } from "../city/corridor";
import {
  blockedByWater,
  indexConstraints,
  nearestOnLine,
  type FabricConstraintIndex,
} from "../fabricConstraints";

type Pt = [number, number];
type Cell = { cx: number; cy: number };

/** A* expansion budget (D3). Bounds pathological searches; the closed set
 * already caps normal searches at the cell count of the field. */
export const MAX_ASTAR_EXPANSIONS = 250000;
/** How many arterials chaikin-smoothing passes (matches the corridor avenue). */
export const ARTERIAL_SMOOTH_ITERATIONS = 2;
/** Two river crossings closer than this share one bridge. */
export const BRIDGE_SHARE_DIST_M = 40;

/** Half-width of the emitted wall band, meters (a thin band). */
export const WALL_HALF_WIDTH_M = 3;
/** Wall-band gap either side of a gate point, meters (the door opening). */
export const GATE_GAP_M = 10;
/** Double-wall resolution: a city wall-band segment whose midpoint runs within
 * this distance of a RAW `wall`-kind sketch line is suppressed — the GM's drawn
 * wall (which stage-4 elaboration decorates with towers/gates) owns that
 * stretch, so the city never double-paints a second wall alongside it. The
 * signal is the raw sketch (readable by every stage), NOT the stage-4 output
 * (that would be the forbidden reverse cascade). A no-op when there are no wall
 * sketches. */
export const SKETCHED_WALL_SUPPRESS_DIST_M = 28;
/** Hashed chance a landmark beyond the first two places at all. */
export const EXTRA_LANDMARK_P = 0.7;

export interface ArterialPath {
  coords: Pt[];
  degraded: boolean;
  /** Stable position-derived identity: `<bearingIndex>:<clipPartIndex>` — a
   * concave region can clip one routed arterial into several parts. */
  key: string;
}
export interface LandmarkFootprint {
  kind: import("./profiles").LandmarkKind;
  ring: Pt[];
}
export interface WallOutput {
  /** Closed ring-road polyline (first === last): the inset ring with every
   * gate crossing inserted as a vertex. mm-quantized. */
  ring: Pt[];
  /** Gate points — exactly the ring×arterial crossings, and exactly ring
   * vertices. mm-quantized. */
  gates: Pt[];
  /** Wall band as per-segment quads (closed rings): clean tile clipping, no
   * polygon holes, and water/gate gaps fall out as omitted segments. */
  wallSegments: Pt[][];
}
export interface SkeletonOutput {
  arterials: ArterialPath[];
  bridges: { coords: Pt[] }[];
  waterfront: { coords: Pt[] }[];
  plaza: Pt[];
  landmarks: LandmarkFootprint[];
  /** null when the profile (or its hashed wall roll, or a degenerate inset)
   * grows no wall. */
  wall: WallOutput | null;
  /** The generation center the skeleton was built around (centroid or
   * interior pole) — consumed by growth's grid prior and wards' market tag. */
  center: Pt;
}

// Fixed neighbor order N, E, S, W, NE, SE, SW, NW (y up).
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
 * coordinates make the comparator total — a 32-bit hash collision at equal
 * `(f,g)` still resolves identically (D2). */
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

/** Arterial endpoint bearings (radians) from the generation center. From
 * `routeHints` if present, else `profile.arterialCount` compass bearings
 * spread evenly with ≤30% jitter, each seeded by
 * `hashSeed(citySeed,"bearing",i)` (D2). */
function destinationBearings(
  citySeed: number,
  center: Pt,
  profile: CityProfile,
  constraints: GenerationConstraints
): number[] {
  const hints = constraints.routeHints;
  if (hints && hints.length > 0) {
    return hints.map((h) => Math.atan2(h.y - center[1], h.x - center[0]));
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

/** Consecutive bridge-span cells of a cell path — the cost field's `bridgeCell`
 * marks cells in the sketched-river crossing band OR inside the generated
 * meandered channel, so a bridge tracks the real water either way. */
function bridgeSpans(cells: Cell[], cost: CostField): Cell[][] {
  const spans: Cell[][] = [];
  let run: Cell[] = [];
  for (const c of cells) {
    if (cost.bridgeCell(c.cx, c.cy)) {
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
 * area/length degeneracy test. */
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

/**
 * Offset a CLOSED ring OUTWARD by `dist` along per-vertex outward normals (so
 * quays hug the generated channel's real bank). Winding is read from the signed
 * area so "outward" is unambiguous; unlike `offsetPolyline` this does NOT reject
 * folds — a meander ring inevitably folds on the inside of a bend, and the
 * folded points land back inside the channel, where `splitDryRuns` drops them.
 * Deterministic (pure arithmetic on the ring). Returns [] for a degenerate ring.
 */
function offsetRingOutward(ring: Pt[], dist: number): Pt[] {
  const n = ring.length - 1; // closed ring: ring[n] === ring[0]
  if (n < 3) return [];
  let area2 = 0;
  for (let i = 0; i < n; i++) {
    area2 += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  // The left normal (−dy, dx) points to the interior for a CCW ring (area2 > 0),
  // so the outward direction flips with winding.
  const outwardSign = area2 > 0 ? -1 : 1;
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const prev = ring[(i - 1 + n) % n];
    const cur = ring[i];
    const next = ring[(i + 1) % n];
    const l1 = leftUnitNormal(prev, cur);
    const l2 = leftUnitNormal(cur, next);
    let mx = l1[0] + l2[0];
    let my = l1[1] + l2[1];
    const ml = Math.hypot(mx, my) || 1;
    mx /= ml;
    my /= ml;
    out.push([cur[0] + outwardSign * dist * mx, cur[1] + outwardSign * dist * my]);
  }
  out.push(out[0]);
  return out;
}

/** Unit left-normal of edge a→b (deterministic; zero-length edge ⇒ [0,0]). */
function leftUnitNormal(a: Pt, b: Pt): Pt {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  return [-dy / len, dx / len];
}

/** Split a polyline into maximal sub-runs of consecutive points that are NOT
 * water/channel: a quay derived from an outward ring offset keeps only
 * the dry stretches, so no quay vertex ever sits inside the channel. */
function splitDryRuns(line: Pt[], idx: FabricConstraintIndex): Pt[][] {
  const runs: Pt[][] = [];
  let cur: Pt[] = [];
  for (const p of line) {
    if (blockedByWater(idx, p[0], p[1])) {
      if (cur.length > 0) runs.push(cur);
      cur = [];
    } else {
      cur.push(p);
    }
  }
  if (cur.length > 0) runs.push(cur);
  return runs;
}

// ── Plaza + landmarks ────────────────────────────────────────────────────

/** Central plaza: an 8-gon around the generation center, radius `plazaRadius`
 * with per-vertex hash jitter. Closed ring. */
function buildPlaza(citySeed: number, center: Pt, profile: CityProfile): Pt[] {
  const ring: Pt[] = [];
  const sides = 8;
  for (let i = 0; i < sides; i++) {
    const rng = mulberry32(hashSeed(citySeed, "plaza", i));
    const ang = (i / sides) * 2 * Math.PI;
    const rad = profile.plazaRadius * (0.85 + 0.3 * rng());
    ring.push([center[0] + rad * Math.cos(ang), center[1] + rad * Math.sin(ang)]);
  }
  ring.push(ring[0]);
  return ring;
}

/** Per-kind landmark footprint half-extents, meters (w across, d deep). */
const LANDMARK_HALVES: Record<import("./profiles").LandmarkKind, { w: number; d: number }> = {
  church: { w: 12, d: 20 },
  market: { w: 16, d: 10 },
  temple: { w: 14, d: 14 },
  keep: { w: 16, d: 16 },
};

/** Landmark footprints adjacent to the plaza, each a rectangle offset outward
 * at a hashed bearing and oriented to face the plaza. The first two
 * of `profile.landmarks` always place; extras (index ≥ 2) place with a hashed
 * chance, one ring farther out, for per-domain variety. */
function buildLandmarks(citySeed: number, center: Pt, profile: CityProfile): LandmarkFootprint[] {
  const out: LandmarkFootprint[] = [];
  const kinds = profile.landmarks;
  for (let i = 0; i < kinds.length; i++) {
    const kind = kinds[i];
    const rng = mulberry32(hashSeed(citySeed, "landmark", i));
    if (i >= 2 && rng() >= EXTRA_LANDMARK_P) continue; // hashed variety
    const bearing = (i / Math.max(1, kinds.length)) * 2 * Math.PI + (rng() - 0.5) * 0.6;
    const half = LANDMARK_HALVES[kind];
    const gap = 6 + (i >= 2 ? 14 : 0); // extras sit one ring out from the plaza
    const dist = profile.plazaRadius + gap + half.d;
    const bcx = center[0] + dist * Math.cos(bearing);
    const bcy = center[1] + dist * Math.sin(bearing);
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

// ── Wall / ring / gates ────────────────────────────────────────────────────

/** mm quantization for gate points (matches index.ts's emission q). */
function qmm(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/**
 * The point plaza + arterials anchor to. A GM-placed
 * `centerOverride` wins when it lies inside the ring — mm-quantized so it's
 * byte-clean (D5). If it's absent OR a later boundary edit moved it outside the
 * ring, fall back to the computed `generationCenter(region)` deterministically
 * (the host surfaces the "using automatic center" Notice; the generator just
 * stays correct + deterministic). Cityness falloff is unaffected — it reads
 * boundary distance (interiorT), never this center.
 */
function resolveGenerationCenter(region: ProcgenRegion, override?: [number, number]): Pt {
  if (override) {
    const c: Pt = [qmm(override[0]), qmm(override[1])];
    if (regionContains(region, c[0], c[1])) return c;
  }
  return generationCenter(region);
}

interface GateHit {
  p: Pt; // mm-quantized crossing point
  ringEdge: number; // index into the inset ring's edges
  u: number; // parameter along that ring edge
}

/** First crossing of an arterial polyline with the inset ring, walking the
 * arterial from its start (the center end): the gate where the road leaves
 * the walled core. Deterministic: segments in order, min arterial-parameter,
 * ties by ring-edge index. */
function firstRingCrossing(arterial: Pt[], ring: Pt[]): GateHit | null {
  for (let i = 0; i < arterial.length - 1; i++) {
    const [ax, ay] = arterial[i];
    const [bx, by] = arterial[i + 1];
    let best: { t: number; hit: GateHit } | null = null;
    for (let j = 0; j < ring.length - 1; j++) {
      const [px, py] = ring[j];
      const [qx, qy] = ring[j + 1];
      const d = (bx - ax) * (qy - py) - (by - ay) * (qx - px);
      if (d === 0) continue;
      const t = ((px - ax) * (qy - py) - (py - ay) * (qx - px)) / d;
      const u = ((px - ax) * (by - ay) - (py - ay) * (bx - ax)) / d;
      if (t < 0 || t > 1 || u < 0 || u > 1) continue;
      if (best === null || t < best.t || (t === best.t && j < best.hit.ringEdge)) {
        best = {
          t,
          hit: {
            p: [qmm(ax + t * (bx - ax)), qmm(ay + t * (by - ay))],
            ringEdge: j,
            u,
          },
        };
      }
    }
    if (best) return best.hit;
  }
  return null;
}

/**
 * Build the ring road, gates, and wall band: the ring is
 * `insetRing(region, (1 − ringRadiusFrac) × effectiveRadius)` — it traces
 * the sketched outline; the profile's center-distance fraction becomes a
 * boundary inset scaled off effectiveRadius. Gates are the first crossing of
 * each (clipped) arterial with that ring, INSERTED AS RING VERTICES in
 * ring-parameter order — position-keyed insertion, so every gate lies
 * bit-exactly on the emitted ring polyline and exactly on its arterial. The
 * wall band is per-segment quads, omitted inside sketched water and around
 * gates — the ring POLYLINE stays topologically closed. Degenerate insets
 * (concave rings, oversized insets) come back [] from insetRing and mean
 * "no wall" — never a throw.
 */
/** Does (x,y) run alongside a RAW `wall`-kind sketch line (double-wall
 * resolution)? True ⇒ the city suppresses its own wall band here. `false` when
 * there are no sketched walls. */
function suppressedBySketchedWall(idx: FabricConstraintIndex, x: number, y: number): boolean {
  for (const wall of idx.wallLines) {
    if (wall.length >= 2 && nearestOnLine(wall, x, y).dist < SKETCHED_WALL_SUPPRESS_DIST_M) return true;
  }
  return false;
}

function buildWall(
  citySeed: number,
  region: ProcgenRegion,
  profile: CityProfile,
  arterials: ArterialPath[],
  blockedAt: (x: number, y: number) => boolean,
  suppressedAt: (x: number, y: number) => boolean
): WallOutput | null {
  const wantWall =
    profile.hasWall || (profile.wallChance > 0 && mulberry32(hashSeed(citySeed, "wall"))() < profile.wallChance);
  if (!wantWall) return null;

  const inset = (1 - profile.ringRadiusFrac) * region.effectiveRadius;
  if (inset <= 0 || profile.ringRadiusFrac <= 0) return null;
  const base = insetRing(region, inset);
  if (base.length < 4) return null; // degenerate inset — no wall

  // Gates: first ring crossing per arterial part. Dedupe identical points
  // (two parts of one clipped arterial can cross at the same spot).
  const hits: GateHit[] = [];
  const seen = new Set<string>();
  for (const art of arterials) {
    const hit = firstRingCrossing(art.coords, base);
    if (!hit) continue;
    const key = `${hit.p[0]},${hit.p[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push(hit);
  }
  if (hits.length < 3) return null; // no closed ring worth building

  // Insert gates as ring vertices in ring-parameter order (edge index, then
  // parameter along the edge, then coordinates — total order, D2).
  hits.sort((a, b) => a.ringEdge - b.ringEdge || a.u - b.u || a.p[0] - b.p[0] || a.p[1] - b.p[1]);
  const ring: Pt[] = [];
  let hi = 0;
  for (let j = 0; j < base.length - 1; j++) {
    ring.push(base[j]);
    while (hi < hits.length && hits[hi].ringEdge === j) {
      const p = hits[hi].p;
      const last = ring[ring.length - 1];
      if (last[0] !== p[0] || last[1] !== p[1]) ring.push(p);
      hi++;
    }
  }
  ring.push(ring[0]); // closed

  // Wall band quads per ring segment; gaps at gates and over sketched water.
  const gatePts = hits.map((h) => h.p);
  const wallSegments: Pt[][] = [];
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i];
    const b = ring[i + 1];
    const mx = (a[0] + b[0]) / 2;
    const my = (a[1] + b[1]) / 2;
    if (gatePts.some(([gx, gy]) => Math.hypot(gx - mx, gy - my) < GATE_GAP_M)) continue; // gate opening
    if (blockedAt(mx, my)) continue; // wall band segmented at water (river gap)
    if (suppressedAt(mx, my)) continue; // a raw wall sketch owns this stretch
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * WALL_HALF_WIDTH_M;
    const ny = (dx / len) * WALL_HALF_WIDTH_M;
    const quad: Pt[] = [
      [a[0] + nx, a[1] + ny],
      [b[0] + nx, b[1] + ny],
      [b[0] - nx, b[1] - ny],
      [a[0] - nx, a[1] - ny],
    ];
    quad.push(quad[0]);
    wallSegments.push(quad);
  }

  return { ring, gates: gatePts, wallSegments };
}

// ── Orchestration ──────────────────────────────────────────────────────────

/**
 * Build the whole Stage-A skeleton for a region. Pure — reads only its
 * arguments and the cost field derived from them. Returns raw world geometry
 * (except the pre-quantized wall ring/gates); `index.ts` handles
 * quantization, ids, and canonical ordering.
 */
export function buildSkeleton(
  citySeed: number,
  region: ProcgenRegion,
  profile: CityProfile,
  constraints: GenerationConstraints,
  cost: CostField,
  centerOverride?: [number, number]
): SkeletonOutput {
  const center = resolveGenerationCenter(region, centerOverride);
  const centerCell: Cell = { cx: cellOf(center[0]), cy: cellOf(center[1]) };

  // 1) Arterials + their bridge sub-spans. Endpoints are the first boundary
  // crossing of each bearing ray from the center; the routed+smoothed path
  // is clipped to the region so no part escapes the sketch (a concave region
  // can split one arterial into several keyed parts).
  const bearings = destinationBearings(citySeed, center, profile, constraints);
  const arterials: ArterialPath[] = [];
  const rawBridgeSpans: { cells: Cell[]; crossing: Pt }[] = [];
  bearings.forEach((theta, i) => {
    const endpoint = boundaryPointFrom(region, center[0], center[1], theta);
    if (!endpoint) return; // cannot happen for a contained center; defensive
    const goalCell: Cell = { cx: cellOf(endpoint[0]), cy: cellOf(endpoint[1]) };
    const { path, degraded } = astar(citySeed, centerCell, goalCell, cost);
    if (path.length < 2) return;
    const world: Pt[] = path.map((c) => [worldOf(c.cx), worldOf(c.cy)]);
    const smooth = chaikinSmooth(world, ARTERIAL_SMOOTH_ITERATIONS);
    clipPolylineToRegion(region, smooth).forEach((part, partIndex) => {
      if (part.length < 2) return;
      arterials.push({ coords: part, degraded, key: `${i}:${partIndex}` });
    });
    for (const span of bridgeSpans(path, cost)) {
      const mid = span[Math.floor(span.length / 2)];
      rawBridgeSpans.push({ cells: span, crossing: [worldOf(mid.cx), worldOf(mid.cy)] });
    }
  });

  // Share bridges: crossings within BRIDGE_SHARE_DIST keep one span. Process in
  // a canonical order (crossing x, then y) so the survivor is deterministic.
  // Bridge polylines are clipped to the region like everything else.
  rawBridgeSpans.sort((a, b) => a.crossing[0] - b.crossing[0] || a.crossing[1] - b.crossing[1]);
  const bridges: { coords: Pt[] }[] = [];
  const kept: Pt[] = [];
  for (const cand of rawBridgeSpans) {
    if (kept.some((k) => Math.hypot(k[0] - cand.crossing[0], k[1] - cand.crossing[1]) < BRIDGE_SHARE_DIST_M)) continue;
    kept.push(cand.crossing);
    const world: Pt[] = cand.cells.map((c) => [worldOf(c.cx), worldOf(c.cy)]);
    for (const run of clipPolylineToRegion(region, world)) {
      if (run.length >= 2) bridges.push({ coords: run });
    }
  }

  // 2) Waterfront quay streets (euro profiles only, via non-empty offsets).
  // No distance pre-filter: a river that never enters the region clips to
  // nothing, which is the same answer the old disc pre-filter gave.
  const waterfront: { coords: Pt[] }[] = [];
  if (profile.waterfrontOffsets.length > 0) {
    const idx = indexConstraints(constraints);
    if (idx.channelRings.length > 0) {
      // The generated meandered channel supersedes the sketched spine.
      // Quays hug its real bank — offset each channel ring OUTWARD and keep the
      // dry stretches (folded/inner points fall in the channel and are dropped),
      // so quays track the channel and never sit in the water.
      for (const ring of idx.channelRings) {
        for (const off of profile.waterfrontOffsets) {
          const offsetRing = offsetRingOutward(ring, off);
          if (offsetRing.length < 2) continue;
          for (const clipped of clipPolylineToRegion(region, offsetRing)) {
            for (const dry of splitDryRuns(clipped, idx)) {
              if (dry.length >= 2) waterfront.push({ coords: dry });
            }
          }
        }
      }
    } else {
      // No distance pre-filter: a river that never enters the region clips to
      // nothing.
      for (const river of idx.riverLines) {
        for (const off of profile.waterfrontOffsets) {
          for (const side of [1, -1]) {
            const offsetLine = offsetPolyline(river, off, side);
            if (!offsetLine) continue;
            for (const run of clipPolylineToRegion(region, offsetLine)) {
              if (run.length >= 2) waterfront.push({ coords: run });
            }
          }
        }
      }
    }
  }

  // 3) Plaza + landmarks around the generation center.
  const plaza = buildPlaza(citySeed, center, profile);
  const landmarks = buildLandmarks(citySeed, center, profile);

  // 4) Wall / ring / gates (the wall traces the sketch). Water test reuses the
  // constraint index (incl. the generated channel) so the wall band is
  // segmented at rivers and the meandered channel alike.
  const wallIdx = indexConstraints(constraints);
  const wall = buildWall(
    citySeed,
    region,
    profile,
    arterials,
    (x, y) => blockedByWater(wallIdx, x, y),
    (x, y) => suppressedBySketchedWall(wallIdx, x, y)
  );

  return { arterials, bridges, waterfront, plaza, landmarks, wall, center };
}
