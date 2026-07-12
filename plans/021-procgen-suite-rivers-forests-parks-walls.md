# Plan 021 — Procgen algorithm suite: rivers, forests, parks, walls (+ the preset pattern)

**Status:** research/design, approved direction from Jonah 2026-07-12 ("procgen
rivers, walls, forests, parks, etc. all of those should let the person change
the default behavior — e.g. make a river very windy/split, forests of different
types — i like the dropdown when creating a city here, similar templates are
good throughout"). Builds on plan 020's registry; consumes plan 022 fields
where noted; regen interactions are plan 023's contract.

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
sketched **district** polygon carrying a `procgen` block
(`{algorithm, seed, version, params}`) IS the request for city generation:
`src/gen/procgen/registry.ts` maps sketch-kind → algorithm; `src/gen/region.ts`
is the polygon geometry core; `src/gen/citynet/` computes a whole city network
per region which tiles then CLIP — that is the seam story (adjacent tiles agree
because they cut the same bytes), and every algorithm in this plan inherits it.
The seed is persisted at creation and survives vertex edits (the identity
property: edits ADAPT output, only explicit re-roll REPLACES it). MapView owns
the lifecycle (sketch-finish → RegionProcgenModal → generate whole artifact;
edit → debounced regen; `sketch-procgen-set/clear`/`sketch-edit` log types with
undo).

**Why things are the way they are (don't re-derive, don't violate):**
- *Explicit-only generation*: pan/zoom never generates (`generatorRunCount`
  stays flat in every gate). Sketching/confirming IS the request; the modal's
  cancel path leaves an inert shape — a sketch must never silently run a
  generator the GM didn't confirm.
- *Determinism is sacred*: same durable inputs → byte-identical output,
  forever. Deleting `.mapcache/` must be harmless; if a byte-diff appears on
  replay, that's a release blocker, not a flaky test. This is WHY presets are
  sugar over params (§1), WHY seeds are persisted rather than derived at run
  time, WHY feature ids hash on position/path and never on emission order, and
  WHY loops use budgets, not convergence.
- *Generators are pure headless* `src/gen/` functions — no DOM/map/Obsidian
  imports; they read only their arguments. Zod at every IO boundary (bad data →
  warning badge, never a silent drop, never a crash).
- *Generators emit typed features only; themes own ALL paint.* Put `type`/
  preset properties on features; never styling.
- *The GM's hand always wins*: generated output stays strictly within the
  sketched shape (or spine corridor); sketch/location geometry is never
  overwritten by a generator.
- *Cartographic discipline is the plugin's job, not the GM's*: sensible
  defaults per preset; never push styling decisions onto the GM. The
  acceptance bar is docs/04's screenshot test (genre identifiable in 3 s, no
  collisions/seams/voids).

**Infra pitfalls that cost previous agents real hours (all still live):**
- Obsidian CLI loop: `plugin:reload id=campaign-map`, NEVER `plugin:enable`
  (a no-op when already enabled — you will test stale code). Async evals park
  results on `window` globals and poll. Front the window before
  `dev:screenshot` (macOS) and actually LOOK at the screenshot. `dev:errors`
  must be clean. Run from `dev-vault/`, never a real vault.
- Long Obsidian sessions degrade the renderer (`isStyleLoaded` false
  everywhere, render checks time out): only a full process quit+relaunch
  clears it. Run final gate boards one-gate-per-fresh-process.
- Modals hang CLI automation — every GM flow needs a headless test-API twin on
  `app.plugins.plugins['campaign-map']` (precedents: `createRegionForTest`,
  `moveVertex`, `setRegionParams`) that runs the FULL commit path (validation,
  log, persist, regen), not a shortcut.
- Fictional campaigns sit at overview zoom ~z4.5 — never bake absolute zoom
  thresholds (z14 is unreachable). Jonah's standing ruling: zoom LOD affects
  location-name visibility ONLY; generated/sketched fabric always renders.
- `dev-vault/Campaigns/Vespergate` holds Jonah's REAL campaign data (migrated
  district `fabric-mri7r4bj-ll0bd5`, 5 hand-sketched districts). Gates use
  name-tagged fixtures and self-clean; his files must be byte-intact after
  every run (`git diff` on them = empty or frontmatter-formatting-only).
- Cache appends serialize through a per-file promise chain in
  `src/model/tileCache.ts` (a fixed write race) — never bypass
  `appendCachedTile`.

**Protocol:** work the numbered phases of §4, one gate per phase (unit + live),
update PROGRESS.md, log every judgment call/deviation in DECISIONS.md, commit
per green gate with the `[gate: …]` message convention. §5's open questions
need a ruling — if you can't get one, decide, log the decision AND rationale in
DECISIONS.md, and flag it prominently in your report; never guess silently.

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
