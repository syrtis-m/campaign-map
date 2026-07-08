/**
 * World-gen tuning constants (docs/06 §3: "Poisson r by zoom band table in
 * src/gen/world/params.ts"). Single band for now — per-zoom bands are a
 * Phase 4 LOD-dispatch concern, not a Phase 3 generation-correctness one.
 */
// 250m rather than a continent-scale value: a small fictional campaign (an
// 800m-wide town, say) needs several region sites inside its own bounds for
// world-gen to place anything at all — too coarse a cell and a modest
// campaign can easily land entirely on one ocean-biome site and never roll
// a settlement (quality-bar F4: no blank voids). Not pinned by docs/06 §3.
export const WORLD_REGION_CELL_SIZE = 250;
export const SETTLEMENT_SUITABILITY_THRESHOLD = 0.45;
export const ROUTE_MAX_DISTANCE = WORLD_REGION_CELL_SIZE * 3;
export const ROUTE_K_NEAREST = 2;
