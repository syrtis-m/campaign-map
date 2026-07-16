/**
 * Inverted-sea DISPLAY geometry (plan 041 island-from-coastline; Cradle bug
 * 2026-07-15). An inverted `sea` landform's drawn ring is the COAST — the sea is
 * the ring's EXTERIOR. Its display fill is therefore a bounds-DONUT: outer =
 * campaign box, hole = the coast ring, so the water paints everything OUTSIDE the
 * coast. This module is the SINGLE, host-agnostic source for that geometry, shared
 * by two consumers so they never drift:
 *
 *   1. MapView.refreshFabric — the water fill polygon (Bug 2: an islet plateau
 *      kilometres out in the water was painted as water because the donut cut only
 *      the main coast; `invertedSeaLandHoles` cuts an ADDITIONAL hole for every
 *      OTHER landform that re-raises land above the sea datum and lies in the
 *      exterior, so each island renders as land, its wash/contours on top).
 *   2. regionLabels.regionLabelPointFeatures — the overview label anchor (Item 3:
 *      "The Deep" labelled mid-ISLAND because the point was the coast ring's
 *      centroid; `invertedSeaLabelPoint` places it deep in open WATER instead).
 *
 * Everything here is DISPLAY-UNIT (fake lng/lat) + deterministic — mirror-only, no
 * persisted bytes change. The terrain FIELD (`exteriorMaskField`) remains the
 * arithmetic source of truth for elevation; this is purely how the water is drawn
 * and labelled.
 */
import type { FabricFeature } from "../model/fabric";
import { landformRaisesLandAbove } from "../gen/fields/terrain";
import { pointInRingClosed, distanceToPolyline } from "../gen/fields/sdf";
import { defaultFictionalBounds } from "./fictionalCRS";

type Pt = [number, number];
type Ring = number[][]; // matches GeoJSON coordinates; cast to Pt[] at sdf boundaries
type Bounds = [number, number, number, number];

/** Close a ring (append the first vertex) if it isn't already closed. Typed as
 * `Pt[]` so the sdf helpers (point-in-ring / distance) accept it directly. */
function closeRing(ring: Ring): Pt[] {
  const r = ring as Pt[];
  if (r.length >= 2) {
    const a = r[0];
    const b = r[r.length - 1];
    if (a[0] === b[0] && a[1] === b[1]) return r;
  }
  return r.length >= 1 ? [...r, r[0]] : r;
}

function ringBBox(ring: Ring): Bounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return Number.isFinite(minX) ? [minX, minY, maxX, maxY] : null;
}

/** Mean of a ring's vertices (skips the closing duplicate) — a cheap representative
 * interior-ish point, only used to classify a landform as inside/outside the coast. */
function ringMean(ring: Ring): [number, number] {
  let sx = 0;
  let sy = 0;
  let n = 0;
  const last = ring.length - (ring.length >= 2 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? 1 : 0);
  for (let i = 0; i < last; i++) {
    sx += ring[i][0];
    sy += ring[i][1];
    n++;
  }
  return n > 0 ? [sx / n, sy / n] : [0, 0];
}

/**
 * The campaign DISPLAY box (fake lng/lat) that bounds an inverted sea's water:
 *   - explicit `config.bounds` when set;
 *   - else the default fictional box for a fictional campaign;
 *   - else (real CRS, no bounds) a generous 5× expansion of the coast bbox so the
 *     water still fills a plausible ocean around the traced coast.
 * Pure — no host state — so MapView and the label builder derive the SAME box.
 */
export function invertedSeaBounds(
  cfgBounds: Bounds | undefined,
  isReal: boolean,
  coast: Ring
): Bounds {
  if (cfgBounds) return cfgBounds;
  if (!isReal) return defaultFictionalBounds();
  const bb = ringBBox(coast) ?? [0, 0, 1, 1];
  const [minX, minY, maxX, maxY] = bb;
  const dx = maxX - minX || 1;
  const dy = maxY - minY || 1;
  return [minX - dx * 5, minY - dy * 5, maxX + dx * 5, maxY + dy * 5];
}

/**
 * The extra LAND-hole rings (display units) an inverted sea's water donut must cut:
 * every OTHER landform feature that (a) re-raises land above the sea datum
 * (`landformRaisesLandAbove`) and (b) lies in the sea's EXTERIOR (its representative
 * point is OUTSIDE the drawn coast ring — a landform sketched INSIDE the coast is
 * already dry land inside the island, needs no hole). Id-sorted for determinism.
 * The `seaFeature` itself is excluded by id. Returns each such landform's OUTER
 * ring; holes-in-holes are not modelled (an island's own lake is an edge case the
 * terrain field, not the display fill, resolves).
 */
export function invertedSeaLandHoles(
  seaFeature: FabricFeature,
  allFeatures: readonly FabricFeature[],
  seaDatum: number
): Ring[] {
  if (seaFeature.geometry.type !== "Polygon") return [];
  const coast = closeRing(seaFeature.geometry.coordinates[0] as Ring);
  const selfId = String(seaFeature.id);
  const holes: { id: string; ring: Ring }[] = [];
  for (const f of allFeatures) {
    if (String(f.id) === selfId) continue;
    if (f.geometry.type !== "Polygon") continue;
    if (!landformRaisesLandAbove(f, seaDatum)) continue;
    const ring = f.geometry.coordinates[0] as Ring | undefined;
    if (!ring || ring.length < 3) continue;
    const [mx, my] = ringMean(ring);
    if (pointInRingClosed(coast, mx, my)) continue; // inside the coast ⇒ already land
    holes.push({ id: String(f.id), ring });
  }
  holes.sort((a, b) => a.id.localeCompare(b.id));
  return holes.map((h) => h.ring);
}

/**
 * The inverted sea's display polygon rings: `[outerBox, coast, ...landHoles]`.
 * MapLibre's earcut fill treats ring[0] as the outer boundary and the rest as
 * holes (winding-agnostic), so the water paints the box MINUS the coast MINUS each
 * island — every island then reads as a hole in the water = land.
 */
export function invertedSeaDonutRings(bounds: Bounds, coast: Ring, landHoles: Ring[]): Ring[] {
  const [minX, minY, maxX, maxY] = bounds;
  const outer: Ring = [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
    [minX, minY],
  ];
  return [outer, coast, ...landHoles];
}

/**
 * A deterministic interior WATER point for an inverted sea's overview label
 * (Item 3): the pole-of-inaccessibility over the water region — the point in the
 * water (inside the box, OUTSIDE the coast and every island hole) farthest from any
 * of those boundaries. Approximated on a coarse `gridN`×`gridN` lattice over the
 * box; the best-clearance cell wins, ties broken by scan order (row-major from the
 * box's min corner) so the result is fully deterministic. Guarantees a point in
 * open water (never on the island), unlike an area-weighted centroid which, for a
 * centred island, lands back on it.
 *
 * Fallback: if no lattice cell is water (the island fills the box), returns the box
 * centre — a sane, deterministic last resort.
 */
export function invertedSeaLabelPoint(
  bounds: Bounds,
  coast: Ring,
  landHoles: Ring[],
  gridN = 64
): [number, number] {
  const [minX, minY, maxX, maxY] = bounds;
  const n = Math.max(2, Math.floor(gridN));
  const coastClosed = closeRing(coast);
  const holeRings = landHoles.map((h) => closeRing(h));
  let best: [number, number] | null = null;
  let bestClear = -Infinity;
  for (let iy = 0; iy < n; iy++) {
    // Sample cell centres so no point sits exactly on the box edge (clearance 0).
    const y = minY + ((iy + 0.5) / n) * (maxY - minY);
    for (let ix = 0; ix < n; ix++) {
      const x = minX + ((ix + 0.5) / n) * (maxX - minX);
      // Water = inside the box (always here) AND outside the coast AND outside
      // every island hole.
      if (pointInRingClosed(coastClosed, x, y)) continue;
      let inHole = false;
      for (const h of holeRings) {
        if (pointInRingClosed(h, x, y)) {
          inHole = true;
          break;
        }
      }
      if (inHole) continue;
      // Clearance to the nearest obstacle: box border, coast, any island.
      let clear = Math.min(x - minX, maxX - x, y - minY, maxY - y);
      clear = Math.min(clear, distanceToPolyline(coastClosed, x, y));
      for (const h of holeRings) clear = Math.min(clear, distanceToPolyline(h, x, y));
      if (clear > bestClear) {
        bestClear = clear;
        best = [x, y];
      }
    }
  }
  return best ?? [(minX + maxX) / 2, (minY + maxY) / 2];
}
