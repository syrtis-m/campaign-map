import type { FabricFeature } from "../../model/fabric";

/**
 * Water-avoidance for POINT labels — placement ASSISTANCE at the label-feature
 * level (MapLibre symbol layers are not water-aware).
 *
 * The idea: a location pin sitting on a riverbank should not throw its name
 * across the water. MapLibre's `text-variable-anchor` tries anchor positions in
 * a FIXED order and picks the first that fits — it has no notion of which side
 * is land. So at label-source build time we compute, per pin near water, which
 * cardinal side is DRY (the bearing away from the nearest sketched water line)
 * and stamp a `dryAnchor` property. The canon label layer's
 * `text-variable-anchor-offset` (a data-driven property) reads that property and
 * REORDERS the anchor preference to try the dry side first — MapLibre still
 * collision-avoids from there, so a genuinely blocked dry anchor still falls
 * back to the others.
 *
 * Pure + deterministic + display-only. It reorders anchor PREFERENCE; it never
 * moves geometry and never touches persisted bytes.
 *
 * LIMITS (deliberately coarse — a rough "which side of the nearest water line is
 * drier" heuristic beats nothing):
 *  - Only the NEAREST water segment is consulted; a pin in a tight bend or on a
 *    narrow isthmus can get a side that is dry locally but not globally.
 *  - Proximity is a build-time WORLD-space threshold, not the zoom-dependent
 *    screen footprint of the actual glyphs, so the bias is applied a touch
 *    generously (harmless — it only reorders the same four anchors).
 *  - Consults SKETCHED water/river fabric only (the durable GM handles), not the
 *    generated river channel; the sketch spine tracks the channel closely enough
 *    for a coarse side pick.
 */

export type AnchorSide = "top" | "bottom" | "left" | "right";

/** Default variable-anchor order — the pre-water-avoidance behavior verbatim:
 * MapLibre tries these in order and picks the first that fits. `bottom` first =
 * a name prefers to sit ABOVE its dot. */
export const DEFAULT_ANCHOR_ORDER: readonly AnchorSide[] = ["bottom", "top", "right", "left"];

/**
 * Per-anchor offset (ems) reproducing the old `text-radial-offset: 0.9`. Follows
 * MapLibre's text-offset convention (+x right, +y DOWN): the offset pushes the
 * label radially OUT from its dot, so e.g. anchor `bottom` (label sits above the
 * dot) offsets UP (−y).
 */
export const ANCHOR_OFFSET: Record<AnchorSide, [number, number]> = {
  bottom: [0, -0.9],
  top: [0, 0.9],
  left: [0.9, 0],
  right: [-0.9, 0],
};

/** Flatten an anchor order into a MapLibre `text-variable-anchor-offset` value:
 * `[anchor, [dx,dy], anchor, [dx,dy], …]`. */
export function anchorOffsetCollection(order: readonly AnchorSide[]): (AnchorSide | [number, number])[] {
  return order.flatMap((a) => [a, ANCHOR_OFFSET[a]]);
}

/** The default order with `first` moved to the head (remaining anchors keep
 * their default relative order) — the dry side is tried first, the rest still
 * available for collision fallback. */
export function anchorOrderFavoring(first: AnchorSide): AnchorSide[] {
  return [first, ...DEFAULT_ANCHOR_ORDER.filter((a) => a !== first)];
}

/**
 * The data-driven `text-variable-anchor-offset` expression for the canon label
 * layers: a `match` on the per-feature `dryAnchor` (stamped by
 * `decorateCanonWaterAvoidance`) selects an anchor order that leads with the dry
 * side. A feature with no `dryAnchor` — the common case, no water nearby —
 * falls through to the default order, byte-for-byte the old behavior. Each
 * branch is `["literal", …]`-wrapped because the value is a raw array MapLibre
 * would otherwise try to evaluate as a nested expression.
 */
export function variableAnchorOffsetExpression(): unknown {
  const lit = (order: AnchorSide[]): unknown => ["literal", anchorOffsetCollection(order)];
  return [
    "match",
    ["get", "dryAnchor"],
    "top",
    lit(anchorOrderFavoring("top")),
    "left",
    lit(anchorOrderFavoring("left")),
    "right",
    lit(anchorOrderFavoring("right")),
    // Default covers "bottom" AND every pin with no dryAnchor: the original order.
    lit([...DEFAULT_ANCHOR_ORDER]),
  ];
}

/** Fabric kinds that ARE water for label-avoidance: a filled water body and a
 * river channel line. */
const WATER_KINDS = new Set<string>(["water", "river"]);

/**
 * The nearest point on any water polyline to (px,py), with its distance — all in
 * display units. Returns null when there is no water geometry.
 */
export interface NearestWater {
  distance: number;
  x: number;
  y: number;
}

/** Closest point on segment AB to P (clamped to the segment), and its squared
 * distance. */
function closestOnSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): { d2: number; x: number; y: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const x = ax + t * dx;
  const y = ay + t * dy;
  const ex = px - x;
  const ey = py - y;
  return { d2: ex * ex + ey * ey, x, y };
}

export function nearestWaterPoint(
  px: number,
  py: number,
  polylines: readonly (readonly [number, number][])[]
): NearestWater | null {
  let best: NearestWater | null = null;
  for (const line of polylines) {
    if (line.length === 1) {
      const [ax, ay] = line[0];
      const d = Math.hypot(px - ax, py - ay);
      if (!best || d < best.distance) best = { distance: d, x: ax, y: ay };
      continue;
    }
    for (let i = 0; i + 1 < line.length; i++) {
      const [ax, ay] = line[i];
      const [bx, by] = line[i + 1];
      const c = closestOnSegment(px, py, ax, ay, bx, by);
      const d = Math.sqrt(c.d2);
      if (!best || d < best.distance) best = { distance: d, x: c.x, y: c.y };
    }
  }
  return best;
}

/**
 * The dry-side anchor for a label at (px,py): the cardinal anchor that places
 * text on the side AWAY from the nearest water, or null when no water is within
 * `maxDist` (display units) — leave the default order alone.
 *
 * Coordinates are display units where +x is EAST (right) and +y is NORTH (up on
 * screen; the fictional CRS maps y→latitude, which Web Mercator renders
 * upward). The dry direction is `label − nearestWater`; the anchor is the one
 * whose text extends in that direction (anchor `left` ⇒ text to the right, etc).
 */
export function drySideAnchor(
  px: number,
  py: number,
  polylines: readonly (readonly [number, number][])[],
  maxDist: number
): AnchorSide | null {
  const near = nearestWaterPoint(px, py, polylines);
  if (!near || near.distance > maxDist) return null;
  const dx = px - near.x;
  const dy = py - near.y;
  // Pin sits exactly on the water line — no meaningful dry side.
  if (dx === 0 && dy === 0) return null;
  if (Math.abs(dx) >= Math.abs(dy)) {
    // Dry direction is E/W. Text should extend that way: anchor is the opposite
    // edge (dry east ⇒ anchor "left" ⇒ text to the right).
    return dx > 0 ? "left" : "right";
  }
  // Dry direction is N/S. Dry north (dy>0, up) ⇒ text above ⇒ anchor "bottom".
  return dy > 0 ? "bottom" : "top";
}

/**
 * Water polylines (display units) drawn from the sketched fabric: a river line
 * as-is, a water polygon as each of its rings (closed polylines). The generated
 * channel is intentionally NOT consulted (see LIMITS above).
 */
export function waterPolylinesFromFabric(features: readonly FabricFeature[]): [number, number][][] {
  const out: [number, number][][] = [];
  for (const f of features) {
    if (!WATER_KINDS.has(f.properties.kind)) continue;
    const g = f.geometry;
    if (g.type === "LineString") {
      out.push(g.coordinates as [number, number][]);
    } else if (g.type === "Polygon") {
      for (const ring of g.coordinates) out.push(ring as [number, number][]);
    }
  }
  return out;
}

/**
 * The label-feature builder: return a copy of the canon FeatureCollection with a
 * `dryAnchor` property stamped on every POINT pin sitting within `maxDist`
 * (display units) of water. Pins far from water — and every non-point feature —
 * pass through untouched, so with no water in the campaign the collection is
 * returned as-is (the default anchor order applies).
 */
export function decorateCanonWaterAvoidance(
  canon: GeoJSON.FeatureCollection,
  waterPolylines: readonly (readonly [number, number][])[],
  maxDist: number
): GeoJSON.FeatureCollection {
  if (waterPolylines.length === 0) return canon;
  const features = canon.features.map((f) => {
    if (f.geometry?.type !== "Point") return f;
    const [x, y] = f.geometry.coordinates as [number, number];
    const anchor = drySideAnchor(x, y, waterPolylines, maxDist);
    if (!anchor) return f;
    return { ...f, properties: { ...(f.properties ?? {}), dryAnchor: anchor } };
  });
  return { ...canon, features };
}

/** Default water-proximity threshold, in campaign METERS, at which a pin's label
 * starts biasing to the dry side. Converted to display units by the caller via
 * the campaign scale, so it means the same real-world distance in every
 * campaign. Coarse by design (see LIMITS). */
export const WATER_AVOIDANCE_METERS = 250;
