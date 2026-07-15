/**
 * Cross-layer regen cascade — the stage DAG.
 *
 * The suite feels like one world (not independent stamps) because a layer-2
 * procgen edit propagates to the layer-1 fabric that reads it: turn a river's
 * windiness up, the city around it regenerates. That propagation is (a)
 * cycle-free BY CONSTRUCTION and (b) deterministic, via a fixed global partial
 * order over STAGES (renumbered plan 035 — hydrology above terrain; rivers are
 * canon strokes that terrain conforms to, so a terrain edit reaches farmland,
 * never a river):
 *
 *   0 hydrology   (river, water bodies — the canon strokes)
 *   1 terrain     (mountain — a FIELD; conforms to the rivers above it)
 *   2 vegetation  (forest, rural park)
 *   3 settlement  (city)
 *   4 peri-urban  (farmland, urban park — read the generated settlement, produce
 *                  nothing downstream)
 *   5 detail      (wall elaboration, future street furniture)
 *
 * An algorithm consumes constraints only from STRICTLY LOWER stages (plus raw
 * sketches + canon, unchanged). Same-stage regions never see each other's
 * OUTPUT (only each other's sketch), so there is no ordering ambiguity and no
 * cycle, ever.
 *
 * PURE / headless (imports only `BBox` from spatialHash + the `FabricKind` type)
 * — no registry, no generators, no DOM/map/Obsidian. The controller builds
 * `DagNode`s by reading
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
import type { FabricKind } from "../../model/fabric";

/** The stage bands (§2). A fixed, small, ordered set. Plan 034 adds `-1` for
 * SOURCE nodes — raw sketch features + canon pins that produce a constraint the
 * generators read but are not themselves generated. A source at stage −1 sorts
 * first under `(stage,id)` and only ever has OUTGOING edges (source → region),
 * so it can never introduce a cycle. Plan 035 adds `5` (detail/wall) and moves
 * hydrology below terrain — the numbers are the product's semantic order, owned
 * HERE (via the registry), never serialized into persisted data. */
export type Stage = -1 | 0 | 1 | 2 | 3 | 4 | 5;

/** The FIELD a stage produces / a downstream stage consumes (§3). Not a feature
 * kind — a constraint currency. Plan 035 renumbers the STAGES but the currency
 * set is unchanged: `water` (hydrology, stage 0), `elevation` (terrain, stage 1
 * — read as a durable macro-field via the sketch, never as a river input),
 * `vegetation` (stage 2), `settlement` (stage 3), `detail` (stage 5). */
export type ConstraintKind = "elevation" | "water" | "vegetation" | "settlement" | "detail";

/** One node in the invalidation graph. A REGION node (`id` = fabric feature id,
 * `stage` ≥ 0) carries its produces/consumes constraint kinds plus, for
 * source→region edges (plan 034), its raw-sketch consumption declaration
 * (`consumesSketch` / `influenceMargin` from the registry). A SOURCE node
 * (`stage` = −1) carries the single raw sketch `sketchKind` it produces; it has
 * no `consumes`/`produces` currencies and only ever feeds regions. `bbox` is the
 * region/spine/feature bbox in gen-space meters. */
export interface DagNode {
  id: string;
  stage: Stage;
  produces: readonly ConstraintKind[];
  consumes: readonly ConstraintKind[];
  bbox: BBox;
  /** SOURCE nodes only (plan 034): the raw `FabricKind` this source produces —
   * the currency a region's `consumesSketch` reads. */
  sketchKind?: FabricKind;
  /** SOURCE nodes only (ruling 2026-07-15): a terrain-STAMP source's variable
   * per-feature support reach (meters) beyond its bbox — relief → its halfWidth,
   * mountain/landform → 0 (`terrainStampSupport`). When set it OVERRIDES the
   * consumer's scalar `influenceMargin` for the source→region edge, so a relief
   * reaches a terrain consumer within its cross-profile band (which the consumer's
   * fixed margin does not model) while a compact mountain/landform reaches only on
   * bbox overlap. Undefined for non-terrain sources ⇒ the consumer margin governs. */
  supportMargin?: number;
  /** REGION nodes only (plan 034): the raw sketch kinds this region's generator
   * consumes (registry `consumesSketch`) — the source→region edge test keys on
   * it. */
  consumesSketch?: readonly FabricKind[];
  /** REGION nodes only (plan 034): how far (meters, bbox-to-bbox) a consumed
   * sketch source can influence this region (registry `influenceMargin`). */
  influenceMargin?: number;
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

/** True iff `A → B` (A is an upstream input of B) under the §3-refined rule.
 *
 * Two edge kinds share this predicate (plan 034):
 *   - SOURCE → REGION: A is a raw sketch source (`a.sketchKind` set). The edge
 *     holds iff B's generator declares `a.sketchKind ∈ consumesSketch(B)` and
 *     A's bbox comes within B's own `influenceMargin` — exactly the 033-C
 *     raw-sketch reach, now expressed as a DAG edge. B must be a region (a
 *     source never consumes), so source→source is impossible.
 *   - REGION → REGION: the §3-refined `produces ∩ consumes` + bbox(margin) rule.
 */
export function hasEdge(a: DagNode, b: DagNode, margin: number): boolean {
  if (a.id === b.id) return false;
  if (a.stage >= b.stage) return false;
  if (a.sketchKind !== undefined) {
    // Source → region: B must be a region declaring this sketch kind. A source
    // never feeds another source. Reach: a terrain-stamp source's own variable
    // support (`a.supportMargin`, ruling 2026-07-15) when set — relief carries its
    // half-width, so it reaches a consumer within its cross-profile band that B's
    // scalar margin would miss — else B's own `influenceMargin`.
    if (b.sketchKind !== undefined) return false;
    if (!b.consumesSketch?.includes(a.sketchKind)) return false;
    const reach = a.supportMargin ?? b.influenceMargin ?? 0;
    return bboxOverlap(expandBBox(a.bbox, reach), b.bbox);
  }
  // Region → region.
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
