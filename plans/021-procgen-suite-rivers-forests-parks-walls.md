# Plan 021 — Procgen algorithm suite: rivers, forests, parks, walls (+ the preset pattern)

**Status:** research/design, approved direction from Jonah 2026-07-12 ("procgen
rivers, walls, forests, parks, etc. all of those should let the person change
the default behavior — e.g. make a river very windy/split, forests of different
types — i like the dropdown when creating a city here, similar templates are
good throughout"). Builds on plan 020's registry; consumes plan 022 fields
where noted; regen interactions are plan 023's contract.

## 1. The preset pattern (do this first — it's the UX Jonah endorsed)

Registry entries (plan 020 §5) gain first-class presets:

```ts
interface ProcgenAlgorithm {
  …
  presets: { id: string; label: string; params: Record<string, unknown> }[];
  defaultPresetId(themeId: string): string;
}
```

- **RegionProcgenModal + the selected-feature panel render: a preset dropdown**
  (the "template"), then the algorithm's param controls seeded from the preset
  (zod-schema-driven, as today). Changing a control = "Custom (from <preset>)".
- The persisted procgen block stores only `params` (+ optional `presetId` for
  display) — presets are sugar over params, never a runtime dependency
  (determinism: params are the whole truth).
- City retrofits onto this: the four profiles become presets of the city
  algorithm (params gain room for future knobs: density, wall override).

## 2. Line-kind procgen (extends plan 020, which was polygon-only)

Rivers and walls are sketched as LINES; the sketch is the *spine*, procgen
elaborates it. Registry `appliesTo` already keys on FabricKind — the host
lifecycle (finish-sketch → modal, edit → regen, select → panel) generalizes:
`makeSpine(id, line)` (mm-quantized polyline + arc-length index) alongside
`makeRegion`. Generated output belongs to the spine feature exactly like region
output (cache keys `region:<featureId>:…` unchanged — the id is the contract,
not the geometry type). Output containment rule becomes a corridor: all output
within `maxOffset` of the spine (gate-asserted per algorithm).

## 3. The algorithms

### 3.1 River (`river` line kind) — the marquee params Jonah named
- **Params:** `windiness` (meander amplitude+frequency, 0=faithful to sketch),
  `braiding` (0–1 split/rejoin probability), `width` (base m), `widthGrowth`
  (downstream widening), preset dropdown: `lazy-lowland` (wide, windy, braided),
  `mountain-torrent` (narrow, straight, rocky), `canal` (dead straight, uniform),
  `delta` (heavy braiding near the end).
- **Generation:** deterministic meander = seeded harmonic offsets sampled along
  arc-length (position-keyed phases — D2-safe), displacing the sketched spine;
  braids = seeded arc-length intervals splitting into 2 channels offset by a
  lens shape, rejoining (islands emerge as the lens interior). Emit
  `river-channel` polygons (+ `river-island`), banks as the channel SDF's zero
  set. When plan 022 lands: meander amplitude modulated by local slope
  (flat → windy, steep → straight) and flow direction sanity-checked downhill.
- **Constraint face:** the GENERATED channel polygons (not the sketched spine)
  become the water constraint downstream — that is plan 023's cascade; until
  then the spine keeps feeding constraints as today (RIVER_HALF_WIDTH).

### 3.2 Forest (new `forest` polygon kind)
- New FabricKind (additive zod change; sketch sub-bar gains the kind button).
- **Params:** preset `broadleaf` / `conifer` / `mixed` / `swamp` / `dead-wood`;
  `density` (0–1); `clearings` (0–1); `edgeRaggedness`.
- **Generation:** canopy = region SDF mask × masked noise (plan 022 primitives;
  pre-022 fallback: interiorT + existing valueNoise2D). Emit `forest-canopy`
  polygons (marching squares on the masked density field, same seam discipline
  as contours), `forest-clearing` holes, and sparse `forest-tree` point symbols
  near the boundary at high zoom (position-hashed jitter grid = deterministic
  Poisson-ish). Themes own paint per preset type property.
- Cities and forests overlap legitimately (a town in the woods): forest is
  stage-2 vegetation, city is stage-3 — the city's footprint area *subtracts*
  from canopy via cascade (plan 023), not via overlap rejection.

### 3.3 Park (`park` polygon kind — currently inert)
- **Params:** preset `formal-garden` (axial paths, symmetric beds),
  `city-park` (curved paths, lawns, pond option), `wild-common` (paths only,
  scattered trees), `japanese-garden` (Jonah 2026-07-12 — see below);
  `pathDensity`, `pond` (bool).
- **Generation:** mini path web (P&M growth with park-tuned profile — reuse of
  the plan-019/020 growth loop at small scale), lawn/bed faces from the path
  graph (reuse faces.ts), tree rows along paths. Small scope; mostly reuse.
- **`japanese-garden` preset:** deliberately asymmetric where formal-garden is
  axial — composition by *placement*, not symmetry. Elements: a winding
  single-track path circuit (strolling-garden style: low branchProb, high
  curvature, no straight runs); a pond as the composition anchor (irregular
  smooth-min blob via the SDF primitives, sized to the region — the classic
  pond-and-hill garden), with an island and 1–2 short bridges where the path
  crosses; deterministic rock groupings (2–3–5 clusters, position-hashed like
  tree stipples but sparse and weighted toward pond edge and path bends);
  specimen trees placed individually at path viewpoints rather than in rows;
  optional raked-gravel court (`karesansui`) as one rectangular clearing near
  the entrance when the region is large enough. Emits the same feature types as
  other presets plus `park-rock` (Point) and reuses `river-island`/bridge
  emitters from §3.1 at pond scale — themes decide the aesthetic per preset
  property (ink-soot should render these beautifully). Good preset-fuzz target:
  small regions must degrade gracefully (drop court → drop island → pond only).

### 3.4 Wall (`wall` line kind)
- **Params:** preset `curtain-wall` (stone, towers), `palisade` (wood, no
  towers), `bastioned` (angular trace, star-fort-ish); `towerSpacing`,
  `moat` (bool), `gatehouseScale`.
- **Generation:** towers at deterministic arc-length intervals (position-keyed),
  gates where sketched/generated roads cross the spine (reusing the plan-020
  gate-at-crossing logic), moat = offset channel polygon. Emit `wall-tower`,
  `wall-gate`, `wall-moat` + the wall quads. Interaction with city-generated
  walls (the double-wall question from review/008) resolves here: a sketched
  wall WITH a procgen block suppresses the city's own generated wall inside its
  corridor (cascade constraint, plan 023).

## 4. Sequencing (each algorithm = one subagent-sized phase, own gate)
1. Preset pattern + city retrofit (pure UX/registry; no new generator).
2. Spine support + **river** (biggest payoff, Jonah's example; pre-022 version
   ships without elevation coupling).
3. **Forest** (first consumer of masked-noise; can pull plan 022 §2 forward or
   use the interiorT fallback).
4. Park, then wall (mostly reuse).

Each: pure generator + unit gates (determinism, containment-corridor, 2×2 seam
via whole-artifact clip, preset fuzz), live gate (sketch → generate → edit
params → regen; screenshots), zod at every boundary.

## 5. Open questions
1. Does a plain sketched river (no procgen block) ever auto-upgrade? No —
   plan 020 rule stands: modal on finish, cancel = inert; "Generate river…"
   available later from the panel.
2. `forest` kind default render before generation (inert forests need a paint) —
   theme decision, flag to Jonah with the first screenshots.
3. Emitted feature schema versioning per algorithm (`version` in the procgen
   block already covers params; output shape changes just regenerate — cache is
   disposable by design).
