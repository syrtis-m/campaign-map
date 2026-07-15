/**
 * Signed distance fields over generation space.
 *
 * A field answers `f(x, y)` from durable inputs alone — no neighborhood, no
 * global pass — which is the property that makes tiles seam-free and
 * determinism cheap. An SDF is signed: **positive inside**, negative outside,
 * meters. This is the common currency between sketches, procgen output, and the
 * elevation layers.
 *
 * BIT-EXACTNESS: the leaf primitives here — `distanceToRingBoundary`, the
 * even-odd containment loops, and `distanceToPolyline` — are the shared
 * source of truth also imported back by `region.ts` and `fabricConstraints.ts`
 * (one-way: region/fabric → fields, acyclic). Their arithmetic must stay
 * character-identical wherever it is consumed so that
 * `interiorT`/`distanceToBoundary`/`pointInRing` produce byte-identical output.
 * Do not "clean up" the float expressions here; a single reassociated add
 * re-rolls every existing city on upgrade.
 *
 * Pure/headless (no DOM/map/Obsidian).
 */

export type Pt = [number, number];

/** A scalar field over generation space: meters in, scalar out. */
export type Field = (x: number, y: number) => number;

// ─── Leaf primitives (bit-exact twins — see BIT-EXACTNESS note) ──────────────

/**
 * Min distance from a point to any boundary segment of a CLOSED ring
 * (first === last). Bit-exact twin of `region.ts#distanceToRingBoundary`.
 */
export function distanceToRingBoundary(closed: Pt[], x: number, y: number): number {
  let best = Infinity;
  for (let i = 0; i < closed.length - 1; i++) {
    const [ax, ay] = closed[i];
    const [bx, by] = closed[i + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
    const d = Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
    if (d < best) best = d;
  }
  return best;
}

/**
 * Even-odd ray cast over a CLOSED region ring (iterates the open portion:
 * `ring` is closed, so it stops before the closure). Bit-exact twin of
 * `region.ts#regionContains`. NOTE the closure convention differs from
 * `pointInRingClosed` below — do NOT unify them: they must stay byte-identical
 * to their respective consumers.
 */
export function ringContainsEvenOdd(ring: Pt[], x: number, y: number): boolean {
  let inside = false;
  // Iterate the open portion: ring is closed, so stop before the closure.
  for (let i = 0, j = ring.length - 2; i < ring.length - 1; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Ray-cast point-in-polygon over a ring, iterating EVERY vertex (the geojson
 * closure convention). Bit-exact twin of `fabricConstraints.ts#pointInRing`
 * — pure arithmetic on the ring, deterministic. Distinct loop from
 * `ringContainsEvenOdd` (different closure handling); kept separate on purpose.
 */
export function pointInRingClosed(ring: Pt[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Min distance from a point to any segment of an OPEN polyline. Bit-exact twin
 * of `region.ts#distanceToSpine` (body). Degenerate handling preserved:
 * empty → Infinity, single point → distance to that point.
 */
export function distanceToPolyline(pts: Pt[], x: number, y: number): number {
  if (pts.length === 0) return Infinity;
  if (pts.length === 1) return Math.hypot(x - pts[0][0], y - pts[0][1]);
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[i + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
    const d = Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
    if (d < best) best = d;
  }
  return best;
}

// ─── Numeric signed-distance (hot-path; no closure allocation) ───────────────

/**
 * Signed distance to a closed polygon ring: **positive inside**, negative
 * outside, meters. This is exactly what `region.ts#distanceToBoundary`'s
 * polygon branch computes (`regionContains ? d : -d`) — the leaf callers run
 * this in tight loops (the interior-distance lattice scan is up to
 * `(bbox/10m)²` points), so it stays a bare number, never a `Field` closure.
 */
export function signedDistancePolygon(closed: Pt[], x: number, y: number): number {
  const d = distanceToRingBoundary(closed, x, y);
  return ringContainsEvenOdd(closed, x, y) ? d : -d;
}

/**
 * Signed distance to a polyline capsule of half-width `halfWidth`: **positive
 * inside** (within `halfWidth` of the line), negative outside. This is the
 * corridor metric (`corridorMaxOffset − distanceToSpine`) generalized.
 */
export function signedDistancePolyline(line: Pt[], halfWidth: number, x: number, y: number): number {
  return halfWidth - distanceToPolyline(line, x, y);
}

// ─── Field builders (thin wrappers for field composition) ────────────────────

/**
 * SDF for a polygon ring as a `Field` (positive inside, meters). Closes the
 * ring if the caller passed an open one. For hot per-point loops prefer the
 * bare `signedDistancePolygon`; use this when composing fields (`fMask`,
 * `fUnion`, …).
 */
export function sdfPolygon(ring: Pt[]): Field {
  const closed = closeRing(ring);
  return (x, y) => signedDistancePolygon(closed, x, y);
}

/**
 * SDF for a polyline capsule as a `Field` (positive within `halfWidth` of the
 * line). `halfWidth` in meters.
 */
export function sdfPolyline(line: Pt[], halfWidth: number): Field {
  return (x, y) => signedDistancePolyline(line, halfWidth, x, y);
}

/** Ensure a ring is closed (first === last) without mutating the input. */
function closeRing(ring: Pt[]): Pt[] {
  if (ring.length >= 2) {
    const a = ring[0];
    const b = ring[ring.length - 1];
    if (a[0] === b[0] && a[1] === b[1]) return ring;
  }
  return ring.length >= 1 ? [...ring, ring[0]] : ring;
}
