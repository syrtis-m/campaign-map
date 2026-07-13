# Plan 023 — Constraint fields (layered SDFs + masked noise) and elevation

**Status:** research/design, approved direction from Jonah 2026-07-12 ("explore the
method of doing elevation as described in iquilezles.org/articles/morenoise and
the fractal perlin noise + gradient trick… elevation lines on the map, but also
the ability to do a 3d terrain style thing… include a research into layered
signed distance fields + masked noise layering"). Builds on plan 020 (sketch-
driven procgen regions). Build order: plan 022 (algorithm suite) starts first with documented
fallbacks; its field-coupled variants and 024 (cross-layer cascade) depend on
the field architecture in §2.


## 0. Context for a cold-start implementer (read even if you skip everything else)

**The product in one line:** an Obsidian plugin giving a solo GM a
Google-Maps-style tab for tabletop campaigns; locations invented mid-session
become notes + pins in ≤5 s, and background world detail is procedurally
generated *only on explicit GM request*, deterministically, forever.

**Read before writing code:** `CLAUDE.md` (locked decisions — binding),
`plans/020-sketch-driven-procgen-regions.md` (the architecture you're
extending), `procgen_v3_design.md` §4 (determinism rules D1–D6 — binding),
`docs/05-dev-workflow.md` + `docs/06-autonomous-build.md` (build/gate
protocol), and skim `scripts/gates/procgen40.ts`/`procgen41.ts` (the live-gate
patterns to clone).

**State you inherit (plan 020, shipped):** the three-layer model — layer 1
procgen fabric (regenerable `.mapcache/` JSONL, disposable by design), layer 2
sketches (`Fabric.geojson`, GM-owned, selectable/editable via the Select tool),
layer 3 note-backed Locations (always on top; `layerOrder.ts` asserts it). A
sketched shape carrying a `procgen` block (`{algorithm, seed, version,
params}`) IS the generation request: `src/gen/procgen/registry.ts` maps
sketch-kind → algorithm; `src/gen/region.ts` is the polygon geometry core;
`src/gen/citynet/` computes a whole artifact per region which tiles then CLIP —
that is the seam story (adjacent tiles agree because they cut the same bytes).
The seed is persisted at creation and survives vertex edits (the identity
property: edits ADAPT output, only explicit re-roll REPLACES it). MapView owns
the lifecycle (sketch-finish → modal → generate; edit → debounced regen;
`sketch-procgen-set/clear`/`sketch-edit` log types with undo).

**Non-negotiable invariants (don't re-derive, don't violate):**
- *Explicit-only generation*: pan/zoom never generates (`generatorRunCount`
  stays flat in every gate); sketching/confirming IS the request.
- *Determinism is sacred*: same durable inputs → byte-identical output,
  forever; deleting `.mapcache/` must be harmless — a replay byte-diff is a
  release blocker, not a flaky test. Hence: params/seeds persisted, ids hashed
  on position/path never emission order, budgets not convergence, trig only
  for sampling, mm quantization + canonical sort on emit.
- *Generators are pure headless* `src/gen/` functions (no DOM/map/Obsidian
  imports, read only their arguments); zod at every IO boundary (bad data →
  warning, never silent drop, never crash).
- *Generators emit typed features only; themes own ALL paint.*
- *The GM's hand always wins*: output stays inside the sketched shape/corridor;
  sketch/location geometry is never overwritten.

**Infra pitfalls that cost previous agents real hours (all still live):**
- Obsidian CLI: `plugin:reload id=campaign-map`, NEVER `plugin:enable` (no-op
  when already enabled → you test stale code); async evals park results on
  `window` globals and poll; front the window before `dev:screenshot` and
  actually LOOK at it; `dev:errors` clean; run from `dev-vault/` only.
- Long Obsidian sessions degrade the renderer (`isStyleLoaded` false
  everywhere) — only a full process quit+relaunch clears it; run final boards
  one-gate-per-fresh-process.
- Modals hang CLI automation — every GM flow needs a headless test-API twin on
  `app.plugins.plugins['campaign-map']` running the FULL commit path
  (precedents: `createRegionForTest`, `moveVertex`, `setRegionParams`).
- Fictional campaigns sit at overview zoom ~z4.5 — never bake absolute zoom
  thresholds; Jonah's standing ruling: zoom LOD affects location-name
  visibility ONLY (fabric always renders).
- `dev-vault/Campaigns/Vespergate` holds Jonah's REAL campaign data (migrated
  district `fabric-mri7r4bj-ll0bd5`, 5 hand-sketched districts): gates use
  name-tagged fixtures, self-clean, and must leave his files byte-intact.
- Never bypass `appendCachedTile` (`src/model/tileCache.ts`) — cache appends
  serialize through a per-file promise chain (a fixed write race).

**Protocol:** phase-by-phase with one gate per phase (unit + live), PROGRESS.md
updated, every judgment call logged in DECISIONS.md, commit per green gate with
the `[gate: …]` message convention. **Board cadence (Jonah 2026-07-13): a
phase commits on T1 — fast suite + tsc + build + the phase's OWN live gate
standalone (+ fuzz iff generator behavior changed); this plan's ONE full board
runs at 23-D. Never run `board`/`board --changed` per phase.** Open questions need a ruling from Jonah or
the orchestrator — if unavailable, decide, log decision AND rationale in
DECISIONS.md, and flag it prominently in your report; never guess silently.

**Plan-023-specific intent:** everything here exists to serve ONE property —
*point-evaluability*. A field must answer `f(x, y)` from durable inputs alone,
with no neighborhood, no iteration over the map, no global pass. That is what
makes tiles seam-free (identical samples on shared edges) and determinism
cheap. It is why real erosion simulation is rejected (§1.1) and the gradient
trick chosen; if an implementation choice ever requires "generate the whole
map first", it is wrong for this codebase — region-scoped whole-artifact
generation (the DLA appendix) is the only sanctioned exception, because
plan 020 already caches and clips whole artifacts per sketched region.
Performance context: the budget is 60 fps pan on a Surface Pro inside
Obsidian; the citynet cost field's lazy memoized 10 m lattice (16× speedup)
is the precedent for making field sampling affordable — build the lattice
memoization in from the start, don't retrofit it.

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

**Retrofit — bit-exactness is mandatory (adversarial review 2026-07-12):**
`interiorT` becomes a thin wrapper over the fields module — but the wrapping
direction matters: the fields module must CALL the existing `region.ts`
distance code (or move it verbatim), never reimplement it. A float-level
difference in `distanceToBoundary` changes `interiorT`, which changes cityness,
which re-rolls every existing city on upgrade — violating the cross-version
identity property (plan 022 §1). Gate: after the retrofit, a fixture region's
`generateCityNetwork` output must be byte-identical to the pre-retrofit
snapshot. Same rule for fabricConstraints' water/river predicates.

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
- The field is an INPUT to other generators (plan 024 stage 0): rivers flow
  downhill, routes prefer gentle gradients (analytic derivative = free slope
  queries), city cost fields penalize steep ground.
- Determinism: elevation is `f(campaignSeed, sketch layer, position)` only.
  Editing a mountain region's params/ring dirties elevation under its bbox →
  cascade per plan 024.
- **Compatibility (adversarial review 2026-07-12):** the existing
  `world/heightmap.ts#heightAt` feeds world-tier regions/biomes TODAY —
  swapping its guts would silently reshape every existing campaign's world
  tier. The new elevation field is a NEW function consumed only by NEW
  features (contours, DEM, plan-022 river slope, plan-024 stage 0); world-tier
  generators keep the old `heightAt` untouched until a deliberate, flagged
  migration with its own plan. Expose `elevationWithGrad(x,y)` (value + analytic
  gradient) — rivers/routes need slope queries, and the derivative is already
  computed inside the fBm loop.

## 4. Rendering

### 4.1 Contour lines (the map-first deliverable)
- Marching squares over a per-tile lattice (e.g. 20 m) sampling `elevation()`;
  emit `elevation-contour` LineString features (property: `elevation`,
  `index: minor|major`) into the normal generated-feature pipeline (cache,
  clip, themes own paint — thin/faint minor, labeled major every 5th).
- Seam safety: lattice is world-aligned (like costField) and marching squares
  on shared edges sees identical samples → identical crossings; 2×2 seam gate
  mandatory. Contour generation is a *tier/field* output, not a region output —
  generated for tiles the GM has ALREADY requested — precisely: every
  world-tier manifest entry's tile and every procgen region's overlapping
  tiles get contour records the next time they (re)generate. There is no new
  request surface and no contour-only trigger; a "Terrain" toggle in map
  settings controls layer VISIBILITY only, never generation (explicit-only
  survives untouched).

### 4.2 Hillshade + 3D
- Generate **raster-DEM tiles** (terrarium RGB encoding) on demand from the same
  field via a custom protocol handler (precedent: `pmtilesVaultProtocol`) —
  canvas-encoded in the view layer (host code, not gen). Feed a MapLibre
  `raster-dem` source: `hillshade` layer for shaded relief in 2D, and
  `map.setTerrain({source, exaggeration})` for the 3D terrain view (MapLibre GL
  ≥ v3 native; desktop-first, toggle button next to the theme switcher;
  verify perf on the Surface Pro budget before default-on).
- DEM tiles are regenerable cache (never synced); deleting them is harmless.
- **DEM determinism trap (adversarial review 2026-07-12):** PNG bytes are NOT
  a determinism surface — zlib/canvas encoders vary across platforms and
  versions. Cache the raw height lattice (quantized ints) as the durable
  record and encode to terrarium PNG at SERVE time in the protocol handler;
  byte-diff gates compare the height lattices, never the PNGs. Heights encode
  via the campaign's `scaleMetersPerUnit` (fictional CRS) so exaggeration
  reads in real meters.

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
