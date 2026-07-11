/**
 * Stage B growth loop (procgen v3 §5.2): Parish & Müller priority-queue street
 * growth with the classic local constraints — snap to node, cut crossings into
 * T-junctions, trim to edge interiors — seeded along the Stage-A skeleton and
 * run on the 1 cm integer lattice of `graph.ts`, inside the domain disc, until
 * `profile.maxSegments` or an empty queue (D3: budgets, not convergence).
 *
 * Determinism argument (§4, all six):
 *  - D1: every committed vertex is an int lattice point; all topology
 *    predicates are exact int arithmetic in `graph.ts`.
 *  - D2: the queue is a binary heap over a TOTAL order — (priority,
 *    candidateId, parentEdgeId, branchIndex) where `candidateId =
 *    hashSeed(citySeed, parentEdgeId, branchIndex)` — so no tie is ever
 *    resolved by insertion order, even under 32-bit hash collisions. Every
 *    graph query used here tie-breaks by id.
 *  - D3: hard budgets on committed segments AND on queue pops; the prune pass
 *    is bounded. Nothing loops "until it looks done".
 *  - D4: trig appears only in direction sampling (tensor prior, jitter);
 *    every gate is an inequality against lattice-derived quantities.
 *  - D5: emission converts int cm back to float meters (exact mm multiples);
 *    chains are collected in sorted-edge order.
 *  - D6: reads only its arguments — the per-candidate RNG streams derive from
 *    candidateId alone.
 *
 * Seam story unchanged: growth happens once per domain inside
 * `generateCityNetwork`; tiles clip the finished artifact.
 */
import { hashSeed, mulberry32 } from "../rng";
import type { GenerationConstraints } from "../types";
import {
  blockedByWater,
  crossesWall,
  fabricAngleSampler,
  indexFabricConstraints,
  type FabricConstraintIndex,
} from "../fabricConstraints";
import { buildTensorField, sampleFieldAngle } from "../city/tensorField";
import { chaikinSmooth } from "../city/corridor";
import type { CityDomain } from "./domain";
import type { CityProfile } from "./profiles";
import { CANON_RADIUS_M } from "./costField";
import { makeCityness, type CitynessFn } from "./cityness";
import type { SkeletonOutput } from "./skeleton";
import { clipToDisc } from "./skeleton";
import { StreetGraph, toLattice, toMeters, type GraphNode } from "./graph";

type Pt = [number, number];

/** Queue-pop budget multiplier over `maxSegments` (D3 — bounds rejection
 * storms; growth can never spin longer than this many pops). */
export const MAX_POPS_PER_SEGMENT = 12;
/** Weight of the tensor-field orientation prior blended into continuation
 * directions (0 = ignore field, 1 = follow field exactly). */
export const TENSOR_BLEND = 0.25;
/** Priority bonus for straight continuations — streets extend before side
 * branches of equal cityness fire, giving legible through-streets. */
export const CONTINUE_BIAS = 0.15;
/** Spacing (in units of profile.segmentLen) between branch seeds walked along
 * the Stage-A skeleton polylines. */
export const SEED_SPACING_FACTOR = 1.0;
/** Bounded dead-end prune passes (D3). */
export const MAX_PRUNE_PASSES = 8;
/** Vertex spacing (meters) of skeleton polylines as inserted into the GRAPH
 * (emitted features keep full smooth geometry) — keeps face rings lean. */
export const GRAPH_RESAMPLE_M = 8;
/** Minimum clearance between a grown segment (its whole span, not just the
 * endpoint) and a canon Point — never pave the GM's pins (I4). Endpoints get
 * the stricter `CANON_RADIUS_M`; interiors this. */
export const CANON_SEGMENT_CLEARANCE_M = 20;

interface Candidate {
  /** hashSeed(citySeed, parentEdgeId, branchIndex) — the D2 tiebreaker and
   * the candidate's RNG stream root. */
  id: number;
  parentEdgeId: string;
  branchIndex: number;
  fromKey: string;
  /** Proposed direction, radians (world frame). */
  dir: number;
  priority: number;
}

/** Total order for the heap: priority desc, then id asc, then parentEdgeId,
 * then branchIndex — total even under candidateId collisions (D2). */
function candLess(a: Candidate, b: Candidate): boolean {
  if (a.priority !== b.priority) return a.priority > b.priority;
  if (a.id !== b.id) return a.id < b.id;
  if (a.parentEdgeId !== b.parentEdgeId) return a.parentEdgeId < b.parentEdgeId;
  return a.branchIndex < b.branchIndex;
}

class CandidateHeap {
  private items: Candidate[] = [];
  get size(): number {
    return this.items.length;
  }
  push(c: Candidate): void {
    const items = this.items;
    items.push(c);
    let i = items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (candLess(items[i], items[p])) {
        [items[i], items[p]] = [items[p], items[i]];
        i = p;
      } else break;
    }
  }
  pop(): Candidate | undefined {
    const items = this.items;
    if (items.length === 0) return undefined;
    const top = items[0];
    const last = items.pop() as Candidate;
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        let m = i;
        if (l < items.length && candLess(items[l], items[m])) m = l;
        if (r < items.length && candLess(items[r], items[m])) m = r;
        if (m === i) break;
        [items[i], items[m]] = [items[m], items[i]];
        i = m;
      }
    }
    return top;
  }
}

/** Distance from point (px,py) to segment (ax,ay)→(bx,by), meters. */
function pointSegDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Smallest absolute difference between two directions, folded to [0, π]. */
function angDiff(a: number, b: number): number {
  let d = Math.abs(a - b) % (2 * Math.PI);
  if (d > Math.PI) d = 2 * Math.PI - d;
  return d;
}

/** Signed difference from `theta` to the nearest mod-π representative of the
 * line angle `prior`, in (−π/2, π/2] — for blending an orientation field
 * (direction-free) into a directed street heading. */
function lineAngleDelta(prior: number, theta: number): number {
  let d = (prior - theta) % Math.PI;
  if (d > Math.PI / 2) d -= Math.PI;
  if (d <= -Math.PI / 2) d += Math.PI;
  return d;
}

/** Insert a world-meter polyline into the graph as a chain of lattice edges.
 * Returns the inserted node keys in order (consecutive duplicates dropped). */
function insertPolyline(
  graph: StreetGraph,
  coords: Pt[],
  props: { roadClass: string; grown: boolean; sketch: boolean }
): string[] {
  const keys: string[] = [];
  let prev: GraphNode | null = null;
  for (const [xm, ym] of coords) {
    const x = toLattice(xm);
    const y = toLattice(ym);
    if (prev && prev.x === x && prev.y === y) continue;
    const node = graph.addNode(x, y);
    if (prev) insertSegmentPlanar(graph, prev.key, node.key, props);
    keys.push(node.key);
    prev = node;
  }
  return keys;
}

/** Planarization budget per inserted segment (D3) — a single ~8 m skeleton
 * segment cannot legitimately cross more edges than this. */
const MAX_SEGMENT_SPLITS = 32;

/**
 * Insert edge a→b, noding EVERY crossing with existing edges (v3.2
 * prerequisite: faces need a true planar graph, so skeleton×skeleton and
 * sketch×skeleton crossings become nodes too — growth already terminates its
 * own segments at their first crossing). Deterministic: `firstCrossing`
 * returns the minimum-t crossing with id tie-breaks, and the walk from a to b
 * consumes crossings in that order. Never throws — on budget exhaustion the
 * remaining sub-segment is inserted uncut (counted by planarity being
 * imperfect, not by a crash; anti-Watabou).
 */
function insertSegmentPlanar(
  graph: StreetGraph,
  aKey: string,
  bKey: string,
  props: { roadClass: string; grown: boolean; sketch: boolean }
): void {
  let curKey = aKey;
  for (let i = 0; i < MAX_SEGMENT_SPLITS; i++) {
    if (curKey === bKey) return;
    const target = graph.getNode(bKey)!;
    const hit = graph.firstCrossing(curKey, target.x, target.y);
    if (!hit) break;
    const mid = graph.splitEdge(hit.edge.id, hit.x, hit.y);
    if (!mid || mid.key === curKey) break;
    graph.addEdge(curKey, mid.key, { ...props });
    curKey = mid.key;
  }
  if (curKey !== bKey) graph.addEdge(curKey, bKey, { ...props });
}

/** Resample a polyline to ~`spacing`-meter vertex intervals (keeping first and
 * last vertices). The emitted skeleton features keep their full smooth
 * geometry; only the GRAPH gets the resampled version — fewer nodes, fewer
 * face-ring vertices, and OBB parcelling stays cheap. Max deviation from the
 * smooth curve is the chord sagitta (centimeter-scale for chaikin output). */
export function resamplePolyline(coords: Pt[], spacing: number): Pt[] {
  if (coords.length <= 2) return coords;
  const out: Pt[] = [coords[0]];
  let acc = 0;
  for (let i = 1; i < coords.length; i++) {
    const [ax, ay] = coords[i - 1];
    const [bx, by] = coords[i];
    acc += Math.hypot(bx - ax, by - ay);
    if (acc >= spacing || i === coords.length - 1) {
      out.push(coords[i]);
      acc = 0;
    }
  }
  return out;
}

/** Walk a seed polyline's inserted nodes at ~`spacing` arc-length intervals,
 * emitting perpendicular branch candidates on both sides (§5.2 "queue ←
 * branch candidates along arterials/waterfront"). */
function seedAlongPolyline(
  citySeed: number,
  graph: StreetGraph,
  nodeKeys: string[],
  pseudoParentId: string,
  spacing: number,
  cityness: CitynessFn,
  heap: CandidateHeap
): void {
  let acc = spacing * 0.5; // start mid-interval so seeds avoid the very center
  let sampleIndex = 0;
  for (let i = 1; i < nodeKeys.length; i++) {
    const a = graph.getNode(nodeKeys[i - 1])!;
    const b = graph.getNode(nodeKeys[i])!;
    const segLen = toMeters(Math.hypot(b.x - a.x, b.y - a.y));
    acc += segLen;
    if (acc < spacing) continue;
    acc -= spacing;
    const tangent = Math.atan2(b.y - a.y, b.x - a.x);
    const c = cityness(toMeters(b.x), toMeters(b.y));
    for (const side of [0, 1]) {
      const branchIndex = sampleIndex * 2 + side;
      heap.push({
        id: hashSeed(citySeed, pseudoParentId, branchIndex),
        parentEdgeId: pseudoParentId,
        branchIndex,
        fromKey: b.key,
        dir: tangent + (side === 0 ? Math.PI / 2 : -Math.PI / 2),
        priority: c,
      });
    }
    sampleIndex++;
  }
}

export interface GrowthStats {
  committed: number;
  pops: number;
  pruned: number;
}

/**
 * Run Stage B: pre-seed the graph with the Stage-A skeleton and the GM's
 * sketched roads (immutable — snapped TO, never trimmed, never re-emitted),
 * grow streets by priority queue, then prune short dead-end stubs. Returns
 * the graph (grown edges flagged `grown`) plus budget stats.
 */
export function growNetwork(
  citySeed: number,
  domain: CityDomain,
  profile: CityProfile,
  constraints: GenerationConstraints,
  skeleton: SkeletonOutput
): { graph: StreetGraph; stats: GrowthStats } {
  const graph = new StreetGraph();
  const idx = indexFabricConstraints(constraints.fabricFeatures);
  const cityness = makeCityness(citySeed, domain);
  const heap = new CandidateHeap();
  const spacing = profile.segmentLen * SEED_SPACING_FACTOR;

  // Orientation prior: tensor field blended with sketched-road alignment via
  // the existing machinery (§5.2). Seeded by citySeed — pure (D6).
  const field = buildTensorField(citySeed, constraints.worldBounds);
  const sampler = fabricAngleSampler(field, idx) ?? ((x: number, y: number) => sampleFieldAngle(field, x, y));

  // ── Pre-seed the graph ───────────────────────────────────────────────────
  // Stage-A arterials/waterfront: snappable targets + branch-candidate spines.
  // Polylines are resampled to ~GRAPH_RESAMPLE_M for the graph (the emitted
  // features keep full smooth geometry) and inserted PLANAR (v3.2): every
  // skeleton×skeleton and sketch×skeleton crossing becomes a node, which face
  // extraction requires.
  skeleton.arterials.forEach((art, i) => {
    const keys = insertPolyline(graph, resamplePolyline(art.coords, GRAPH_RESAMPLE_M), {
      roadClass: "arterial",
      grown: false,
      sketch: false,
    });
    seedAlongPolyline(citySeed, graph, keys, `seed:art:${i}`, spacing, cityness, heap);
  });
  skeleton.waterfront.forEach((w, i) => {
    const keys = insertPolyline(graph, resamplePolyline(w.coords, GRAPH_RESAMPLE_M), {
      roadClass: "street",
      grown: false,
      sketch: false,
    });
    seedAlongPolyline(citySeed, graph, keys, `seed:wf:${i}`, spacing, cityness, heap);
  });
  // Sketched roads (I4): immutable edges, clipped to the disc and smoothed the
  // same way corridors are. Generated streets snap TO them; they are never
  // pruned and never re-emitted (the sketch already renders as fabric).
  idx.roadLines.forEach((road) => {
    const smoothed = chaikinSmooth(road, 2);
    for (const run of clipToDisc(smoothed, domain.cx, domain.cy, domain.radius)) {
      insertPolyline(graph, resamplePolyline(run, GRAPH_RESAMPLE_M), {
        roadClass: "street",
        grown: false,
        sketch: true,
      });
    }
  });

  const canon: Pt[] = [];
  for (const f of constraints.canonFeatures ?? []) {
    if (f.geometry.type === "Point") canon.push(f.geometry.coordinates as Pt);
  }

  const snapCm = toLattice(profile.snapDist);
  const minEdgeCm = toLattice(profile.minEdge);
  const segLenCm = toLattice(profile.segmentLen);
  const maxPops = profile.maxSegments * MAX_POPS_PER_SEGMENT;

  /** Away-direction angle check at a junction node (§5.2 minAngle): the new
   * edge must not form a sliver with any incident edge. Directions point AWAY
   * from the node, so a straight continuation (~180° through the node) passes
   * while a near-duplicate heading (~0°) is rejected. */
  const junctionAngleOk = (nodeKey: string, newDirAway: number): boolean => {
    const n = graph.getNode(nodeKey);
    if (!n) return true;
    for (const id of graph.incidentEdges(nodeKey)) {
      const e = graph.getEdge(id);
      if (!e) continue;
      const otherKey = e.a === nodeKey ? e.b : e.a;
      const o = graph.getNode(otherKey);
      if (!o) continue;
      const dirAway = Math.atan2(o.y - n.y, o.x - n.x);
      if (angDiff(dirAway, newDirAway) < profile.minAngle) return false;
    }
    return true;
  };

  // ── The growth loop ──────────────────────────────────────────────────────
  let committed = 0;
  let pops = 0;
  while (heap.size > 0 && committed < profile.maxSegments && pops < maxPops) {
    pops++;
    const cand = heap.pop() as Candidate;
    const from = graph.getNode(cand.fromKey);
    if (!from) continue;
    if (graph.degree(cand.fromKey) >= 4) continue; // saturated junction

    // Proposed endpoint on the int lattice.
    let ex = Math.round(from.x + segLenCm * Math.cos(cand.dir));
    let ey = Math.round(from.y + segLenCm * Math.sin(cand.dir));
    const exM = toMeters(ex);
    const eyM = toMeters(ey);
    const fxM = toMeters(from.x);
    const fyM = toMeters(from.y);

    // Local constraints — rejections first (cheapest to most structural).
    if (Math.hypot(exM - domain.cx, eyM - domain.cy) > domain.radius) continue; // domain disc
    if (cityness(exM, eyM) < profile.edge) continue; // growth extent (§5.4)
    if (canon.some(([px, py]) => Math.hypot(px - exM, py - eyM) < CANON_RADIUS_M)) continue; // canon clearance (end)
    if (canon.some(([px, py]) => pointSegDist(px, py, fxM, fyM, exM, eyM) < CANON_SEGMENT_CLEARANCE_M)) continue; // canon clearance (span)
    if (blockedByWater(idx, exM, eyM) || blockedByWater(idx, (fxM + exM) / 2, (fyM + eyM) / 2)) continue; // water (bridges are Stage-A only)
    if (crossesWall(idx, [fxM, fyM], [exM, eyM])) continue; // sketched walls: never cross (no gates yet)

    // Snap to an existing node within snapDist of the proposed end.
    let terminal = false;
    let splitEdgeId: string | null = null;
    const snapNode = graph.nearestNodeWithin(ex, ey, snapCm, from.key);
    if (snapNode) {
      ex = snapNode.x;
      ey = snapNode.y;
      terminal = true;
    }

    // First proper crossing wins over the snap (it is physically first).
    const crossing = graph.firstCrossing(from.key, ex, ey);
    if (crossing) {
      const ce = crossing.edge;
      const a = graph.getNode(ce.a)!;
      const b = graph.getNode(ce.b)!;
      const psi = Math.atan2(b.y - a.y, b.x - a.x);
      const theta = Math.atan2(ey - from.y, ex - from.x);
      // Crossing angle as undirected lines must clear minAngle both ways.
      if (Math.min(angDiff(theta, psi), Math.PI - angDiff(theta, psi)) < profile.minAngle) continue;
      ex = crossing.x;
      ey = crossing.y;
      splitEdgeId = ce.id;
      terminal = true;
    } else if (!snapNode) {
      // Extend/trim to a nearby edge interior (T-junction).
      const near = graph.nearestEdgeWithin(ex, ey, snapCm, from.key);
      if (near) {
        const a = graph.getNode(near.edge.a)!;
        const b = graph.getNode(near.edge.b)!;
        const psi = Math.atan2(b.y - a.y, b.x - a.x);
        const theta = Math.atan2(near.y - from.y, near.x - from.x);
        if (Math.min(angDiff(theta, psi), Math.PI - angDiff(theta, psi)) < profile.minAngle) continue;
        // Planarity recheck (v3.2): the trim moved the endpoint sideways (up
        // to snapDist), so the trimmed segment can cross an edge the proposed
        // one did not. A crossing is physically first — prefer cutting there.
        const recheck = graph.firstCrossing(from.key, near.x, near.y);
        if (recheck && recheck.edge.id !== near.edge.id) {
          const ra = graph.getNode(recheck.edge.a)!;
          const rb = graph.getNode(recheck.edge.b)!;
          const rpsi = Math.atan2(rb.y - ra.y, rb.x - ra.x);
          const rtheta = Math.atan2(recheck.y - from.y, recheck.x - from.x);
          if (Math.min(angDiff(rtheta, rpsi), Math.PI - angDiff(rtheta, rpsi)) < profile.minAngle) continue;
          ex = recheck.x;
          ey = recheck.y;
          splitEdgeId = recheck.edge.id;
        } else {
          ex = near.x;
          ey = near.y;
          splitEdgeId = near.edge.id;
        }
        terminal = true;
      }
    }

    // Resulting-edge validity.
    const newLenCm = Math.hypot(ex - from.x, ey - from.y);
    if (newLenCm < minEdgeCm) continue;
    // Re-check canon span clearance: snap/cut may have moved the endpoint.
    if (canon.some(([px, py]) => pointSegDist(px, py, fxM, fyM, toMeters(ex), toMeters(ey)) < CANON_SEGMENT_CLEARANCE_M)) continue;
    const theta = Math.atan2(ey - from.y, ex - from.x);
    if (!junctionAngleOk(from.key, theta)) continue;
    if (snapNode && !splitEdgeId) {
      if (graph.hasEdge(from.key, snapNode.key)) continue;
      if (!junctionAngleOk(snapNode.key, theta + Math.PI)) continue;
      if (graph.degree(snapNode.key) >= 4) continue;
    }

    // Commit (mutations only from here).
    let endKey: string;
    if (splitEdgeId) {
      const node = graph.splitEdge(splitEdgeId, ex, ey);
      if (!node) continue;
      if (node.key === from.key || graph.hasEdge(from.key, node.key)) continue;
      endKey = node.key;
    } else if (snapNode) {
      endKey = snapNode.key;
    } else {
      endKey = graph.addNode(ex, ey).key;
    }
    const edge = graph.addEdge(from.key, endKey, { roadClass: "street", grown: true, sketch: false });
    if (!edge) continue;
    committed++;
    if (terminal) continue; // ended at a junction — no children

    // Spawn children (D2: ids from (citySeed, parentEdgeId, branchIndex)).
    const rng = mulberry32(hashSeed(citySeed, edge.id, "children"));
    const endCityness = cityness(toMeters(ex), toMeters(ey));

    // 0: straight continuation — hashed per-segment curvature + tensor prior.
    const curv = (rng() * 2 - 1) * profile.curvature;
    let contDir = theta + curv;
    contDir += TENSOR_BLEND * lineAngleDelta(sampler(toMeters(ex), toMeters(ey)), contDir);
    heap.push({
      id: hashSeed(citySeed, edge.id, 0),
      parentEdgeId: edge.id,
      branchIndex: 0,
      fromKey: endKey,
      dir: contDir,
      priority: endCityness + CONTINUE_BIAS,
    });

    // 1/2: side branches, probability modulated by cityness (§5.4).
    const pBranch = Math.min(0.9, profile.branchProb * (0.5 + endCityness));
    for (const [branchIndex, sign] of [
      [1, 1],
      [2, -1],
    ] as const) {
      const roll = rng();
      if (roll >= pBranch) continue;
      const jitter = (rng() * 2 - 1) * profile.branchAngleJitter;
      heap.push({
        id: hashSeed(citySeed, edge.id, branchIndex),
        parentEdgeId: edge.id,
        branchIndex,
        fromKey: endKey,
        dir: theta + sign * (profile.branchAngle + jitter),
        priority: endCityness,
      });
    }
  }

  const pruned = pruneDeadEnds(graph, profile);
  return { graph, stats: { committed, pops, pruned } };
}

/**
 * Dead-end pruning (§5.2): remove grown stubs shorter than `profile.minStub`
 * hanging off degree-1 nodes, in deterministic node-key order, repeated to a
 * bounded fixpoint (D3). Cul-de-sac profiles keep their stubs — unsnapped
 * ends ARE the courts. Seed/sketch edges are never pruned.
 */
export function pruneDeadEnds(graph: StreetGraph, profile: CityProfile): number {
  if (profile.culdesacs) return 0;
  const minStubCm = toLattice(profile.minStub);
  let removedTotal = 0;
  for (let pass = 0; pass < MAX_PRUNE_PASSES; pass++) {
    let removed = 0;
    for (const key of graph.sortedNodeKeys()) {
      if (graph.degree(key) !== 1) continue;
      const [edgeId] = graph.incidentEdges(key);
      const edge = graph.getEdge(edgeId);
      if (!edge || !edge.props.grown) continue;
      const a = graph.getNode(edge.a)!;
      const b = graph.getNode(edge.b)!;
      if (Math.hypot(b.x - a.x, b.y - a.y) < minStubCm) {
        graph.removeEdge(edgeId);
        removed++;
      }
    }
    removedTotal += removed;
    if (removed === 0) break;
  }
  return removedTotal;
}

/**
 * Collect grown edges as merged polylines: chains of grown edges joined
 * through degree-2 nodes become single LineStrings (feature-count discipline
 * — themes see streets, not 4000 two-point segments). Deterministic: edges
 * are visited in sorted-id order and chains extend by the unique continuation
 * at each degree-2 node. Coordinates return in float meters (exact mm).
 */
export function collectGrownChains(graph: StreetGraph): { key: string; coords: Pt[] }[] {
  const grown = graph.sortedEdges().filter((e) => e.props.grown);
  const visited = new Set<string>();

  /** The unique grown continuation of `edgeId` through `nodeKey`, if the node
   * joins exactly two grown edges and nothing else. */
  const continuation = (edgeId: string, nodeKey: string): string | null => {
    const incident = graph.incidentEdges(nodeKey);
    if (incident.length !== 2) return null;
    const other = incident[0] === edgeId ? incident[1] : incident[0];
    const e = graph.getEdge(other);
    return e && e.props.grown ? other : null;
  };

  const chains: { key: string; coords: Pt[] }[] = [];
  for (const start of grown) {
    if (visited.has(start.id)) continue;
    // Walk both directions from the start edge to the chain's ends.
    const chainEdges: string[] = [start.id];
    visited.add(start.id);
    let headNode = start.a;
    let tailNode = start.b;
    let headEdge = start.id;
    let tailEdge = start.id;
    for (;;) {
      const next = continuation(headEdge, headNode);
      if (!next || visited.has(next)) break;
      visited.add(next);
      chainEdges.unshift(next);
      const e = graph.getEdge(next)!;
      headNode = e.a === headNode ? e.b : e.a;
      headEdge = next;
    }
    for (;;) {
      const next = continuation(tailEdge, tailNode);
      if (!next || visited.has(next)) break;
      visited.add(next);
      chainEdges.push(next);
      const e = graph.getEdge(next)!;
      tailNode = e.a === tailNode ? e.b : e.a;
      tailEdge = next;
    }
    // Stitch node coords head→tail.
    const coords: Pt[] = [];
    let cursor = headNode;
    coords.push([toMeters(graph.getNode(cursor)!.x), toMeters(graph.getNode(cursor)!.y)]);
    for (const id of chainEdges) {
      const e = graph.getEdge(id)!;
      cursor = e.a === cursor ? e.b : e.a;
      const n = graph.getNode(cursor)!;
      coords.push([toMeters(n.x), toMeters(n.y)]);
    }
    chains.push({ key: `${headNode}>${tailNode}#${chainEdges.length}`, coords });
  }
  return chains;
}
