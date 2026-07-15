# OVERNIGHT RUN — pipeline arc 031→039 (2026-07-14 → 2026-07-15)

## AFTERNOON SESSION (2026-07-15): rendering fixes + land-shaping UX + perf — ALL PUSHED
- **Ghost-fabric fixes**: `4705e84` (delete/unpaint used static stage vs params-aware paint stage
  — urban-park survived deletion; preview path had the same hole) + `0579d4c` (stage MIGRATION on
  variety flip 2↔4 now repaints BOTH stages; failing-first proven both directions).
- **Perf (Jonah's "slow 3D / slow with no generation")**: measured — river carve = 79% of each
  961 ms DEM tile; and dem.jsonl was re-parsed WHOLE per tile request (91 ms → 2+ s as it grows —
  the smoking gun). Fixed the latter (`d1ddd15`: session-persistent view + compact-on-load, 20
  requests = 1 read). Disproven: field-rebuild-per-job (1%), payload clone (0.1 ms).
  **Ranked follow-ups needing Jonah's call**: (1) DEM_TILE_RES 256→128 = 3.8×/tile, crispness
  tradeoff, one line; (2) carve far-field tightening (the 79%) — determinism-bearing, needs
  byte-proof; (3) worker: DEM tiles ahead of contour leaves / small pool; (4) center-first tiles.
- **Plan 040 land-shaping UX**: `67a0450` click-out — REAL cause was the draw tool discarding
  finishable drafts on implicit exits (tool/kind switch, ✕); they now COMMIT (Esc = the one
  deliberate discard). Select-tool click-out was proven safe all along. `7fe6063` drag-to-extrude:
  grip + ghost stem on selected relief/landform, vertical drag = height/target live with ±m
  readout, Shift = fine, one commit on release through setRegionParams (undo/cascade free).
  Phases 2–3 (band ghost viz, type-during-drag) TODO in the plan; pitched-3D drag + live terrain
  preview deferred with rationale. **Feel calls for Jonah (plan §4)**: 12/3 m-per-px sensitivities,
  polarity flip at zero (ridge↔valley via one drag — confirm), readout format, grip glyph,
  auto-commit-on-kind-switch.
- Suite 1284/1284; reload the plugin to pick all of this up in your running app.

Autonomous run per Jonah's goal: implement plans 031–039, parallelize with opus subagents,
build a new overlap-focused test map, commit+push continuously. Everything needing Jonah's
eyes lands HERE. Newest items at the top of each section.

## ✅ RUN COMPLETE (2026-07-15 ~09:00)
All nine plans landed and pushed. Suite 895 → **1121/1121 fast + 38/38 fuzz**; tsc + build
clean; every plan independently re-verified before push. Final algorithm versions:
city 3 · river 3 · farmland 4 · forest 4 · park 5 · wall 3 · mountain 1. Deferred follow-ups
(each with rationale below): 036-C live paint-wiring + 36-D Apply UI, 038.5 frontage lots,
038.3 junction-angle nudge, 038.4 pond-at-low-point + contour-oriented strips,
variable-support stamp invalidation, 037 towers-outboard. Read NEEDS JONAH'S EYES top-down —
the top items are the ones that change what you'd do next.

## Ground rules in force
- **NO live Obsidian gates** (Jonah 2026-07-14) — all verification headless (Vitest, FakeHost
  counters, goldens, metric bands, fuzz); visual judgment via playground contact sheets.
- Commits per green phase on fast suite + tsc + build (+fuzz when generator behavior changed);
  explicit-path staging only (shared checkout — a parallel session has
  `review/v29-needs-adoption-panel.png` modified; untouched by this run).
- Vespergate untouched; the new test map is its own campaign (`dev-vault/Campaigns/Overlap`).

## Scope interpretations (flag if wrong)
1. **Plan 039**: the plan file says FUTURE ("do not schedule without a fresh ruling"), but the
   goal explicitly says "031 through 039" — I'm treating the goal as the fresh ruling and
   shipping **§1.1 only** (market-pin → plaza snap), per the plan's own "ship §1.1 first and
   alone". Temple/gate variants stay deferred.

## ✅ GLOBAL-TERRAIN RULING + FULL SHORTLIST: DONE (2026-07-15 afternoon)
Ruling implemented (`bfb7a41` gen half, `c41743f`/`2e2bf2f` host half), full shortlist landed
(paint: `ee04401` hillshade mask, `5dacd08` wall mass, `38bd0e6` sea water, `00db9f1` road
smoothing, `e8777b8` labels, `28ef9de` exaggeration 3; generators: `089460a` relief apron,
`94807b3` lane fan, `3ef19d7` faubourg — farmland v5, mountain v2), Vailmarch terrain-native
(`ce2b250`: NO mountain polygons, base campAmp 220 on, endpoint-keyed organic rings).
Final verify: suite 1253/1253 + fuzz 40/40; in-app fresh pass clean (31/31 regions, 0 errors,
renderer responsive — DEM/contours now worker-side). Verification screenshots:
`review/vailmarch-final-{overview,capital,spine3d}.png`.
**Remaining threads for a future session:** wall glacis apron needs outboard geometry
(paint agent's needs-geometry note); label water-avoidance + named-region overview labels;
mountain-stamp apron (frozen mountainField internals — relief-only for now); grown-town-edge
carries the wall (longer-term, your item-4 note); sea-rim moiré at the 3D mesh edge (minor);
hillshade+terrain shared-source maplibre warning (cosmetic).

## NEEDS JONAH'S EYES
- **VAILMARCH 3D INSPECTION — the make-it-look-real shortlist** (screenshots in
  `review/vailmarch-{overview,capital,spine-3d,dem-raster-debug}.png`; ranked by visual payoff):
  1. **Base terrain on by default for terrain-native campaigns** — the space between regions is
     dead parchment; even low-amp base fBm + hillshade would knit the world together. Gated on
     DEM per-tile cost (see engineering notes) and the Apply UI (landed, needs your wording pass).
  2. **Foothill aprons on mountain/relief stamps** — in 3D the massif rises as a vertical-walled
     mesa off flat ground (compact-support mask edge × exaggeration 6). Add a skirt falloff
     (apron ≈ 2–3× the current mask band) so peaks rise out of foothills. Consider dialling
     `TERRAIN_EXAGGERATION` 6 → 3–4.
  3. **Hillshade under settlements** — the valley-relief band smears a dark stain diagonally
     across the capital's street fabric. Options: mask hillshade under city fill, revisit Q3
     (city grading default OFF → ON), or narrower valley stamps near towns.
  4. **Walls need mass** — today a thin line + square tower studs (reads as a dashed rectangle).
     Wall band with casing/glacis tint, legible gatehouses, VISIBLE moat ribbon, a water-gate
     glyph where the river pierces the wall (the data is all there since 037/038 — it's paint).
  5. **Organic boundaries** — everything reads as postage stamps because the demo's rings are
     axis-aligned rectangles AND the city fills its claim to the boundary. Re-emit Vailmarch with
     irregular rings; longer-term: let the town's grown edge, not the sketch ring, carry the wall.
  6. **Seas need water paint** — the `landform sea` shapes the DEM only; the coast reads as blank
     parchment. Give sea-mode landforms a water fill in themes (+ estuary/delta at the mouth).
  7. **Sketched roads outside cities are dead-straight faint strokes** — smooth (Catmull-Rom at
     paint), stronger track styling; inside-city promotion already works.
  8. **Farmland gate-lane fan** — lanes radiate as literal spokes; clip at the first field
     boundary / jitter angles so they read as lanes, not rays.
  9. **Peri-urban transition band** — a faubourg/orchard strip where the belt meets the wall
     would sell the gradient the 035 read already computes.
  10. **Label pass** — region names at overview (forests/farms), market label sits on water.
- **3D/DEM engineering notes from the live session (2026-07-15 morning):**
  - The far-field stall hit TWICE: the carve got the byte-exact reject in `f215840`, but relief
    + landform paid the same O(dist²) spiral — one DEM tile took >2 min on the main thread and
    3D rendered flat (tiles never resolved). Fixed byte-exact in `7fa7ea4` (+ standing
    zero-segment-tests budget test). DEM tiles now ~0.3–2 s each — still MAIN-THREAD; the real
    fix is the 036-C worker-side DEM leaf. Repeated heavy tile loads degraded the Electron
    renderer to the point of needing an app restart — same root cause, same fix.
  - `queryTerrainElevation` returning 0 is a red herring while terrain tiles stream — the
    raster-overlay debug trick (add the `campaigndem://` tiles as a plain raster layer) is the
    reliable way to see what the DEM actually serves; kept as
    `review/vailmarch-dem-raster-debug.png`.
  - The 09:21 `urban-park` zod errors in your session were the STALE pre-arc bundle (worker
    enum predated 035); the current bundle validates fine — no source bug.
  - Minor: each `open-map` command opens a NEW leaf (ghost "Campaign map" tabs accumulate);
    dedupe-or-focus would be nicer.
  - Cost-cap UX worked as designed on first Vailmarch open: 14 regions generated, 17 deferred
    with badges; "Apply pending cascade" generated the rest (runs 14→31, outdated→0, 0 errors).
- **Vailmarch (the demo ask) — two composition findings:**
  1. **Relief/landform stamps are generator-INERT**: forest/farmland/river read terrain via
     `macroTerrainField` = mountains + base only (the variable-support-margin gap, by design
     per the 036 deferral). The plateau/basin/sea/ridge stamps shape the VISIBLE surface
     (DEM/hillshade/3D, carve) but no region generator reacts to them — the demo's
     timberline/paddy/pasture reads sit over mountain polygons instead. Confirm this matches
     intent; the fix is the variable-support invalidation design.
  2. **Base fBm terrain doesn't reach generators either** (`macroTerrainField` is called with
     no base) — and `campAmp`/`seaDatum` had no persisted home until the DEM wiring added an
     optional default-inert `terrain` config block. The demo ships with base amp 0 + strong
     stamps; `VAILMARCH_BASE` in the builder documents what it would use.
- **DEM/3D perf note**: the DEM wiring caught a real blow-up — river-carve `nearest()` was
  O(dist²) in the far field ⇒ >120 s per 256² DEM tile with 4 rivers; a provably byte-exact
  far-field reject brings it to ~300 ms/tile (locked by a carve-on/off byte-identity test).
  Residual ~300 ms is 5-octave base fBm when campAmp>0 (one-time per tile, dev machine) — if
  too slow on the Surface Pro, the fix is the 036-C worker-side memoized DEM leaf.
- **Stray Overlap fabric reorder reverted**: something load-and-resaved
  `Overlap/Fabric.geojson` during the morning session (pure feature reorder, bytes equal) —
  writer unknown (neither agent claims it); reverted to the emitter's canonical bytes. If it
  recurs, the host fabric writer may not preserve feature order — worth a look.
- **038 sub-item deferrals (design questions, not failures):**
  1. *038.5 frontage/ribbon lots along promoted roads* — implemented then REVERTED: on a dense
     euro-medieval fill the perpendicular frontage seeds get outcompeted in the global growth
     queue (measured lots 265→226 = pure noise, no defensible metric band). Needs either a
     growth-budget carve-out for road frontage or re-emit-as-arterial + bounded ribbons (with
     a paint call on the sketch/procgen double-draw). Forced gates at road×ring crossings DID
     land.
  2. *038.3 junction-angle nudge (45–75°)* — would deform the centerline near the mouth,
     risking corridor-containment + bank-weld invariants; both width rules landed.
  3. *038.4 park pond-at-low-point* — the pond is radially entangled with the interiorPole
     composition (~8 coupled sites); relocating it independently risks containment.
  4. *038.4 farmland contour-ORIENTED strips* — conflicts with farmland's world-aligned
     edit-locality invariant; slope-gated pasture tag landed instead.
- **Parallel-commit hygiene note**: commit `db8d5b4` (city agent) inadvertently included the
  generator agent's wall registry hunk (wall v2→v3) — the pathspec form commits working-tree
  state, and the other agent's uncommitted edit was in the file. Zero work lost, attribution
  only; `git show db8d5b4 -- src/gen/procgen/registry.ts` if you care. Also one reconcile
  commit (`f12ec53`) was mine: the adoption-lifecycle tests hardcoded pre-038 versions —
  now drift-proofed (adopt target reads the registry; k-chain overrides at 9).
- **Eyeball pass, one sitting (playground + Overlap campaign)**: 038 waterfront street
  alignment, rang long-lots + water-meadows, tributary width steps, timberline/conifer bias,
  hedgerow shared boundaries, wall water-gates + moat leats; 039 market-pin plaza snap
  (Coppersquare Market pin in the Overlap campaign is the fixture); plus the 035 items below.
- **037 margin churn (real design question)**: city's consumesSketch now includes park/district
  (for nested holes) at the city's 1500 m margin — so ANY park/district edit within 1500 m of a
  city regenerates it (byte-identically when not contained; slow-but-correct). Adjacent
  districts regenerate each other. If this churns too much in play, the fix is a per-KIND
  margin (park/district could be containment-only ≈ 0 m), a small follow-up.
- **037 towers-outboard deferred**: offsetting tower centers outboard risks exceeding the
  params-only wallMaxOffset corridor; gates/bearings/gatehouse-axis/moat-side/water-gaps all
  landed. Add later behind a widened corridor if wanted.
- **036 follow-ups (deliberate deferrals — live/host-side, unverifiable headlessly this arc):**
  1. Finish 36-C: retire the baked `mountain-contour` (mountain version bump + re-golden) and
     wire `TerrainContourLeaves` into the live worker/paint path — needs a session that can
     eyeball paint. The lazy-leaf ENGINE is landed and tested; the map still paints the old
     baked contours meanwhile (no visual regression).
  2. 36-D host plumbing: map-settings base-params (campAmp/seaDatum) Apply UI + cost notice +
     headless test-API twin. The grading/base engine is landed, default-inert.
  3. Variable-support stamp invalidation: relief stamps reach up to their param halfWidth
     (~20 km), which the fixed per-algorithm influenceMargin model can't express — needed
     before relief/landform can couple INTO river/farmland. Design decision for a future plan.
  4. Two-oceans problem (sketched `landform sea` vs frozen world-tier ocean paint) noted and
     left out of scope per plan.
- **Playground eyeball (035)**: farmland gate-lanes radiating from generated arterials +
  field-size gradient toward the wall; urban-park street-aligned entrances.
- **River v2 fingerprint side effect (035)**: a v1-pinned river whose fingerprint folded a
  mountain upstream now mismatches ⇒ needs-adoption badge (renders nothing) instead of
  stale-serving. Sanctioned per 029 §5 but VISIBLE: mountain-adjacent v1 rivers go badge-blank
  after this update until adopted.
- **Overlap campaign is now a pinned-old adoption surface** (pins river v1/park v2/farmland v1
  from before tonight's bumps) — deliberately not re-emitted; exercise the adoption UX on it.
- **Overlap campaign eyeball pass**: open `dev-vault/Campaigns/Overlap` in Obsidian (or view in
  the playground) and judge the generated result on the 8 overlap scenarios. Regenerate the
  campaign any time with `npx tsx scripts/emit-overlap-campaign.ts` — never hand-edit.
- **Wall-on-ring design call** (Overlap S2): the test wall traces the district ring exactly
  (offset 0) because any outward offset would cut the adjacent district / farmland shared edges;
  along the shared south edge the wall coincides with Newquarter's north boundary (old-wall/
  faubourg reading). Flag if plan-037 gate work wants a cleaner separation fixture instead.

## Landed
- **GUI-control audit + fixes** (`dfa635b`, `c7eb41f`): the audit found the BIG gap — NO
  per-param controls existed anywhere (creation modal + selection panel rendered only a preset
  dropdown; every zod param of all 9 algorithms was GUI-unreachable). Now schema-driven
  (`paramControls.ts` introspects the zod schemas; both UIs render from it) with a standing
  CONTRACT TEST (schema keys ⊆ rendered controls — a param without GUI is a failing test
  forever). Plus: base-terrain (campAmp/seaDatum/grade) section in the campaign modal behind
  explicit Apply + cost notice w/ headless twin; "Toggle terrain relief" command; `market` pin
  type in QuickAdd (the 039 loop was frontmatter-only before). NOT-A-GAP rulings documented
  (redo, scale editing, post-creation pin type = note frontmatter). 1157→1193 tests.
- **Terrain far-field reject round 2** (`7fa7ea4`): relief/landform stamps stalled DEM fills
  exactly like the carve had — byte-exact bbox reject + `SegmentHash.totalSegmentTests` budget
  test. Found live when Vailmarch 3D rendered flat. 1193→1194 tests.
- **Vailmarch showcase campaign** (`3ee2d7c`): terrain-native demo, ~8×6 km — north relief
  spine w/ two massifs, east plateau, south basin, west sea, one four-river system (gorge
  carve, two Strahler confluences, mountain-torrent opt-in), walled capital straddling the
  Vail (water-gate, market plaza snap, nested green, forced road gates), ε=0 twin districts,
  coastal town, 5 farmland + 5 forests covering every coupling, 11 pinned locations. 34
  regions, all GENERATION-PROVEN headlessly: 30 premise+proof tests assert the actual coupling
  signatures (waterGates, bankLot/waterMeadow, standConifer+timberline, plaza-at-pin ≤60 m,
  bit-equal twin gates, gorge ~40 m below banks, park hole+frontage, lanes→gates). Regenerate:
  `npx tsx scripts/emit-vailmarch-campaign.ts`. 1121→1156 tests.
- **DEM/3D wired to composed terrain** (`f215840` — 036 follow-up item 1, DEM half): the
  in-app hillshade/3D now evaluates full `terrainAt` (base + mountains verbatim + relief +
  landform + river carve + optional grading), bit-exact vs the old mountain union incl.
  signed zeros (Object.is lattice test), digest `t2|…` over every durable terrain input
  (id-sorted, enumeration-proof, old tiles re-derive). Campaign config gains an optional
  default-inert `terrain` block (campAmp/seaDatum/grade — the 036-D persistence half).
  Contour re-home + Apply UI still deferred. 1156→1157 tests.
- **Plans 038 + 039 §1.1 COMPLETE** (two parallel file-disjoint clusters + one reconcile):
  city cluster `db8d5b4` (039 market-pin plaza snap — precedence params.center > market pin >
  computed, untyped pins byte-identical), `93c6850` (waterfront: bank-tangent streets 0.85
  alignment vs 0.57 far, building setback, quays hug the bank), `b08668c` (adjacent districts:
  ε-edge stubs/gates hashed symmetrically, bit-exact from both sides at different
  seeds/profiles), `14f8503` (road×ring forced gates; frontage deferred). Generator cluster
  `390522d` (wall water-gates + moat leat + canal payload fed without touching citynet),
  `9951351` (rang long-lots ⊥ bank + waterMeadow tag), `286642d` (Strahler-ish width:
  step-up >1.3× below junctions, mouth clamp, monotone), `65e58b7` (timberline + conifer
  upslope + contour-sag; farmland pasture slope-gating), `307c8e9` (forest↔farmland/park
  hedgerow — both sides derive the identical seam line). Reconcile `f12ec53`. One cumulative
  bump per algorithm; ALL no-upstream/flat-terrain byte-identity proofs green; goldens
  unchanged (bumps = adoption gates). 1075→1121 tests.
- **Plan 037 COMPLETE** (`ca75994`, `8e98a42`, `59a13dd`, `0d4c17c`): river→forest/park/farmland
  channel exclusion + riparian ramp (monotone metric band), vegetation→city growth cost (canopy
  attenuation + dense-canopy parcel rejection — canopy never clipped), settlement payload→wall
  (gates at generated arterial crossings w/ class-ranked min-spacing merge, gatehouse on the
  crossing axis, moat side away from interior, water gaps incl. river-is-the-moat),
  nested-region hole-with-frontage (park-in-city + district-in-district, hashed entrances,
  outskirts suppression preserved). Bumps: forest v2, park v4, farmland v3, city v2, wall v2 —
  ALL goldens byte-identical (bumps are adoption gates; no-upstream identity paths proven per
  consumer). Also FIXED a latent under-invalidation: contained park/district rings weren't
  hashed into the city fingerprint (added as an appended-only-when-present bucket — park-free
  cities see zero fp churn). 1050→1075 tests. Canal-as-moat deferred to 038 item 8.
- **Plan 036 COMPLETE (engine)** (`0a5afa4`, `77b41ca`, `7f69968`, `e32b8a8`, `d26c3f1`):
  `terrainAt(x,y)` = grade(carve(replace(add(B)))), base default-flat ⇒ every campaign
  byte-stable until opted in. **Mountain migration BIT-EXACT to the float incl. signed zeros**
  (the add-term IS elevationFieldFromFabric; verbatim fast path avoids the (+0)+(−0) trap) —
  no existing mountain re-rolls, STOP condition never approached. Two new sketch kinds
  (`relief` line add-stamp, `landform` polygon replace-stamp w/ Q4 priority), threaded through
  zod/registry/harness/themes with zero new theme tokens; river carve via smin + segment
  spatial hash (<120 segment tests/sample on a 2000-segment spine — hard constant); chunked
  Float32Array lattices + LRU with laziness/eviction counters; 2×2 contour seams green;
  grading default-off; consumers (river opt-in slope, farmland paddy) reconnected to terrainAt
  bit-exactly. 1004→1050 tests, fuzz 38/38. Live paint wiring + Apply UI deferred (see eyes).
- **Plan 035 COMPLETE** (`ed259c1`, `00d2c71`, `a3fb09b`): stage order is now −1 sources ·
  0 hydrology · 1 terrain · 2 vegetation · 3 settlement · 4 peri-urban · 5 detail; river v2
  (slopeSensitivity default 0 — Jonah's litmus holds: mountain edit ⇒ zero river runs, zero
  river bytes; only `mountain-torrent` opts in); park split by variety via new registry
  `dagRole(params)` (urban-park at stage 4 consumes settlement, produces NOTHING — cycle-guard
  contract test standing in registry.test.ts); farmland peri-urban with the settlement read
  WIRED (gate lanes from arterial ring-projections ≤45 m, field-size gradient within 240 m of
  city fabric, zero new rng). Version bumps: river v2, park v3, farmland v2 — all three goldens
  byte-identical (fixtures uncoupled = the no-upstream proof). 974→1004 tests. Judgment calls:
  farmland keeps `elevation` alongside `settlement` (S7 litmus needs terrain→farmland); river
  keeps `mountain` in consumesSketch (declarations are per-algorithm; harness probes
  most-consuming params — opted-in rivers genuinely read it).
- **Plan 034 COMPLETE — the keystone** (`4a1d932`, `2239983`, `d8f0829`, `41e125f`, `cba1986`):
  sketches/pins are stage −1 DAG source nodes; ONE `runForwardPass` drives every trigger (flush,
  cascade, adopt, replay, undo) — `regenerateAffectedTiles`, `cascadeDownstream`,
  `cascadeFromRoot`, `forceRegenInStageOrder` all DELETED; runtime guards (stage monotonicity +
  closure bound) throw and are proven to fire via injected violations; cost-weighted cap
  (cheap 1/medium 2/expensive 4, budget 24, bills only fp-stale deferrable work); declined bills
  reopen to an OUTDATED badge with zero generator runs; preview mode (drag = root-only ephemeral,
  release = one pass, kill leaves no trace); adopt-all O(k). 955→974 fast + fuzz green.
  **Jonah's eyes:**
  1. Found + fixed a REAL live-vs-replay divergence: a city reading a procgen wall's raw line
     was left stale live but recomputed on replay — region roots now mint their own −1 source.
  2. Pinned-old + fp-stale on a cost-deferred replay serves pinned bytes WITH the outdated badge
     (visible-not-silent; ordinary pinned-old semantics untouched).
  3. Cap weights/budget (24) and Notice/panel wording are conservative picks — reword freely.
- **Plan 033 COMPLETE** (`790caff`, `58a3622`, `f593564` + 033-A `d9dacc2`): two-lane 32-bit
  hasher (measured 56 → 975 MB/s, 17.3×; FP_VERSION fp1→fp3 self-heals), registry
  `consumesSketch`/`influenceMargin`/`costClass` seeded from the HARNESS table, raw-channel
  invalidation now kind+margin-scoped (P4 fixture: road edit 3 regens → 1; district-add ⇒ zero
  neighbors), scoped fingerprints (P5 load-storm reopen recomputes ZERO out-of-reach regions;
  pinned-old region SURVIVES an unrelated far edit — the old global hash would have
  false-blanked it). 939→955 tests, fuzz harness green off the registry. Judgment calls:
  fp-equality force-skip is opt-in for the flush/cascade walk only (direct GM regenerate always
  recomputes); river/farmland's `mountain` consumption rides the upstream DAG fp path (mountain
  isn't a raw-constraint bucket) — no special-casing.
- **Plan 032 COMPLETE** (`8b2cc5a`, `5b5e4f0`, `6d77f3a`, `ff1f065`): per-region cache shards
  with verbatim-line streaming migration (pinned-old network record proven byte-identical —
  STOP condition never triggered), persistent per-controller cache view (one disk read per
  session, zero re-reads across batches), per-tile clip records eliminated (fixture city:
  55 records → 1; ~721 KB shard = network only — this was the bulk of 170 MB/17 regions),
  staged repaint (river→city flush repaints exactly stages [1,3] via MapLibre updateData diff
  on the single generated source — no theme/style surface change). 924→939 tests. Judgment
  calls: write-THROUGH not write-behind (undo-log hazard structurally impossible); view is
  per-controller (reopen = fresh view — deliberate, keeps pinned-old blanking + mid-session
  .mapcache-delete safety); world tier stays on the direct disk path.
  **Jonah's eyes: the MapView `updateData` staged-repaint path is build/tsc-verified only —
  judge it visually in your next normal app session** (pan around after an edit cascade).
- **Plan 033-A landed early** (`d9dacc2`, parallel with 032): the under-invalidation property
  harness — the shipping gate for everything consumption-keyed. TWO REAL FINDINGS vs the
  report §1 table: (1) **river also consumes mountain** (slope coupling on by default;
  compact-support field ⇒ 30 m margin suffices); (2) **city's influence margin is ~1500 m,
  not 200 m** (the exp(−d/60) road tensor blend has no cutoff — a road at 400 m still steers
  streets by whole degrees; measured byte-inert from ≈1 km). 33-C seeds from THIS table, not
  the report's. Prove-the-net: 4 intentional under-declarations all detected.
- **Plan 031 COMPLETE** (`cebb66f`, `02f0e07`, `5557ba6`, `a42cace`, `c111ec2`): network-once
  under force (P1), batching parity (one fp pass + one shared cache read + ≤1 repaint per batch),
  stage-ordered raw channel (P2/P3 correctness — ordering assertion verified to fail with the
  sort disabled), river/wall regen through the worker (spine across the boundary). 895→924 tests;
  independently re-verified (tsc+suite+build) before push. Judgment calls for Jonah:
  1. **Force semantics moved** from "always recompute network" to "recompute-if-absent" (caller
     clears the cache to force a true recompute) — an existing test's contract was updated.
  2. **Worker zod scope**: only the new `spine` field got a schema (`JobSpineSchema`); the rest of
     the job payload stays plain TS interfaces per pre-existing convention. Extending validation
     to the whole payload would be a follow-up.
  3. **P2 test note**: a water sketch edit can't byte-move a city (water only toggles river
     estuary dressing; the channel the city consumes is spine/params/elevation-driven) — the P2
     discriminator is the regen-order assertion + fingerprint-fresh⇒bytes-fresh property. Worth
     knowing if a later plan wants water→channel coupling.
- **Overlap test map** (`41f5790`): `src/gen/testkit/overlapMap.ts` — 9 deterministic scenario
  builders (S1 river×district, S2 wall-on-ring, S3 forest×river, S4 farmland shared-edge +
  downstream river, S5 park-in-district, S6 ε=0 adjacent districts, S7 mountain/farmland/river
  litmus, S8 typed `market` pin + untyped boundary pins) with premise-asserting tests (17) +
  emitted `dev-vault/Campaigns/Overlap` campaign. Seeds = `hashSeed(7341, featureId)`; procgen
  versions read from registry `currentVersion` at build time (a future bump changes emitted
  bytes visibly — re-emit + eyeball is the intended response).

## Deviations / STOP conditions hit
_(none yet)_

## Flakes / environment notes
_(none yet)_
