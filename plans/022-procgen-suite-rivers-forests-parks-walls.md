# Plan 022 — Procgen algorithm suite: rivers, forests, parks, walls (+ the preset pattern)

**Status:** research/design, approved direction from Jonah 2026-07-12 ("procgen
rivers, walls, forests, parks, etc. all of those should let the person change
the default behavior — e.g. make a river very windy/split, forests of different
types — i like the dropdown when creating a city here, similar templates are
good throughout"). Builds on plan 020's registry; consumes plan 023 fields
where noted; regen interactions are plan 024's contract. **Plan 021 (fast
testing) executes BEFORE this plan** — build your per-algorithm lifecycle
tests headless-first against its MapController/FakeHost harness and reserve
live gates for paint/interaction/screenshots; use its tier protocol (T0–T3)
rather than running full boards per phase.

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
per green gate with the `[gate: …]` message convention. **Board cadence
(Jonah 2026-07-13): a phase commits on T1 — fast suite + tsc + build + the
phase's OWN live gate standalone (+ fuzz iff generator behavior changed); the
full board runs ONCE for this plan, at 22-F. Never run `board`/`board
--changed` per phase.** §5's open questions
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
- **Additive-params rule (adversarial review 2026-07-12):** adding a new param
  to an algorithm's schema MUST default to the prior behavior — a plugin
  update must never visibly re-roll a GM's existing regions (the identity
  property applies across versions, not just across edits). If prior behavior
  cannot be expressed as a default, bump the procgen block's `version` and
  keep the old code path for old versions.

## 2. Line-kind procgen (extends plan 020, which was polygon-only)

Rivers and walls are sketched as LINES; the sketch is the *spine*, procgen
elaborates it. Registry `appliesTo` already keys on FabricKind — the host
lifecycle (finish-sketch → modal, edit → regen, select → panel) generalizes:
`makeSpine(id, line)` (mm-quantized polyline + arc-length index) alongside
`makeRegion`. Generated output belongs to the spine feature exactly like region
output (cache keys `region:<featureId>:…` unchanged — the id is the contract,
not the geometry type). Output containment rule becomes a corridor: all output
within `maxOffset` of the spine (gate-asserted per algorithm). **`maxOffset` is
a pure function of the params** (for a river: f(windiness amplitude, width,
braiding lens width)) — computed by the algorithm, exposed to the host, and
reused as the feature's cascade influence margin (plan 024 `inputBBox`/
`outputBBox`); a windiness increase must widen the corridor, not violate the
containment gate. RegionProcgenModal already generalizes (it is param-schema
driven); line kinds reuse it unchanged.

## 3. The algorithms

### 3.1 River (`river` line kind) — the marquee params Jonah named
- **Params:** `windiness` (meander amplitude+frequency, 0=faithful to sketch),
  `braiding` (0–1 split/rejoin probability), `width` (base m), `widthGrowth`
  (downstream widening), preset dropdown: `lazy-lowland` (wide, windy, braided),
  `mountain-torrent` (narrow, straight, rocky), `canal` (dead straight, uniform),
  `delta` (heavy braiding near the end).
- **Generation:** deterministic meander = seeded harmonic offsets displacing
  the sketched spine. **Phase keying is POSITION-derived per segment, not
  arc-length-derived (adversarial review 2026-07-12):** naive arc-length
  parameterization breaks the identity property — moving ONE vertex near the
  source shifts the arc-length of every downstream point and re-meanders the
  whole river, making an edit indistinguishable from a re-roll. Instead each
  spine segment's meander phase hashes on the segment's quantized endpoint
  positions (`spatialHash.ts` pattern), with C1 blending at segment joins — so
  a vertex edit re-meanders only the adjacent segments (measure this in the
  gate: id/coordinate-bucket overlap away from the edit must be ≫ overlap
  under re-roll, the plan-020 §gate-b lesson). Meander amplitude is clamped by
  local spine curvature (offset > curvature radius self-intersects); resample
  the spine at a fixed step BEFORE offsetting, mm-quantized. Braids = seeded
  intervals splitting into 2 channels offset by a lens shape, rejoining
  (islands emerge as the lens interior). Emit `river-channel` polygons
  (+ `river-island`), banks as the channel SDF's zero set. When plan 023
  lands: meander amplitude modulated by local slope (flat → windy, steep →
  straight) and flow direction sanity-checked downhill.
- **Tributaries:** river spines MAY cross/touch (same-stage, so neither sees
  the other's output — plan 024): channels simply union where they overlap.
  Junction hydrology (width growth after a confluence, smooth bank merge) is
  explicitly out of scope v1 — log it as a known limitation; do not reject
  crossing spines like polygons reject overlap.
- **Constraint face:** the GENERATED channel polygons (not the sketched spine)
  become the water constraint downstream — that is plan 024's cascade; until
  then the spine keeps feeding constraints as today (RIVER_HALF_WIDTH).

### 3.2 Forest (new `forest` polygon kind)
- New FabricKind (additive zod change; sketch sub-bar gains the kind button).
- **Params:** preset `broadleaf` / `conifer` / `mixed` / `swamp` / `dead-wood`;
  `density` (0–1); `clearings` (0–1); `edgeRaggedness`.
- **Generation:** canopy = region SDF mask × masked noise (plan 023 primitives;
  pre-023 fallback: interiorT + existing valueNoise2D). Emit `forest-canopy`
  polygons (marching squares on the masked density field, same seam discipline
  as contours), `forest-clearing` holes, and sparse `forest-tree` point symbols
  near the boundary at high zoom (position-hashed jitter grid = deterministic
  Poisson-ish). Themes own paint per preset type property.
- Cities and forests overlap legitimately (a town in the woods). **One
  dependency direction only (adversarial review 2026-07-12 — the earlier
  draft contradicted plan 024 here):** forest is stage 2, city is stage 3, so
  the CITY sees vegetation (growth cost bump, sparser outskirts under canopy)
  and the forest NEVER sees the city — canopy is not clipped by footprints.
  Visually the town reads as a clearing anyway because city fabric paints
  above canopy within layer 1 (theme layer order: canopy below streets/
  footprints). A true generated clearing would need a reverse (stage-3→2)
  dependency, which is REJECTED — it breaks the cascade's cycle-freedom; if
  Jonah wants it later it needs its own plan and a new mechanism.

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
  other presets plus `park-rock` (Point) and reuses the island/bridge
  emitters from §3.1 at pond scale (extract them to a shared module rather
  than importing the river generator). Pre-023 pond fallback: a seeded
  harmonic-radius blob (same closed-form trick as the meander) instead of
  smooth-min SDFs — themes decide the aesthetic per preset
  property (ink-soot should render these beautifully). Good preset-fuzz target:
  small regions must degrade gracefully (drop court → drop island → pond only).

### 3.4 Wall (`wall` line kind)
- **Params:** preset `curtain-wall` (stone, towers), `palisade` (wood, no
  towers), `bastioned` (angular trace, star-fort-ish); `towerSpacing`,
  `moat` (bool), `gatehouseScale`.
- **Generation:** towers at deterministic intervals along the spine —
  position-keyed per segment (same identity-preserving keying as the river
  meander, §3.1), NOT global arc-length — gates where roads cross the spine
  (reusing the plan-020 gate-at-crossing logic), moat = offset channel
  polygon. Emit `wall-tower`, `wall-gate`, `wall-moat` + the wall quads.
- **Double-wall resolution (corrected in adversarial review 2026-07-12):** the
  earlier draft routed this through the cascade, but wall elaboration is
  stage 4 — AFTER the city — so its output cannot legally constrain city
  generation. The suppression signal is the RAW SKETCH, which every stage may
  read: a wall-kind sketch feature (procgen block or not) near the city
  region's rim sets the city profile's own `wall` off within that corridor.
  The stage-4 elaboration then decorates the GM's wall with towers/gates that
  align to the stage-3 streets. Two mechanisms, one line on the map.

### 3.5 Farmland (new `farmland` polygon kind — Jonah 2026-07-12)
- New FabricKind (additive zod change, sketch sub-bar button, theme paint per
  the new-feature-type checklist below).
- **Params:** preset `open-field-strips` (medieval long strips radiating off
  lanes — pairs with euro-medieval cities), `enclosed-patchwork` (irregular
  hedged fields, rolling-countryside look), `grid-quarters` (rectilinear
  sections + straight section roads — pairs with na-grid), `orchard` (regular
  tree rows), `paddy-terraces` (contour-following banks — the field-coupled
  variant: needs plan 023 elevation; pre-023 fallback: concentric interiorT
  bands); `fieldSize`, `hedging` (none/fences/hedgerows), `laneDensity`,
  `farmsteads` (0–1).
- **Generation:** heavy reuse — field subdivision is the parcels.ts OBB/strip
  splitter at field scale, keyed per preset (strips = one long axis; patchwork
  = irregular recursive splits; quarters = axis-aligned grid); sparse lane web
  (growth loop, very low branchProb) with farmstead footprint clusters at
  deterministic lane junctions (position-hashed); hedges/fences as field-edge
  lines. Emit `farm-field` polygons (crop-variety property for theme texture),
  `farm-lane` lines, `farm-hedge` lines, `farm-building` footprints,
  `orchard-tree` points. Stage 2 (vegetation/agriculture) in plan 024 — the
  city sees farmland (growth cost bump: streets skirt fields rather than
  bulldoze them); farmland never sees the city.
- **Overlap with city outskirts:** the city already grows its own outskirt
  fields (v3.3) — double-painting where a farmland sketch touches a city rim
  would look broken. Same mechanism as the wall (§3.4): the city reads the RAW
  farmland sketch and suppresses its own outskirt fields inside it — the GM's
  farmland claims that ground.

## 4. Sequencing (each algorithm = one subagent-sized phase, own gate)
1. Preset pattern + city retrofit (pure UX/registry; no new generator).
2. Spine support + **river** (biggest payoff, Jonah's example; pre-023 version
   ships without elevation coupling).
3. **Forest** (first consumer of masked-noise; can pull plan 023 §2 forward or
   use the interiorT fallback).
4. Park, then wall, then farmland (all mostly reuse; farmland's
   `paddy-terraces` preset alone waits on plan 023).

Each: pure generator + unit gates (determinism, containment-corridor, 2×2 seam
via whole-artifact clip, preset fuzz), live gate (sketch → generate → edit
params → regen; screenshots), zod at every boundary. Per-phase verification =
T1 only (fast suite + tsc + build + the phase's own live gate standalone);
the plan's ONE full board runs at the end of phase 6 (farmland, 22-F).

**New-feature-type checklist (easy to forget, invisible when missed):** every
new emitted feature `type` needs paint in ALL themes (the obsidian-native
runtime builder AND the four handcrafted genre themes) — a missing entry means
invisible output that passes every non-visual gate. New layer ids must start
with `generated-` (or another prefix `layerOrder.ts#layerGroupOf` already
claims) or every style build throws. New fabric KINDS (forest) additionally
need fabric-layer paint + a sketch sub-bar button + a legend/panel label.

## 5. Open questions
1. Does a plain sketched river (no procgen block) ever auto-upgrade? No —
   plan 020 rule stands: modal on finish, cancel = inert; "Generate river…"
   available later from the panel.
2. `forest` kind default render before generation (inert forests need a paint) —
   theme decision, flag to Jonah with the first screenshots.
3. Emitted feature schema versioning per algorithm (`version` in the procgen
   block already covers params; output shape changes just regenerate — cache is
   disposable by design).
