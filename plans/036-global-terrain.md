# Plan 036 — Global terrain: terrainAt(x,y), stamp objects, river carve, lazy render leaves

**Status:** TODO. Ratified via `plans/research-generation-pipeline.md` §5 (Jonah 2026-07-14;
§9 Q3 grading default-off, Q4 priority param, Q5 base-params-behind-Apply all OK'd).

**Depends:** 035 (stage positions), plan 023's `src/gen/fields/` modules (shipped). **Read first:**
research report §5 in full (composition, grammar, guards, precedent); `src/gen/fields/mountainField.ts`
(the legality pattern this generalizes); plan 023 §0 (point-evaluability — still binding).

## 0. Context for a cold-start implementer

Today elevation exists only where mountain sketches are (`elevationFieldFromFabric`). This plan
makes terrain a first-class campaign-wide layer with mountains as one of several *terrain-modifier
stamps*, composed closed-form (report §5.1):

```
T(x,y) = grade( carve( replace( add( B(x,y) ) ) ) )
```

Every term is a pure function of durable sketch data — point-evaluable, no global passes, analytic
gradients via chain rule, id-sorted folds per operator class (FP determinism: sort BEFORE fold).
`world/heightmap.ts#heightAt` stays byte-frozen (biomes); `terrainAt` is NEW and defaults inert
(base amplitude 0 ⇒ every existing campaign byte-stable until opted in).

## 1. Scope

1. **36-A — Composition + stamps v1:** `fields/terrain.ts` with base (flat default), add-stamps
   (mountain migrated verbatim — bit-exactness gate vs `elevationFieldFromFabric`, the plan-023
   retrofit rule), replace-stamps (plateau/mesa, basin, coastline→seaDatum) with optional integer
   `priority` (ratified Q4: id-order last-wins, priority as the GM knob), ridge/valley polyline
   stamps (signed cross-profile). New sketch kinds + registry entries at stage 1. Cliffs/craters
   deferred (domain warp — v2).
2. **36-B — River carve:** `smin(T, bed_k)` per river, keyed on the sketched spine + durable
   `(seed, params)` via a memoized per-region channel field (simplified bed: main channel only).
   **Binding:** every polyline-keyed stamp/carve uses a segment spatial hash (`spatialHash.ts`) —
   naive nearest-point over a continental spine is ~1e9 ops per lattice fill. Lattice discipline:
   chunked `Float32Array` tiles + LRU, never a global `Map` (0.5–1 GB at 30×30 km); worker-side
   memo keyed on the terrain fingerprint, bounded.
3. **36-C — Render leaves:** contours migrate from per-mountain-region features to viewport-keyed,
   LAZILY computed products of the composed field (cache key = hash of durable terrain inputs
   intersecting the tile; LRU; never eager whole-campaign — a base-noise 30×30 km campaign is
   ~2.4 M samples ≈ 10–30 s on the Surface Pro if eager). Hillshade/DEM same treatment; sampling in
   the worker. 2×2 seam gates mandatory. Terrain toggle stays visibility-only.
4. **36-D — Grading + base surface:** city-site grading term (flatten toward the persisted
   `center`'s elevation) DEFAULT OFF (ratified Q3); campaign base params (`campAmp`, `seaDatum`)
   live in map settings behind an explicit **Apply** with a cost notice (ratified Q5) — never a
   live slider; the 034 cost-weighted cap counts leaf work.
5. **Consumers reconnect** (existing behavior, new source): river opt-in slope, farmland paddy read
   `terrainAt` in place of `elevationFieldFromFabric` (bit-exact when only mountain stamps exist —
   gate), so 037/038's terrain edges have one source of truth.

## 2. Phases & verification (headless — NO live gates, per Jonah 2026-07-14)

- **36-A:** bit-exactness golden (mountain-only fixture: `terrainAt` ≡ `elevationFieldFromFabric`
  to the float); operator-class determinism (shuffled stamp enumeration ⇒ identical samples);
  gradient checks (analytic vs central difference within tolerance); priority/id-order tests.
- **36-B:** carve fixture goldens (gorge across a mountain stamp); segment-hash perf budget as a
  counter (segment tests per sample ≤ bound); lattice memory budget as entry-count assertions;
  byte-identity for campaigns with no rivers.
- **36-C:** 2×2 contour seam tests on the composed field; laziness counters (leaf computed only on
  first viewport touch; LRU eviction observable); byte-stability of existing mountain-region
  feature output (massif/hachure/peak unchanged — only contours re-home).
- **36-D:** grading-off byte-identity; Apply-deferred invalidation test (no recompute before
  Apply). Contour/hillshade paint is judged in the playground and in normal app use — no scripted
  live check.

## 3. STOP conditions / risks

- Point-evaluability is the axe: if any term needs a neighborhood or whole-map pass, it is wrong
  for this codebase (plan 023 §0). The only sanctioned exception stays region-scoped whole-artifact
  work (the carve's memoized channel field qualifies — it is per-river-region).
- The two-oceans problem (sketched coastline vs frozen world-tier ocean paint) is explicitly OUT of
  scope — note the disagreement, defer the world-tier deference to its own flagged migration.
- If mountain migration cannot be made bit-exact, STOP: that re-rolls every existing mountain on
  upgrade, which is a version-bump-with-adoption decision Jonah must make explicitly, not a silent
  outcome.
