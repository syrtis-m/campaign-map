/**
 * Cross-layer regen cascade — the stage DAG.
 *
 * The suite feels like one world (not independent stamps) because a layer-2
 * procgen edit propagates to the layer-1 fabric that reads it: turn a river's
 * windiness up, the city around it regenerates. That propagation is (a)
 * cycle-free BY CONSTRUCTION and (b) deterministic, via a fixed global partial
 * order over STAGES:
 *
 *   0 elevation   (mountain — a FIELD)
 *   1 hydrology   (river, water bodies)
 *   2 vegetation  (forest, park, farmland — agriculture is grouped here: it
 *                  consumes stage-0 elevation and produces nothing downstream)
 *   3 settlement  (city)
 *   4 detail      (wall elaboration, future street furniture)
 *
 * An algorithm consumes constraints only from STRICTLY LOWER stages (plus raw
 * sketches + canon, unchanged). Same-stage regions never see each other's
 * OUTPUT (only each other's sketch), so there is no ordering ambiguity and no
 * cycle, ever.
 *
 * PURE / headless (imports only `BBox` from spatialHash) — no registry, no
 * generators, no DOM/map/Obsidian. The controller builds `DagNode`s by reading
 * each region's algorithm (stage/produces/consumes) from the registry and its
 * bbox from `region.ts`; this module is graph math over those nodes only, so it
 * stays a leaf both the host and (via serialized nodes) a worker can run.
 *
 * ── Edge rule ────────────────────────────────────────────────────────────────
 * `produces`/`consumes` ConstraintKinds say WHICH field a downstream actually
 * reads; the edge test intersects them with a bbox overlap:
 *
 *   A → B  iff  stage(A) < stage(B)
 *          ∧    produces(A) ∩ consumes(B) ≠ ∅
 *          ∧    bbox(A) grown by `margin` overlaps bbox(B)
 *
 * This is strictly TIGHTER than a bbox-only rule: it drops the wasteful
 * "recompute every higher-stage region in bbox even if it reads nothing this
 * one produces" edges (e.g. a city, which consumes water/vegetation, is NOT a
 * dependent of a mountain, which produces elevation — so a mountain edit leaves
 * the city unchanged AND un-recomputed). Under-declaring `consumes` is the only
 * risk; the registry declares the design's intended couplings, so the DAG is a
 * superset of what any single consumer wires (a declared-but-not-yet-consumed
 * edge merely triggers a recompute with unchanged output — over-invalidation is
 * correct + deterministic, perf-only).
 */
import type { BBox } from "../spatialHash";
import { expandBBox } from "../spatialHash";

/** The stage bands (§2). A fixed, small, ordered set. */
export type Stage = 0 | 1 | 2 | 3 | 4;

/** The FIELD a stage produces / a downstream stage consumes (§3). Not a feature
 * kind — a constraint currency. `elevation` (stage 0) → `water` (stage 1) →
 * `vegetation` (stage 2) → `settlement` (stage 3) → `detail` (stage 4). */
export type ConstraintKind = "elevation" | "water" | "vegetation" | "settlement" | "detail";

/** One procgen region as a graph node. `id` is the fabric feature id (the
 * region id); `bbox` is the region/spine bbox in gen-space meters. */
export interface DagNode {
  id: string;
  stage: Stage;
  produces: readonly ConstraintKind[];
  consumes: readonly ConstraintKind[];
  bbox: BBox;
}

/**
 * The one fixed, documented, deterministic sequence: `(stage, id)`
 * lexicographic (§2/§5). Replay and cascade both walk this order so the cache
 * stays byte-stable (the order is DATA-INDEPENDENT — never Map-iteration order,
 * never file order). Returns a NEW sorted array; never mutates the input.
 */
export function cascadeOrder<T extends { id: string; stage: Stage }>(nodes: readonly T[]): T[] {
  return [...nodes].sort((a, b) => (a.stage !== b.stage ? a.stage - b.stage : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** produces(A) ∩ consumes(B) ≠ ∅ — does B read anything A makes? */
function couples(a: DagNode, b: DagNode): boolean {
  for (const k of a.produces) if (b.consumes.includes(k)) return true;
  return false;
}

function bboxOverlap(a: BBox, b: BBox): boolean {
  return !(a.maxX < b.minX || b.maxX < a.minX || a.maxY < b.minY || b.maxY < a.minY);
}

/** True iff `A → B` (A is an upstream input of B) under the §3-refined rule. */
export function hasEdge(a: DagNode, b: DagNode, margin: number): boolean {
  if (a.id === b.id) return false;
  if (a.stage >= b.stage) return false;
  if (!couples(a, b)) return false;
  return bboxOverlap(expandBBox(a.bbox, margin), b.bbox);
}

/**
 * Adjacency (downstream): `id → sorted downstream ids` — every B with `A → B`.
 * Deterministic: nodes visited in `cascadeOrder`, downstream lists sorted the
 * same way, so the map is a pure function of the node SET (D2), invariant to
 * the order the caller enumerated regions.
 */
export function downstreamEdges(nodes: readonly DagNode[], margin: number): Map<string, string[]> {
  const ordered = cascadeOrder(nodes);
  const out = new Map<string, string[]>();
  for (const a of ordered) {
    const down = ordered.filter((b) => hasEdge(a, b, margin)).map((b) => b.id);
    out.set(a.id, down);
  }
  return out;
}

/**
 * `id → sorted upstream ids` — every A with `A → B` (the regions whose output B
 * reads). Used to compose staleness fingerprints (§5.1): B's fingerprint folds
 * in its upstreams' fingerprints, so any upstream durable-input change
 * invalidates B on replay. Sorted for order-invariance.
 */
export function upstreamEdges(nodes: readonly DagNode[], margin: number): Map<string, string[]> {
  const ordered = cascadeOrder(nodes);
  const out = new Map<string, string[]>();
  for (const b of ordered) {
    const up = ordered.filter((a) => hasEdge(a, b, margin)).map((a) => a.id);
    out.set(b.id, up);
  }
  return out;
}

/**
 * The transitive downstream closure of `rootIds` (every G with `root →* G`),
 * returned in `cascadeOrder` and EXCLUDING the roots themselves. This is the
 * cascade worklist: on an edit to a root, regenerate these — upstream before
 * downstream, so a stage-1 recompute lands before a stage-3 read (§4).
 *
 * Cycle-safe: edges are strictly stage-ascending, so the closure terminates;
 * `assertAcyclic` is the defensive guard proving the invariant.
 */
export function downstreamClosure(nodes: readonly DagNode[], margin: number, rootIds: readonly string[]): DagNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const adj = downstreamEdges(nodes, margin);
  const seen = new Set<string>();
  const stack = [...rootIds];
  while (stack.length > 0) {
    const id = stack.pop()!;
    for (const next of adj.get(id) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  // Roots are excluded (they are regenerated by the caller as the edit itself).
  for (const r of rootIds) seen.delete(r);
  const result: DagNode[] = [];
  for (const id of seen) {
    const node = byId.get(id);
    if (node) result.push(node);
  }
  return cascadeOrder(result);
}

/**
 * Defensive cycle DETECTION. Edges built by `downstreamEdges` are cycle-free BY
 * CONSTRUCTION (strictly stage-ascending) — this proves it, and catches any
 * future hand-built / corrupt adjacency (e.g. a "just this once" same-stage
 * dependency) BEFORE it can make replay order ambiguous. Throws on the first
 * back edge found; a no-op on a valid DAG.
 *
 * `adjacency` maps `id → downstream ids`; ids absent from the map are leaves.
 */
export function assertAcyclic(adjacency: Map<string, readonly string[]>): void {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const id of adjacency.keys()) color.set(id, WHITE);

  const visit = (id: string, path: string[]): void => {
    color.set(id, GRAY);
    for (const next of adjacency.get(id) ?? []) {
      const c = color.get(next) ?? WHITE;
      if (c === GRAY) {
        throw new Error(`procgen DAG cycle: ${[...path, id, next].join(" → ")}`);
      }
      if (c === WHITE) visit(next, [...path, id]);
    }
    color.set(id, BLACK);
  };

  for (const id of [...adjacency.keys()].sort()) {
    if ((color.get(id) ?? WHITE) === WHITE) visit(id, []);
  }
}
