/**
 * World-gen tuning constants (docs/06 §3: "Poisson r by zoom band table in
 * src/gen/world/params.ts"). Single band for now — per-zoom bands are a
 * Phase 4 LOD-dispatch concern, not a Phase 3 generation-correctness one.
 */
export const WORLD_REGION_CELL_SIZE = 700;
export const SETTLEMENT_SUITABILITY_THRESHOLD = 0.45;
export const ROUTE_MAX_DISTANCE = WORLD_REGION_CELL_SIZE * 3;
export const ROUTE_K_NEAREST = 2;
