/**
 * Contour rings → GeoJSON MultiPolygon coordinates (plan 026-B) — the reusable
 * assembly step that turns the closed loops a masked-field trace returns
 * (marchingSquares at one iso-level) into filled polygons WITH HOLES.
 *
 * The rings a single iso-level produces are pairwise non-crossing: they are
 * level sets of one continuous field, so one ring is either fully inside or
 * fully outside another. That makes nesting an even/odd depth count: a point is
 * in the filled set iff it sits inside an ODD number of rings (cross the outer
 * boundary → inside; cross a clearing boundary → back outside; cross an island
 * boundary → inside again). Hence a ring at EVEN nesting depth is an exterior
 * (solid starts inside it) and a ring at ODD depth is a hole; each hole belongs
 * to its immediate (deepest) container, which is the exterior one level out.
 *
 * Pure/headless, D1–D6: containment is fields' verbatim `pointInRingClosed`, the
 * output is canonically ordered (exteriors and their holes sorted by first
 * vertex), and exteriors are wound CCW / holes CW (RFC 7946 + MapLibre's
 * hole-detection both honour that) — so a whole-artifact regenerate is
 * byte-identical.
 */
import { pointInRingClosed, type Pt } from "./sdf";

/** Signed shoelace area of a ring (closed or open); >0 ⇒ CCW. */
function signedArea(ring: Pt[]): number {
  let a = 0;
  const n = ring.length >= 2 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
    ? ring.length - 1
    : ring.length;
  for (let i = 0; i < n; i++) {
    const [px, py] = ring[i];
    const [qx, qy] = ring[(i + 1) % n];
    a += px * qy - qx * py;
  }
  return a / 2;
}

/** Reverse a closed ring in place-safe fashion (keeps first === last). */
function reversed(ring: Pt[]): Pt[] {
  return [...ring].reverse();
}

/** Force a ring to the requested winding (ccw ⇒ positive area). */
function orient(ring: Pt[], ccw: boolean): Pt[] {
  const positive = signedArea(ring) > 0;
  return positive === ccw ? ring : reversed(ring);
}

/** Lexicographic (x then y) compare of a ring's first vertex. */
function firstLess(a: Pt[], b: Pt[]): boolean {
  return a[0][0] !== b[0][0] ? a[0][0] < b[0][0] : a[0][1] < b[0][1];
}

/**
 * Assemble closed `rings` into MultiPolygon coordinates: an array of polygons,
 * each `[exterior, ...holes]`, exteriors CCW and holes CW. Rings must be closed
 * (first === last) and pairwise non-crossing (iso-contours of one field). Rings
 * with fewer than 4 points (a closed triangle needs 4) are dropped. Returns []
 * for no usable rings.
 */
export function contoursToMultiPolygon(rings: readonly Pt[][]): Pt[][][] {
  const usable = rings.filter((r) => r.length >= 4);
  const n = usable.length;
  if (n === 0) return [];

  // Depth of each ring = how many OTHER rings contain its representative vertex.
  // A ring's first vertex lies ON that ring; since rings never cross, it is
  // strictly inside or outside every other ring — a reliable containment probe.
  const depth = new Array<number>(n).fill(0);
  const containedBy: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    const [px, py] = usable[i][0];
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      if (pointInRingClosed(usable[j], px, py)) {
        depth[i]++;
        containedBy[i].push(j);
      }
    }
  }

  // Exteriors are even-depth rings. Each odd-depth ring (a hole) attaches to its
  // immediate container: the deepest ring that contains it (depth === own − 1).
  const holesFor = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    if (depth[i] % 2 === 0) continue; // exterior — handled below
    let parent = -1;
    let best = -1;
    for (const j of containedBy[i]) {
      if (depth[j] > best) {
        best = depth[j];
        parent = j;
      }
    }
    if (parent >= 0) {
      const list = holesFor.get(parent);
      if (list) list.push(i);
      else holesFor.set(parent, [i]);
    }
  }

  const polygons: Pt[][][] = [];
  for (let i = 0; i < n; i++) {
    if (depth[i] % 2 !== 0) continue; // not an exterior
    const exterior = orient(usable[i], true);
    const holeIdx = holesFor.get(i) ?? [];
    const holes = holeIdx
      .map((h) => orient(usable[h], false))
      .sort((a, b) => (firstLess(a, b) ? -1 : 1));
    polygons.push([exterior, ...holes]);
  }

  // Canonical polygon order: by exterior first vertex (stable regardless of the
  // ring scan order coming in).
  polygons.sort((a, b) => (firstLess(a[0], b[0]) ? -1 : 1));
  return polygons;
}
