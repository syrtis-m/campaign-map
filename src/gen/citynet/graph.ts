/**
 * Planar street graph on a 1 cm integer lattice (procgen v3 §5.2, D1): every
 * node coordinate is an integer count of centimeters (`Math.round(meters ×
 * 100)`), so the orientation and segment-intersection predicates used for
 * topology decisions are exact integer arithmetic — no epsilon, no FP
 * nondeterminism, and none of Watabou's collapsed-edge crash class. Floats
 * appear only in *metric* queries (distances vs. snap thresholds), which gate
 * on inequalities, never exact equality (D4), and at emission when ints
 * convert back to meters.
 *
 * Determinism argument: node identity IS lattice position (`"x,y"` key), edge
 * identity is the canonical ordering of its endpoint keys — nothing is keyed
 * by insertion order. Every query that returns "the nearest" or "the first"
 * breaks ties by id (D2), and every iteration that feeds output re-sorts by id
 * first. The spatial hash buckets are an acceleration structure only: results
 * are reduced through total comparators, so bucket iteration order is
 * unobservable.
 */

/** Integer-lattice scale: centimeters per meter. */
export const LATTICE_PER_M = 100;
/** Spatial-hash bucket size in lattice units (25 m). */
export const HASH_CELL = 2500;

export interface GraphNode {
  /** `"x,y"` of the int lattice coords — position IS identity. */
  key: string;
  x: number; // int cm
  y: number; // int cm
}

export interface EdgeProps {
  roadClass: string;
  /** Committed by the growth loop (emitted as generated streets). */
  grown: boolean;
  /** Pre-seeded from a GM sketch: immutable, never pruned, never emitted. */
  sketch: boolean;
}

export interface GraphEdge {
  /** `"aKey|bKey"` with endpoint keys in canonical (x, then y) order. */
  id: string;
  a: string;
  b: string;
  props: EdgeProps;
}

export const toLattice = (meters: number): number => Math.round(meters * LATTICE_PER_M);
export const toMeters = (lattice: number): number => lattice / LATTICE_PER_M;

export function nodeKey(x: number, y: number): string {
  return `${x},${y}`;
}

/** Exact integer orientation: >0 left turn, <0 right turn, 0 collinear. */
export function orient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  const v = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

/** Proper crossing test (interiors intersect) — exact on int coordinates.
 * Endpoint-touching configurations return false; the snap machinery owns
 * those. */
export function segmentsCross(
  px: number, py: number, qx: number, qy: number,
  rx: number, ry: number, sx: number, sy: number
): boolean {
  const o1 = orient(px, py, qx, qy, rx, ry);
  const o2 = orient(px, py, qx, qy, sx, sy);
  const o3 = orient(rx, ry, sx, sy, px, py);
  const o4 = orient(rx, ry, sx, sy, qx, qy);
  return o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0 && o1 !== o2 && o3 !== o4;
}

export interface EdgeHit {
  edge: GraphEdge;
  /** Parameter along the QUERY segment (0 at its start). */
  t: number;
  /** Intersection/projection point, snapped to the int lattice. */
  x: number;
  y: number;
}

export class StreetGraph {
  private nodes = new Map<string, GraphNode>();
  private edges = new Map<string, GraphEdge>();
  private adjacency = new Map<string, string[]>(); // nodeKey -> edge ids
  private nodeBuckets = new Map<string, string[]>(); // hash cell -> node keys
  private edgeBuckets = new Map<string, string[]>(); // hash cell -> edge ids

  get edgeCount(): number {
    return this.edges.size;
  }

  private bucketKey(bx: number, by: number): string {
    return `${bx}:${by}`;
  }

  private bucketRange(minX: number, minY: number, maxX: number, maxY: number): string[] {
    const keys: string[] = [];
    const bx0 = Math.floor(minX / HASH_CELL);
    const by0 = Math.floor(minY / HASH_CELL);
    const bx1 = Math.floor(maxX / HASH_CELL);
    const by1 = Math.floor(maxY / HASH_CELL);
    for (let bx = bx0; bx <= bx1; bx++) {
      for (let by = by0; by <= by1; by++) keys.push(this.bucketKey(bx, by));
    }
    return keys;
  }

  getNode(key: string): GraphNode | undefined {
    return this.nodes.get(key);
  }

  getEdge(id: string): GraphEdge | undefined {
    return this.edges.get(id);
  }

  degree(key: string): number {
    return this.adjacency.get(key)?.length ?? 0;
  }

  /** Incident edge ids, sorted (deterministic consumer order). */
  incidentEdges(key: string): string[] {
    return [...(this.adjacency.get(key) ?? [])].sort();
  }

  /** All nodes, sorted by key (deterministic). */
  sortedNodeKeys(): string[] {
    return [...this.nodes.keys()].sort();
  }

  /** All edges, sorted by id (deterministic). */
  sortedEdges(): GraphEdge[] {
    return [...this.edges.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** Insert (or fetch) the node at exact int lattice coords. */
  addNode(x: number, y: number): GraphNode {
    const key = nodeKey(x, y);
    const existing = this.nodes.get(key);
    if (existing) return existing;
    const node: GraphNode = { key, x, y };
    this.nodes.set(key, node);
    this.adjacency.set(key, []);
    const bk = this.bucketKey(Math.floor(x / HASH_CELL), Math.floor(y / HASH_CELL));
    (this.nodeBuckets.get(bk) ?? this.nodeBuckets.set(bk, []).get(bk)!).push(key);
    return node;
  }

  private static edgeId(aKey: string, bKey: string): string {
    // Canonical endpoint order: numeric (x, then y) compare of the coords.
    const [ax, ay] = aKey.split(",").map(Number);
    const [bx, by] = bKey.split(",").map(Number);
    const aFirst = ax < bx || (ax === bx && ay <= by);
    return aFirst ? `${aKey}|${bKey}` : `${bKey}|${aKey}`;
  }

  hasEdge(aKey: string, bKey: string): boolean {
    return this.edges.has(StreetGraph.edgeId(aKey, bKey));
  }

  /** Insert an edge between two existing nodes. Degenerate (a === b) and
   * duplicate edges are refused (returns the existing edge or null). */
  addEdge(aKey: string, bKey: string, props: EdgeProps): GraphEdge | null {
    if (aKey === bKey) return null;
    const id = StreetGraph.edgeId(aKey, bKey);
    const existing = this.edges.get(id);
    if (existing) return existing;
    const a = this.nodes.get(aKey);
    const b = this.nodes.get(bKey);
    if (!a || !b) return null;
    const edge: GraphEdge = { id, a: aKey, b: bKey, props };
    this.edges.set(id, edge);
    this.adjacency.get(aKey)!.push(id);
    this.adjacency.get(bKey)!.push(id);
    for (const bk of this.bucketRange(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y))) {
      (this.edgeBuckets.get(bk) ?? this.edgeBuckets.set(bk, []).get(bk)!).push(id);
    }
    return edge;
  }

  /** Remove an edge (prune pass). Orphaned nodes stay — harmless, unemitted. */
  removeEdge(id: string): void {
    const edge = this.edges.get(id);
    if (!edge) return;
    this.edges.delete(id);
    for (const key of [edge.a, edge.b]) {
      const adj = this.adjacency.get(key);
      if (adj) {
        const i = adj.indexOf(id);
        if (i >= 0) adj.splice(i, 1);
      }
    }
    // Stale bucket entries are tolerated: every query re-checks this.edges.
  }

  /**
   * Split an edge at an interior lattice point: replaces it with two edges
   * sharing a new node, preserving props. If the point coincides with an
   * endpoint, no split happens and that endpoint is returned. Sketch edges may
   * be split (pure topology — their geometry is unchanged; I4 intact).
   */
  splitEdge(id: string, x: number, y: number): GraphNode | null {
    const edge = this.edges.get(id);
    if (!edge) return null;
    const a = this.nodes.get(edge.a)!;
    const b = this.nodes.get(edge.b)!;
    if ((x === a.x && y === a.y)) return a;
    if ((x === b.x && y === b.y)) return b;
    const mid = this.addNode(x, y);
    this.removeEdge(id);
    this.addEdge(edge.a, mid.key, edge.props);
    this.addEdge(mid.key, edge.b, edge.props);
    return mid;
  }

  /** Nearest node within `dist` lattice units of (x,y), excluding `exclude`.
   * Ties broken by smaller key (D2). */
  nearestNodeWithin(x: number, y: number, dist: number, exclude?: string): GraphNode | null {
    let best: GraphNode | null = null;
    let bestD = dist;
    for (const bk of this.bucketRange(x - dist, y - dist, x + dist, y + dist)) {
      for (const key of this.nodeBuckets.get(bk) ?? []) {
        if (key === exclude) continue;
        const n = this.nodes.get(key);
        if (!n) continue;
        const d = Math.hypot(n.x - x, n.y - y);
        if (d < bestD || (d === bestD && best !== null && key < best.key)) {
          best = n;
          bestD = d;
        }
      }
    }
    return best;
  }

  /** Nearest edge whose interior comes within `dist` of (x,y). Returns the
   * projection snapped to the lattice. Ties broken by edge id (D2). Edges
   * incident to `excludeNode` are skipped. */
  nearestEdgeWithin(x: number, y: number, dist: number, excludeNode?: string): EdgeHit | null {
    let best: EdgeHit | null = null;
    let bestD = dist;
    for (const bk of this.bucketRange(x - dist, y - dist, x + dist, y + dist)) {
      for (const id of this.edgeBuckets.get(bk) ?? []) {
        const e = this.edges.get(id);
        if (!e) continue; // stale bucket entry
        if (excludeNode && (e.a === excludeNode || e.b === excludeNode)) continue;
        const a = this.nodes.get(e.a)!;
        const b = this.nodes.get(e.b)!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const l2 = dx * dx + dy * dy;
        if (l2 === 0) continue;
        const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2));
        const px = a.x + t * dx;
        const py = a.y + t * dy;
        const d = Math.hypot(x - px, y - py);
        if (d < bestD || (d === bestD && best !== null && id < best.edge.id)) {
          best = { edge: e, t, x: Math.round(px), y: Math.round(py) };
          bestD = d;
        }
      }
    }
    return best;
  }

  /**
   * First proper crossing of the query segment (from node `fromKey` to
   * (x,y)) against existing edges, by parameter along the query segment;
   * ties by edge id (D2). Crossing test is exact int orientation; the cut
   * point is the FP intersection snapped to the lattice.
   */
  firstCrossing(fromKey: string, x: number, y: number): EdgeHit | null {
    const from = this.nodes.get(fromKey);
    if (!from) return null;
    let best: EdgeHit | null = null;
    const seen = new Set<string>();
    for (const bk of this.bucketRange(Math.min(from.x, x), Math.min(from.y, y), Math.max(from.x, x), Math.max(from.y, y))) {
      for (const id of this.edgeBuckets.get(bk) ?? []) {
        if (seen.has(id)) continue;
        seen.add(id);
        const e = this.edges.get(id);
        if (!e) continue;
        if (e.a === fromKey || e.b === fromKey) continue;
        const a = this.nodes.get(e.a)!;
        const b = this.nodes.get(e.b)!;
        if (!segmentsCross(from.x, from.y, x, y, a.x, a.y, b.x, b.y)) continue;
        // FP intersection of two segments known (exactly) to properly cross.
        const d = (x - from.x) * (b.y - a.y) - (y - from.y) * (b.x - a.x);
        if (d === 0) continue; // parallel — cannot happen for a proper cross
        const t = ((a.x - from.x) * (b.y - a.y) - (a.y - from.y) * (b.x - a.x)) / d;
        const px = Math.round(from.x + t * (x - from.x));
        const py = Math.round(from.y + t * (y - from.y));
        if (
          best === null ||
          t < best.t ||
          (t === best.t && e.id < best.edge.id)
        ) {
          best = { edge: e, t, x: px, y: py };
        }
      }
    }
    return best;
  }
}
