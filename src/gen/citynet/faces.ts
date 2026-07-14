/**
 * Stage C1 — face extraction (procgen v3 §5.3.1): the street graph is planar
 * by construction (growth cuts at first crossings; skeleton pre-seed inserts
 * planar since v3.2), so its bounded faces ARE the city blocks. Half-edge
 * traversal by smallest left turn: at each node, outgoing half-edges are
 * sorted by angle; the successor of u→v is the half-edge one clockwise step
 * from v→u. Bounded faces come out counter-clockwise (positive shoelace
 * area); the outer face is clockwise and drops out on sign alone.
 *
 * Determinism argument: half-edges are iterated in sorted id order (edge ids
 * are position-derived, D2), the angular order around each node uses atan2 on
 * exact int deltas with a target-key tiebreak, and the shoelace area is exact
 * integer arithmetic on the 1 cm lattice (D1 — coordinates stay ≤ ~10^6 cm,
 * so the products stay far under 2^53).
 *
 * Anti-Watabou salvage (§5.3.1): degenerate faces — self-touching cycles
 * (repeated node: a face wrapping a dead-end spur), sub-40 m² slivers,
 * runaway walks — are counted and skipped, NEVER thrown.
 */
import { distanceToBoundary, type ProcgenRegion } from "../region";
import { StreetGraph, toMeters } from "./graph";

type Pt = [number, number];

/** Faces smaller than this are slivers, not blocks (§5.3.1). */
export const MIN_BLOCK_AREA_M2 = 40;
/** Faces with a vertex within this margin of the region boundary count as
 * "touching the boundary" and are dropped (§5.3.1). */
export const BOUNDARY_MARGIN_M = 0.5;

export interface BlockFace {
  /** CCW ring in world meters, closed (first === last). */
  ring: Pt[];
  /** Sorted node keys of the face — the position-derived identity used for
   * the block's feature id. */
  nodeKeys: string[];
  /** Exact area in m². */
  area: number;
}

export interface FaceStats {
  faces: number;
  degenerate: number; // self-touching or runaway cycles
  slivers: number; // area < MIN_BLOCK_AREA_M2
  boundary: number; // touching the domain rim
}

interface HalfEdge {
  id: string; // "aKey>bKey"
  from: string;
  to: string;
}

/**
 * CHAMFER OPERATOR (plan 025 §3.4 / §2.4 — the eixample corner treatment).
 *
 * Cut every CONVEX corner of a closed CCW ring back `dist` metres along each of
 * its two incident edges, replacing that one vertex with two — the Barcelona-
 * Cerdà chaflán. Applied to every block corner it turns square blocks into
 * octagons, and where four blocks meet their four cut corners frame the
 * octagonal intersection that is the eixample signature.
 *
 * Pure geometry (no seed, no RNG): a deterministic function of `(ring, dist)`,
 * reusable as a generic "corner treatment" param. Determinism obligations are
 * satisfied by the caller quantizing on emit (D5) — this returns raw FP.
 *
 * Correctness guarantees:
 *  • CCW input (faces.ts emits CCW blocks). Convexity is the sign of the 2-D
 *    cross product of (incoming, outgoing) edge directions — >0 is a left turn
 *    ⇒ convex on a CCW ring. Reflex (≤0) corners are left INTACT so a concave
 *    block is not turned inside-out.
 *  • The per-corner setback is clamped to `dist` AND to 0.45× of EACH incident
 *    edge's length. Because every edge is shared by two corners and each takes
 *    at most 0.45 of it, the two chamfer points on one edge never cross
 *    (0.45 + 0.45 < 1) — the result stays a simple polygon.
 *  • A degenerate corner (a zero-length incident edge) is passed through
 *    unchanged rather than producing NaN.
 *
 * `ring` must be closed (first === last); the returned ring is closed too.
 */
export function chamferRing(ring: Pt[], dist: number): Pt[] {
  if (dist <= 0 || ring.length < 4) return ring;
  const pts = ring.slice(0, -1); // strip the closing vertex
  const n = pts.length;
  if (n < 3) return ring;
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n];
    const cur = pts[i];
    const nxt = pts[(i + 1) % n];
    const inX = cur[0] - prev[0];
    const inY = cur[1] - prev[1];
    const outX = nxt[0] - cur[0];
    const outY = nxt[1] - cur[1];
    const inLen = Math.hypot(inX, inY);
    const outLen = Math.hypot(outX, outY);
    // Degenerate incident edge, or a reflex/straight corner (cross ≤ 0 on a CCW
    // ring): keep the vertex as-is.
    const cross = inX * outY - inY * outX;
    if (inLen === 0 || outLen === 0 || cross <= 0) {
      out.push(cur);
      continue;
    }
    const setback = Math.min(dist, 0.45 * inLen, 0.45 * outLen);
    // Back up along the incoming edge, then forward along the outgoing edge.
    out.push([cur[0] - (inX / inLen) * setback, cur[1] - (inY / inLen) * setback]);
    out.push([cur[0] + (outX / outLen) * setback, cur[1] + (outY / outLen) * setback]);
  }
  out.push(out[0]);
  return out;
}

/**
 * Extract bounded faces of the graph as blocks. Pure function of the graph +
 * region geometry; iteration order is fully canonical (D2).
 */
export function extractBlocks(graph: StreetGraph, region: ProcgenRegion): { blocks: BlockFace[]; stats: FaceStats } {
  const stats: FaceStats = { faces: 0, degenerate: 0, slivers: 0, boundary: 0 };

  // Build directed half-edges from the sorted edge list.
  const halfEdges = new Map<string, HalfEdge>();
  const outgoing = new Map<string, HalfEdge[]>();
  for (const e of graph.sortedEdges()) {
    for (const [from, to] of [
      [e.a, e.b],
      [e.b, e.a],
    ] as const) {
      const he: HalfEdge = { id: `${from}>${to}`, from, to };
      halfEdges.set(he.id, he);
      (outgoing.get(from) ?? outgoing.set(from, []).get(from)!).push(he);
    }
  }

  // Angular order around each node: atan2 on exact int deltas, ascending,
  // tie-broken by target key (two exactly-collinear edges stay ordered).
  const nextOf = new Map<string, string>();
  for (const [nodeKey, outs] of [...outgoing.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const n = graph.getNode(nodeKey)!;
    const withAngle = outs
      .map((he) => {
        const t = graph.getNode(he.to)!;
        return { he, angle: Math.atan2(t.y - n.y, t.x - n.x) };
      })
      .sort((a, b) => a.angle - b.angle || (a.he.to < b.he.to ? -1 : 1));
    const m = withAngle.length;
    withAngle.forEach((entry, i) => {
      // successor of (u→v) is one CLOCKWISE step from (v→u) at v: build the
      // lookup from the reversed half-edge here at its origin node v.
      const rev = entry.he; // v→u, origin v = nodeKey
      const cw = withAngle[(i - 1 + m) % m].he;
      nextOf.set(`rev:${rev.id}`, cw.id);
    });
  }
  const next = (he: HalfEdge): HalfEdge | undefined => {
    const succId = nextOf.get(`rev:${he.to}>${he.from}`);
    return succId ? halfEdges.get(succId) : undefined;
  };

  const visited = new Set<string>();
  const blocks: BlockFace[] = [];
  const maxWalk = 2 * halfEdges.size + 1;
  const heIds = [...halfEdges.keys()].sort();

  for (const startId of heIds) {
    if (visited.has(startId)) continue;
    const start = halfEdges.get(startId)!;
    const cycle: HalfEdge[] = [];
    let cur: HalfEdge | undefined = start;
    let runaway = true;
    for (let step = 0; step < maxWalk; step++) {
      cycle.push(cur);
      visited.add(cur.id);
      cur = next(cur);
      if (!cur) break; // inconsistent rotation table — salvage as degenerate
      if (cur.id === startId) {
        runaway = false;
        break;
      }
      if (visited.has(cur.id)) break; // merged into an earlier walk — degenerate
    }
    stats.faces++;
    if (runaway || !cur) {
      stats.degenerate++;
      continue;
    }

    // Node sequence + self-touch check (repeated node = pinched face).
    const nodeSeq = cycle.map((he) => he.from);
    const nodeSet = new Set(nodeSeq);
    if (nodeSet.size !== nodeSeq.length) {
      stats.degenerate++;
      continue;
    }
    if (nodeSeq.length < 3) {
      stats.degenerate++; // a dangling edge traversed out-and-back
      continue;
    }

    // Exact int shoelace: bounded faces are CCW (positive); the outer face is
    // CW — the sign test drops it without any "largest face" heuristic.
    let area2 = 0; // in cm², doubled
    const pts = nodeSeq.map((k) => graph.getNode(k)!);
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const q = pts[(i + 1) % pts.length];
      area2 += p.x * q.y - q.x * p.y;
    }
    if (area2 <= 0) continue; // outer face or degenerate orientation
    const areaM2 = area2 / 2 / 10000;
    if (areaM2 < MIN_BLOCK_AREA_M2) {
      stats.slivers++;
      continue;
    }

    // Faces touching the region boundary are not blocks (§5.3.1): any vertex
    // within the margin of — or outside — the sketched outline drops the face.
    let touchesRim = false;
    for (const p of pts) {
      if (distanceToBoundary(region, toMeters(p.x), toMeters(p.y)) < BOUNDARY_MARGIN_M) {
        touchesRim = true;
        break;
      }
    }
    if (touchesRim) {
      stats.boundary++;
      continue;
    }

    const ring: Pt[] = pts.map((p) => [toMeters(p.x), toMeters(p.y)]);
    ring.push(ring[0]);
    blocks.push({ ring, nodeKeys: [...nodeSeq].sort(), area: areaM2 });
  }

  // Canonical order: first ring coordinate, then node-key identity.
  blocks.sort(
    (a, b) =>
      a.ring[0][0] - b.ring[0][0] ||
      a.ring[0][1] - b.ring[0][1] ||
      (a.nodeKeys.join("|") < b.nodeKeys.join("|") ? -1 : 1)
  );
  return { blocks, stats };
}
