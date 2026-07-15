/**
 * Stacked-fabric click resolution (Jonah 2026-07-15 — "trying to select
 * farmland right near plateau watch, but I can only select the underlying
 * plateau"). A click box can overlap several fabric polygons at once; a huge
 * terrain stamp (a plateau `landform`) painted under a smaller detail region (a
 * `farmland`) would win the raw `queryRenderedFeatures[0]` pick, so the detail
 * on top was unreachable.
 *
 * Pure resolver so it has a headless test twin (MapView needs a real MapLibre
 * map + DOM). The rule, in order:
 *   1. Line kinds keep their existing proximity/render precedence — they sit
 *      AHEAD of every polygon fill (a road/river click still selects the line
 *      first, unchanged), ordered among themselves by render rank.
 *   2. Among overlapping polygons, the SMALLER ring area wins (topmost-detail —
 *      terrain stamps are huge by nature, so this sinks them naturally).
 *   3. Kind-tier tiebreak: on an area tie, terrain stamps (landform, mountain,
 *      relief) sort BELOW all other kinds (the backstop for a small stamp).
 *   4. Repeated clicks at the same spot CYCLE through the ordered candidates
 *      (first click = farmland, click again = the plateau beneath) so a big
 *      stamp under a detail region stays reachable — the modeling-software
 *      convention.
 */
import type { FabricKind } from "../model/fabric";
import { isPolygonKind } from "../model/fabric";

/** Terrain-stamp kinds — huge by nature; on an area tie they sink below every
 * other kind so a smaller detail region on top wins first (rule 3). */
const TERRAIN_STAMP_KINDS: ReadonlySet<FabricKind> = new Set<FabricKind>(["landform", "mountain", "relief"]);

export function isTerrainStamp(kind: FabricKind): boolean {
  return TERRAIN_STAMP_KINDS.has(kind);
}

/** One overlapping fabric feature under a click box. `rank` is its first-seen
 * index in the raw hit list (render order, topmost first) — the tiebreak that
 * keeps line-kind selection as-is. `area` is the net ring area (0 for lines). */
export interface FabricCandidate {
  id: string;
  kind: FabricKind;
  area: number;
  rank: number;
}

/** The cycle anchor: the pixel a click landed on, the ordered candidate ids
 * there, and which one is currently selected. A follow-up click at the same
 * spot over the same stack advances the index. */
export interface FabricCycleState {
  x: number;
  y: number;
  ids: string[];
  index: number;
}

/** Rule 1–3: line kinds first (by render rank), then polygons by ascending ring
 * area with a terrain-below tiebreak, then a stable id order so the cycle is
 * deterministic. Does not mutate the input. */
export function orderFabricCandidates(cands: FabricCandidate[]): FabricCandidate[] {
  return [...cands].sort((a, b) => {
    const aLine = !isPolygonKind(a.kind);
    const bLine = !isPolygonKind(b.kind);
    // Lines keep their proximity/render precedence, ahead of every fill.
    if (aLine !== bLine) return aLine ? -1 : 1;
    if (aLine && bLine) return a.rank - b.rank;
    // Polygons: smaller ring area first (topmost detail).
    if (a.area !== b.area) return a.area - b.area;
    // Area tie: terrain stamps sink below all other kinds.
    const at = isTerrainStamp(a.kind) ? 1 : 0;
    const bt = isTerrainStamp(b.kind) ? 1 : 0;
    if (at !== bt) return at - bt;
    // Stable, deterministic final order for cycling.
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

const SAME_SPOT_TOL_PX = 4;

/**
 * Resolve which fabric id a select-click picks, advancing the cycle when the
 * click repeats at the same spot over the same stack. Returns the picked id
 * (null when nothing is under the click) and the next cycle state to store.
 */
export function resolveFabricClick(
  cands: FabricCandidate[],
  point: { x: number; y: number },
  prev: FabricCycleState | null,
  tolPx: number = SAME_SPOT_TOL_PX
): { id: string | null; state: FabricCycleState | null } {
  const ordered = orderFabricCandidates(cands);
  if (ordered.length === 0) return { id: null, state: null };
  const ids = ordered.map((c) => c.id);
  let index = 0;
  if (
    prev &&
    Math.hypot(prev.x - point.x, prev.y - point.y) <= tolPx &&
    prev.ids.length === ids.length &&
    prev.ids.every((id, i) => id === ids[i])
  ) {
    index = (prev.index + 1) % ids.length;
  }
  return { id: ids[index], state: { x: point.x, y: point.y, ids, index } };
}
