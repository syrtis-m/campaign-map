/**
 * Cost lattice for the arterial A* (procgen v3 §5.1.1): a world-anchored 10 m
 * grid over `domainBBox(d, 200)` whose per-cell cost encodes where roads want
 * to go — cheap on flat open ground, expensive across a river (so crossings
 * concentrate into bridges), impassable through a lake, and steering clear of
 * the GM's pinned Locations (never pave canon).
 *
 * Determinism/seam argument: `cellCost(cellX, cellY)` is a pure function of the
 * integer cell address and the closed-over constraints — height noise, sketched
 * water/river geometry, canon points. It is world-anchored (cell → world is
 * `cell × 10 m`, independent of any tile or domain offset), so the same cell
 * costs the same everywhere and A* over it is reproducible byte-for-byte after
 * a cache delete (D1 — decisions live on the integer lattice; D6 — no hidden
 * inputs). `heightAt` uses `citySeed` because the pure contract exposes no
 * campaignSeed; the field is still fully deterministic (see DECISIONS.md).
 */
import type { CityDomain } from "./domain";
import { domainBBox } from "./domain";
import type { GenerationConstraints } from "../types";
import {
  indexFabricConstraints,
  nearestOnLine,
  pointInRing,
  RIVER_HALF_WIDTH,
  type FabricConstraintIndex,
} from "../fabricConstraints";
import { heightAt } from "../world/heightmap";

/** Cost-lattice spacing, meters. Cell `(cx,cy)` maps to world `(cx*10, cy*10)`. */
export const COST_CELL_M = 10;
/** Margin (meters) the cost field extends past the domain disc so A* can bend
 * just outside it toward a boundary endpoint. */
export const COST_FIELD_MARGIN_M = 200;
/** Baseline traversal cost of an open, flat, dry, canon-free cell. */
export const BASE_COST = 1;
/** Added cost to cross a sketched river line (expensive ⇒ crossings cluster
 * into shared bridges rather than smearing). Passable, unlike open water. */
export const BRIDGE_COST = 25;
/** Added cost within `CANON_RADIUS_M` of a canon Point — route around pins. */
export const CANON_PENALTY = 8;
export const CANON_RADIUS_M = 30;
/** Slope penalty tuning: `min(SLOPE_PENALTY_MAX, |∇height| × SLOPE_PENALTY_SCALE)`.
 * `heightAt` is in [0,1]; the gradient is a finite difference over one cell,
 * scaled so a steep slope contributes about +3. */
export const SLOPE_PENALTY_SCALE = 60;
export const SLOPE_PENALTY_MAX = 3;

export interface CostField {
  /** Traversal cost of entering cell `(cellX, cellY)`; `Infinity` ⇒ blocked. */
  cellCost(cellX: number, cellY: number): number;
  /** World distance from the cell to the nearest sketched river line, or
   * `Infinity` when the domain has no rivers. `skeleton.ts` marks bridge-span
   * cells as those within `RIVER_HALF_WIDTH + COST_CELL_M` (one cell of
   * approach past the crossing penalty band, matching the seam-test tolerance). */
  riverDist(cellX: number, cellY: number): number;
  /** Is the cell within the cost field's bbox (domain + margin)? A* never
   * expands outside this — the field's finite support bounds the search. */
  inBounds(cellX: number, cellY: number): boolean;
  /** Integer cell bounds (inclusive) of the field, for A* iteration limits. */
  cellBounds: { minX: number; minY: number; maxX: number; maxY: number };
}

function cellToWorld(cell: number): number {
  return cell * COST_CELL_M;
}

/** Canon Point coordinates the network must avoid paving over. */
function canonPoints(constraints: GenerationConstraints): [number, number][] {
  const out: [number, number][] = [];
  for (const f of constraints.canonFeatures ?? []) {
    if (f.geometry.type === "Point") out.push(f.geometry.coordinates as [number, number]);
  }
  return out;
}

/** True inside any sketched water polygon (open water ⇒ impassable). */
function inWater(idx: FabricConstraintIndex, x: number, y: number): boolean {
  for (const ring of idx.waterRings) {
    if (pointInRing(ring, x, y)) return true;
  }
  return false;
}

/** Distance to the nearest sketched river line, or Infinity if none. */
function distToRiver(idx: FabricConstraintIndex, x: number, y: number): number {
  let best = Infinity;
  for (const line of idx.riverLines) {
    const d = nearestOnLine(line, x, y).dist;
    if (d < best) best = d;
  }
  return best;
}

/**
 * Build the cost field for a domain. Everything the closures need is captured
 * once; `cellCost` then samples height noise and the sketched-fabric index
 * purely by position. Coasts (water-polygon boundaries) are handled only as
 * impassable interiors in v3.0 — they get no bridge penalty band.
 */
export function makeCostField(
  citySeed: number,
  domain: CityDomain,
  constraints: GenerationConstraints
): CostField {
  const idx = indexFabricConstraints(constraints.fabricFeatures);
  const canon = canonPoints(constraints);
  const worldBounds = constraints.worldBounds;
  const bbox = domainBBox(domain, COST_FIELD_MARGIN_M);
  const cellBounds = {
    minX: Math.floor(bbox.minX / COST_CELL_M),
    minY: Math.floor(bbox.minY / COST_CELL_M),
    maxX: Math.ceil(bbox.maxX / COST_CELL_M),
    maxY: Math.ceil(bbox.maxY / COST_CELL_M),
  };

  const riverDist = (cellX: number, cellY: number): number =>
    distToRiver(idx, cellToWorld(cellX), cellToWorld(cellY));

  const cellCost = (cellX: number, cellY: number): number => {
    const x = cellToWorld(cellX);
    const y = cellToWorld(cellY);

    // Open water is impassable outright.
    if (inWater(idx, x, y)) return Infinity;

    let cost = BASE_COST;

    // Slope: finite-difference gradient of the height field over one cell.
    const hx =
      heightAt(citySeed, x + COST_CELL_M, y, worldBounds) -
      heightAt(citySeed, x - COST_CELL_M, y, worldBounds);
    const hy =
      heightAt(citySeed, x, y + COST_CELL_M, worldBounds) -
      heightAt(citySeed, x, y - COST_CELL_M, worldBounds);
    const grad = Math.hypot(hx, hy);
    cost += Math.min(SLOPE_PENALTY_MAX, grad * SLOPE_PENALTY_SCALE);

    // River crossing: expensive but passable ⇒ crossings concentrate.
    if (distToRiver(idx, x, y) < RIVER_HALF_WIDTH) cost += BRIDGE_COST;

    // Canon proximity: never pave the GM's pins.
    for (const [px, py] of canon) {
      if (Math.hypot(px - x, py - y) < CANON_RADIUS_M) {
        cost += CANON_PENALTY;
        break;
      }
    }

    return cost;
  };

  const inBounds = (cellX: number, cellY: number): boolean =>
    cellX >= cellBounds.minX &&
    cellX <= cellBounds.maxX &&
    cellY >= cellBounds.minY &&
    cellY <= cellBounds.maxY;

  return { cellCost, riverDist, inBounds, cellBounds };
}
