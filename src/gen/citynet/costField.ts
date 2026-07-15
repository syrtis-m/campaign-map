/**
 * Cost lattice for the arterial A*: a world-anchored 10 m grid over
 * `region.bbox + 200 m` whose
 * per-cell cost encodes where roads want to go — cheap on flat open ground,
 * expensive across a river (so crossings concentrate into bridges),
 * impassable through a lake, and steering clear of the GM's pinned Locations
 * (never pave canon).
 *
 * Determinism/seam argument: `cellCost(cellX, cellY)` is a pure function of the
 * integer cell address and the closed-over constraints — height noise, sketched
 * water/river geometry, canon points. It is world-anchored (cell → world is
 * `cell × 10 m`, independent of any tile or region offset), so the same cell
 * costs the same everywhere and A* over it is reproducible byte-for-byte after
 * a cache delete (D1 — decisions live on the integer lattice; D6 — no hidden
 * inputs). `heightAt` uses `citySeed` because the pure contract exposes no
 * campaignSeed; the field is still fully deterministic.
 */
import { bboxWithMargin, type ProcgenRegion } from "../region";
import type { GenerationConstraints } from "../types";
import {
  blockedByHole,
  indexConstraints,
  nearestOnLine,
  pointInRing,
  RIVER_HALF_WIDTH,
  type FabricConstraintIndex,
} from "../fabricConstraints";
import { heightAt } from "../world/heightmap";

/** Cost-lattice spacing, meters. Cell `(cx,cy)` maps to world `(cx*10, cy*10)`. */
export const COST_CELL_M = 10;
/** Margin (meters) the cost field extends past the region bbox so A* can bend
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
  /** True iff the cell should count as part of a bridge span: within the
   * sketched-river crossing band (`riverDist <
   * RIVER_HALF_WIDTH + COST_CELL_M`) OR inside the GENERATED meandered channel
   * (`upstream.water`). `skeleton.ts`'s `bridgeSpans` keys on this so a bridge
   * tracks the channel, not the straight spine. */
  bridgeCell(cellX: number, cellY: number): boolean;
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

/** True inside any sketched water polygon (open water ⇒ impassable). Note the
 * generated river CHANNEL is NOT here: a channel is passable-but-bridged
 * (`inChannel` + BRIDGE_COST), not an impassable lake. */
function inWater(idx: FabricConstraintIndex, x: number, y: number): boolean {
  for (const ring of idx.waterRings) {
    if (pointInRing(ring, x, y)) return true;
  }
  return false;
}

/** True inside the GENERATED meandered channel. Passable (arterials bridge it),
 * so it adds BRIDGE_COST rather than blocking. Empty when there is no upstream
 * river. */
function inChannel(idx: FabricConstraintIndex, x: number, y: number): boolean {
  for (const ring of idx.channelRings) {
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
 * Build the cost field for a region. Everything the closures need is captured
 * once; `cellCost` then samples height noise and the sketched-fabric index
 * purely by position. Coasts (water-polygon boundaries) are handled only as
 * impassable interiors — they get no bridge penalty band.
 */
export function makeCostField(
  citySeed: number,
  region: ProcgenRegion,
  constraints: GenerationConstraints
): CostField {
  // Region-aware index: the outer ring lets contained nested regions (plan 037
  // item 5) surface as `holeRings` — impassable to arterials, like open water.
  const idx = indexConstraints(constraints, region.ring);
  const canon = canonPoints(constraints);
  const worldBounds = constraints.worldBounds;
  const bbox = bboxWithMargin(region.bbox, COST_FIELD_MARGIN_M);
  const cellBounds = {
    minX: Math.floor(bbox.minX / COST_CELL_M),
    minY: Math.floor(bbox.minY / COST_CELL_M),
    maxX: Math.ceil(bbox.maxX / COST_CELL_M),
    maxY: Math.ceil(bbox.maxY / COST_CELL_M),
  };

  // ── Lazy memoization (perf) ──────────────────────────────────────────────
  // A* touches a fraction of the field's cells, and the arterial searches
  // share it; per-cell height sampling (fractal noise ×4 finite-difference
  // taps) dominated the profile. Caching is invisible to determinism:
  // every cached value is a pure function of the integer cell address +
  // constraints, so first-touch and hundredth-touch return identical numbers
  // regardless of query order. Height is memoized at cell *centers* so
  // adjacent cells share their finite-difference taps (4× fewer samples).
  const stride = cellBounds.maxY - cellBounds.minY + 3;
  const memoKey = (cellX: number, cellY: number): number =>
    (cellX - cellBounds.minX + 1) * stride + (cellY - cellBounds.minY + 1);

  const heightCache = new Map<number, number>();
  const hAt = (cellX: number, cellY: number): number => {
    const k = memoKey(cellX, cellY);
    let v = heightCache.get(k);
    if (v === undefined) {
      v = heightAt(citySeed, cellToWorld(cellX), cellToWorld(cellY), worldBounds);
      heightCache.set(k, v);
    }
    return v;
  };

  const riverCache = new Map<number, number>();
  const riverDist = (cellX: number, cellY: number): number => {
    const k = memoKey(cellX, cellY);
    let v = riverCache.get(k);
    if (v === undefined) {
      v = distToRiver(idx, cellToWorld(cellX), cellToWorld(cellY));
      riverCache.set(k, v);
    }
    return v;
  };

  const channelCache = new Map<number, boolean>();
  const inChannelCell = (cellX: number, cellY: number): boolean => {
    if (idx.channelRings.length === 0) return false;
    const k = memoKey(cellX, cellY);
    let v = channelCache.get(k);
    if (v === undefined) {
      v = inChannel(idx, cellToWorld(cellX), cellToWorld(cellY));
      channelCache.set(k, v);
    }
    return v;
  };

  /** A bridge-span cell: the sketched-river crossing band OR inside the
   * generated meandered channel — so bridges cluster over the real water. */
  const bridgeCell = (cellX: number, cellY: number): boolean =>
    riverDist(cellX, cellY) < RIVER_HALF_WIDTH + COST_CELL_M || inChannelCell(cellX, cellY);

  const costCache = new Map<number, number>();
  const cellCost = (cellX: number, cellY: number): number => {
    const k = memoKey(cellX, cellY);
    const cached = costCache.get(k);
    if (cached !== undefined) return cached;

    const x = cellToWorld(cellX);
    const y = cellToWorld(cellY);
    let cost: number;

    // Open water — and a contained nested-region hole (plan 037 item 5) — are
    // impassable outright, so arterials route AROUND them.
    if (inWater(idx, x, y) || blockedByHole(idx, x, y)) {
      cost = Infinity;
    } else {
      cost = BASE_COST;

      // Slope: finite-difference gradient of the height field over one cell,
      // sampled at neighboring cell centers (memoized, shared with neighbors).
      const hx = hAt(cellX + 1, cellY) - hAt(cellX - 1, cellY);
      const hy = hAt(cellX, cellY + 1) - hAt(cellX, cellY - 1);
      const grad = Math.hypot(hx, hy);
      cost += Math.min(SLOPE_PENALTY_MAX, grad * SLOPE_PENALTY_SCALE);

      // River crossing: expensive but passable ⇒ crossings concentrate. The
      // sketched-river band OR the generated meandered channel both
      // charge the bridge toll, so crossings cluster over the real water.
      if (riverDist(cellX, cellY) < RIVER_HALF_WIDTH || inChannelCell(cellX, cellY)) cost += BRIDGE_COST;

      // Canon proximity: never pave the GM's pins.
      for (const [px, py] of canon) {
        if (Math.hypot(px - x, py - y) < CANON_RADIUS_M) {
          cost += CANON_PENALTY;
          break;
        }
      }
    }

    costCache.set(k, cost);
    return cost;
  };

  const inBounds = (cellX: number, cellY: number): boolean =>
    cellX >= cellBounds.minX &&
    cellX <= cellBounds.maxX &&
    cellY >= cellBounds.minY &&
    cellY <= cellBounds.maxY;

  return { cellCost, riverDist, bridgeCell, inBounds, cellBounds };
}
