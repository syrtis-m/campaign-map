# Plan 021 — Constraint fields (layered SDFs + masked noise) and elevation

**Status:** research/design, approved direction from Jonah 2026-07-12 ("explore the
method of doing elevation as described in iquilezles.org/articles/morenoise and
the fractal perlin noise + gradient trick… elevation lines on the map, but also
the ability to do a 3d terrain style thing… include a research into layered
signed distance fields + masked noise layering"). Builds on plan 020 (sketch-
driven procgen regions). Not yet scheduled; plan 022 (algorithm suite) and 023
(cross-layer cascade) depend on the field architecture in §2.

## 1. Research findings

### 1.1 Elevation techniques (iq morenoise + the "gradient trick")
- **Analytical-derivative value noise** (iq): value noise is a polynomial in the
  cell-local coordinates (2D: `n = k0 + k1·u + k2·v + k3·uv` with quintic-eased
  u,v), so its partial derivatives come from the same coefficients at ~zero
  extra cost — one evaluation instead of the five a finite-difference gradient
  costs. Quintic easing (`u' = 30x²(x²−2x+1)`) keeps the derivative continuous.
- **Gradient-damped fBm** ("gradient trick" / iq's erosion-like sum): accumulate
  per-octave derivatives into a running vector `d`; each octave contributes
  `amp · n / (1 + dot(d,d))`. Steep areas (large accumulated gradient) suppress
  fine octaves — the visual signature of erosion (smooth steep slopes, detailed
  flats/ridgelines) at fBm cost. Tunable: the damping exponent/curve shapes
  slope character (pointy vs rounded), per-preset.
- **Why not real erosion:** global simulation; cannot generate a tile without
  its neighbors; violates our determinism/seam model outright. The gradient
  trick is *point-evaluable* — `elevationAt(seed,x,y)` with no neighborhood —
  which is exactly the property `world/noise.ts` already has. This is the
  chosen base.
- **DLA ridges** (diffusion-limited aggregation, multi-resolution + dual-filter
  blur): grows genuinely ridge-like mountain skeletons; CPU-only, whole-artifact
  generation. NOT chunk-safe as a global field — but our plan-020 region model
  generates whole artifacts per sketched region and clips, so DLA is viable
  later as a *mountain-region algorithm* (sketch a mountain range polygon →
  DLA ridge web inside it, rasterized to a local elevation contribution).
  Deferred: appendix §6; the gradient trick ships first.

### 1.2 Layered SDFs + masked noise layering
- A **signed distance field** per shape (`+` inside, `−` outside, meters) is the
  common currency between sketches, procgen output, and fields. Plan 020's
  `distanceToBoundary`/`interiorT` already *is* a normalized interior SDF — this
  plan generalizes it rather than inventing something new.
- **Layering** = pointwise combinators: union `max(a,b)` (on signed-inside
  convention), intersect `min`, subtract `min(a,−b)`, and smooth-min for
  organic blends. All closed-form, deterministic, point-evaluable.
- **Masked noise layering**: a field's amplitude is modulated by an SDF-derived
  mask, e.g. `mask = smoothstep(0, band, sdf(x,y))` — noise only inside a
  shape, fading at its edge. This is the mechanism for "mountain noise only
  inside the sketched mountain polygon", "forest density falls off at the
  treeline", "elevation carves down near rivers". One primitive, many features.

## 2. Field architecture — `src/gen/fields/`

New pure module family (no DOM/Obsidian; D1–D6 binding):

```ts
export type Field = (x: number, y: number) => number;   // meters in, scalar out
// SDF builders (signed, + inside, meters):
sdfPolygon(ring): Field                 // exact per-segment (reuses region.ts math)
sdfPolyline(line, halfWidth): Field     // capsule distance
// Combinators:
fUnion(a, b), fIntersect(a, b), fSubtract(a, b), fSmoothUnion(a, b, k)
// Transforms:
fMask(sdf, band): Field                 // smoothstep 0..1 over `band` meters inside
fOffset(f, c), fScale(f, s), fClamp(f, lo, hi), fSum(...fields)
// Noise (extends world/noise.ts):
valueNoise2DWithDeriv(seed, x, y, cell, salt): { v, dx, dy }   // analytic, quintic
fbmEroded(seed, x, y, opts): number     // gradient-damped fBm (§1.1), opts: octaves,
                                        // lacunarity, gain, damping, warp
```

Spatial acceleration: SDF builders over many features use the existing
flatbush/spatial-hash pattern; everything stays a pure function of (inputs,
position) — never of tile identity (seam rule).

**Retrofit (mechanical, low-risk):** `interiorT` becomes a thin wrapper over
`sdfPolygon`; fabricConstraints' water/river predicates become SDF masks. No
behavior change; one distance implementation to test.

## 3. Elevation model

One campaign-wide deterministic field, composed of layers (all point-evaluable):

```
elevation(x,y) = base(x,y)                          // gentle continental fBm (existing heightAt, upgraded)
  + Σ mountainRegion_i:  fMask(sdf_i, band) · ridged_or_eroded_fbm_i(x,y)   // sketched ranges
  − Σ water:             carve(sdfWater, depth, band)                        // rivers/lakes press down
  ± cityRegions:         fMask · flatten-toward-local-mean (grade the town site)
```

- **Sketched mountain regions** (new `mountain` polygon kind, plan 022) carry a
  procgen block with elevation params — presets: `alpine` (high damping, ridged),
  `mesa` (terraced transform), `rolling-hills` (low octaves, no ridging), plus
  amplitude/roughness sliders. The GM shapes relief by sketching, same grammar
  as cities.
- The field is an INPUT to other generators (plan 023 stage 0): rivers flow
  downhill, routes prefer gentle gradients (analytic derivative = free slope
  queries), city cost fields penalize steep ground.
- Determinism: elevation is `f(campaignSeed, sketch layer, position)` only.
  Editing a mountain region's params/ring dirties elevation under its bbox →
  cascade per plan 023.

## 4. Rendering

### 4.1 Contour lines (the map-first deliverable)
- Marching squares over a per-tile lattice (e.g. 20 m) sampling `elevation()`;
  emit `elevation-contour` LineString features (property: `elevation`,
  `index: minor|major`) into the normal generated-feature pipeline (cache,
  clip, themes own paint — thin/faint minor, labeled major every 5th).
- Seam safety: lattice is world-aligned (like costField) and marching squares
  on shared edges sees identical samples → identical crossings; 2×2 seam gate
  mandatory. Contour generation is a *tier/field* output, not a region output —
  generated for the tiles of regions/areas the GM has requested (explicit-only
  survives; a "Terrain" toggle in map settings controls visibility, not
  generation).

### 4.2 Hillshade + 3D
- Generate **raster-DEM tiles** (terrarium RGB encoding) on demand from the same
  field via a custom protocol handler (precedent: `pmtilesVaultProtocol`) —
  canvas-encoded in the view layer (host code, not gen). Feed a MapLibre
  `raster-dem` source: `hillshade` layer for shaded relief in 2D, and
  `map.setTerrain({source, exaggeration})` for the 3D terrain view (MapLibre GL
  ≥ v3 native; desktop-first, toggle button next to the theme switcher;
  verify perf on the Surface Pro budget before default-on).
- DEM tiles are regenerable cache (never synced); deleting them is harmless.

## 5. Open questions (for implementation-time rulings)
1. Contour density/labeling defaults per theme (parchment wants hachure-adjacent
   aesthetics; modern-clean wants clean isolines) — themes own paint, but label
   cadence is a layout decision.
2. Does base elevation apply to real-city (PMTiles) campaigns? Proposal: no —
   elevation is fictional-campaign-only in v1.
3. Bathymetry (negative elevation under water kind) — cheap with fSubtract, but
   defer until something consumes it.

## 6. Appendix — DLA mountain-region algorithm (deferred)
Region-scoped DLA fits the plan-020 whole-artifact model: seed pixels along the
region's medial axis, grow ridge web (deterministic RNG walk), multi-res
upscale + dual-filter blur → local heightfield, blended via fMask into §3's
sum. CPU cost bounded by region area; cache the rasterized artifact like a city
network. Revisit after §3 ships and if gradient-trick ranges look too smooth.
