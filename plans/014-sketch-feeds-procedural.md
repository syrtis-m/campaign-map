# Plan 014: Sketch → procedural inference ("Sims landscaping") — DESIGN

> **Status: DESIGN outline, not executor-ready.** Depends on 013 (fabric store + rendering). The generator-coupling here is the crux of the user's ask and needs a dedicated design pass + advisor consult before it becomes a step-by-step plan. Captured now so the intent isn't lost.

## The ask (user)
"Sketches should feed procedural generation — infer from the sketch and build that out, either simple sketch smoothing or something else… give me tools that I can use to either directly sketch OR feed the procedure — a la the Sims landscaping."

So each fabric feature (013) carries an intent, and the generator elaborates it: you drag a rough road → it lays a real road network along that corridor; you blob a district → it fills with blocks/footprints of that character; you draw a river → it meanders and widens it. You can also keep any feature "literal" (direct sketch, no elaboration).

## Architectural fit (already supported)
Generators are pure `(seed, bbox, constraints) => Feature[]` (`src/gen/**`) and CLAUDE.md already locks "canon geometry feeds generators as constraints; canon is never overwritten by generators." Plan 014 makes the **fabric collection a constraint input** to the generators. Determinism is preserved: `hash(seed, tile, …)` still drives elaboration; the sketch is an additional deterministic input.

## Per-kind elaboration (the "infer and build out")
- **road (line)** → seed the tensor-field street generator (`src/gen/city/`): the drawn polyline is a major streamline; branching minor streets grow off it. "Simple smoothing" = spline-smooth the drawn line first, then treat as an arterial.
- **district (polygon)** → constrain block subdivision to the drawn area + bias the district *type* (residential/market/industrial) chosen at draw time → footprint density/size.
- **river (line)** / **water (polygon)** → meander the drawn line (deterministic noise) + carve banks; polygon water clips generated fabric out of it.
- **wall (line)** → generator avoids placing streets/footprints across it (barrier constraint); optional gate openings.
- **park (polygon)** → suppress footprints, sparse/green fill inside.

Each fabric feature gets a `mode: "literal" | "generate"` (extend 013's schema) and, for generate mode, kind-specific params (district type, road class).

## Two modes per the user
- **Directly sketch** → `mode: "literal"` (013 already renders it as-is).
- **Feed the procedure** → `mode: "generate"`: on generate/regenerate, the generators read these features as constraints and produce fabric that follows them. The generated result is cache (regenerable); the sketch stays canon. Re-running regenerates identically (determinism) and still respects the sketch.

## Open design questions (resolve before executing)
1. **Constraint plumbing**: `GenerationContext`/`generateTile` currently pass canon as constraints — extend to carry the fabric collection, clipped to the tile bbox. Where does clipping/spatial-index live (flatbush)?
2. **Tensor-field seeding** from an arbitrary polyline: how to convert a drawn corridor into streamline seeds without breaking the 2×2 seam determinism (halo overlap). This is the hardest part — likely the first vertical slice to prototype (road → streets) before districts/rivers.
3. **Preview/commit UX**: does elaboration run live as you draw (expensive) or on an explicit "build from sketch" action? Recommend explicit action for v1 (draw → "Generate from sketch" → see result → keep/undo).
4. **Smoothing**: Catmull-Rom / Chaikin on the raw polyline before elaboration; pure + testable.

## Suggested build order (each a vertical slice, own plan when ready)
1. **road → street network** (highest value, exercises the constraint plumbing end-to-end).
2. **district polygon → block fill**.
3. **river meander + water clip**.
4. wall barrier, park suppression.

## Do first
- Land 013.
- Advisor consult on the constraint-plumbing + tensor-seed-from-polyline determinism (seam tests are mandatory per CLAUDE.md — 2×2 adjacent-tile snapshot).
- Prototype the road→streets slice headless (pure generator + seeded snapshot) before any UI, per the "generators are pure/headless" rule.
