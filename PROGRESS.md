# Progress

*Updated after every gate run. A fresh session should be able to resume from CLAUDE.md + this file alone.*

## Status: plans 029 + 030 COMPLETE (2026-07-14) — the versioned-determinism + rearchitecture arc is done. Pipeline arc (031–038) STARTED: plans 031 + 032 + 033 + 034 + 035 COMPLETE (2026-07-15). Plan 036 (global terrain) 36-A/B/D + item 5 COMPLETE, 36-C engine landed (live paint-wiring deferred to a Jonah-eyeball session) — 2026-07-15. Plans 020–028 complete. Next: finish 036-C live wiring; 037.

## Plan 036 — global terrain: terrainAt, stamps, river carve, lazy contour leaves (2026-07-15, 36-A/B/D + item 5 COMPLETE; 36-C engine landed — headless-only per Jonah 2026-07-14)
`terrainAt(x,y) = grade(carve(replace(add(B))))` — the campaign-wide elevation
surface as one point-evaluable field over the durable sketch layer (base fBm +
mountain-union add + relief/landform stamps + river carve + city grading). Base
DEFAULT campAmp 0 (flat) ⇒ every existing campaign byte-stable until opted in.
HEADLINE: the mountain migration is BIT-EXACT — on a mountain-only campaign
`terrainAt ≡ elevationFieldFromFabric` to the float (signed zeros included), so
no existing mountain re-rolls. Verified Vitest headless only (no live gates);
1050 fast + 38 fuzz green (+43 tests over the 035 baseline); `npm run build`
clean per phase.
- **[x] 036-A — composition + stamps v1** (`0a5afa4`): `fields/terrain.ts`. Base
  short-circuits to an exact constant at campAmp 0; the mountain add-term IS
  `elevationFieldFromFabric` (a CALL, not a re-derivation) + a verbatim fast path
  returns it directly (never `0 + m.v`) ⇒ bit-exact incl. −0 gradients. New
  sketch kinds (operators+data doctrine — modes are params): `relief` (line, ADD:
  signed ridge/valley) + `landform` (polygon, REPLACE: plateau/basin/sea, Q4
  priority last-wins), stage-1 elevation producers emitting NO fabric
  (`tileGeneratorIds []`; visible form is the composed-field contours). Threaded:
  FABRIC_KINDS + isPolygonKind, registry (consumesSketch [], margin 0), fabric
  paint (inert wash reusing the mountain hue — no new theme token), 033 harness
  (real blocks + fixtures — proven byte-inert vs every algorithm), style/registry
  /fabric tests. `segmentHash.ts`: the polyline-binding primitive (nearest-on-
  polyline via a uniform-grid segment hash, byte-identical to distanceToPolyline).
  Tests: bit-exactness golden, shuffled-stamp determinism, analytic-vs-central
  gradients (relief/landform/base), priority/id-order, compact-support inertness.
- **[x] 036-B — river carve** (`77b41ca`): `smin(pre, bed)` per river folded after
  replace; the bed is a MEMOIZED per-region channel field (plan-023 sanctioned
  region-scoped exception — the densified spine sampled once, incised by depth,
  following local terrain), queried through the segment hash (extended for
  segIndex+t). Compact support ⇒ a river far from its channel is byte-inert;
  no-river campaigns byte-identical (fast path requires zero carves).
  `fieldLattice.ts`: the lattice discipline — chunked Float32Array + LRU
  (computedTiles/evictedTiles counters), never a global Map. Tests: gorge
  incision + continuity + compact banks, no-river byte identity, segment-tests-
  per-sample budget (<120 on a 2000-seg spine), lattice entry-count/LRU/laziness.
- **[~] 036-C — contour re-home ENGINE** (`7f69968`): `TerrainContourLeaves` —
  viewport-keyed, lazily-traced, LRU-bounded, world-aligned contour leaves of the
  composed field, keyed on the DURABLE TERRAIN INPUTS INTERSECTING each tile.
  2×2 SEAM GATE PASSES (both axes, mm-exact — marchingSquares is world-aligned).
  Tests: seam agreement + determinism, laziness (computedLeaves on first touch),
  LRU eviction, cache-key input-scoping (distant edit can't touch a tile).
  **REMAINING (needs Jonah's eyes):** retiring the mountain generator's baked
  `mountain-contour` (a mountain currentVersion bump + re-golden, byte-stability
  of massif/hachure/peak) and wiring these leaves into the live worker/paint path
  — it swaps the VISIBLE contour source, judged in-app per the plan (no scripted
  live check), so it is deferred to a session that can eyeball the paint rather
  than removing the baked contours blind (which would leave a contour-less map).
- **[x] item 5 — consumers read terrainAt** (`e32b8a8`): river slope + farmland
  paddy read the durable macro terrain via `macroTerrainField` (mountains + base,
  no relief/landform/carve/grade) in place of `elevationFieldFromFabric` — a
  BIT-EXACT drop-in (mountain-only byte-identical; null on a flat campaign). Stamp
  coupling excluded on purpose (logged): a relief's support is its param-driven
  halfWidth, which the fixed-margin 033 model can't express — consumesSketch stays
  ["mountain"], margin 0, no harness churn. Awaits a variable-support invalidation
  model (Jonah).
- **[x] 036-D — grading + base params** (this commit): city-site GRADE term
  (`lerp(t3, t3(center), mask)`, center elevation memoized) DEFAULT OFF (Q3) —
  `grade`/`gradeBand` optional city params READ ONLY by terrainAt (the city
  generator ignores them ⇒ absent reproduces pre-036 bytes, param-over-bump, no
  version bump). Grading-off byte-identity + macro-consumers never see grade
  (include.grade off). Base params (campAmp/seaDatum) are an EXPLICIT terrainAt
  input — the Apply model: the surface changes only when supplied, never
  implicitly. **REMAINING (host, needs Jonah):** the map-settings Apply UI + cost
  notice + headless test-API twin — host plumbing whose paint/flow is judged
  in-app, deferred with 036-C's live wiring.

## Plan 035 — stage reorder, river v2, park split, farmland peri-urban (2026-07-15, COMPLETE — headless-only per Jonah 2026-07-14)
The stage numbers become the product's semantic order: −1 sources · 0 HYDROLOGY
(river) · 1 TERRAIN (mountain) · 2 VEGETATION (forest, rural park) · 3 SETTLEMENT
(city) · 4 PERI-URBAN (farmland, urban-park) · 5 DETAIL (wall). Rivers are canon
strokes terrain conforms to; Jonah's litmus (a terrain edit reaches farmland,
never a river) is host-test-proven both ways. Stage numbers live in the registry
ONLY (grepped: nothing serializes one). Verified Vitest + FakeHost counters only
(no live gates). 1004 fast + 36 fuzz green (+24 tests over the 034 baseline);
`npm run build` clean per phase.
- **[x] 035-A — renumber + river v2** (`ed259c1`): dag `Stage` gains 5 (machinery
  verified stage-agnostic — only the union grew); river → stage 0, drops
  `consumes: ["elevation"]` (stage 0 has no lower stage; the opt-in
  slopeSensitivity>0 path reads `elevationFieldFromFabric` — macro-terrain-from-
  SKETCH, durable-input, legal at any stage); slopeSensitivity default 1→0
  (ratified Q1) ⇒ river `currentVersion` 1→2; goldens:accept run — snap
  byte-identical (fixture has no mountain). consumesSketch KEEPS `mountain`
  truthfully (the 033 harness probes the most-consuming params — slopeSensitivity
  1 — and the opt-in path still reads the field; margin stays 30). Presets:
  mountain-torrent is the one coupling opt-in; lazy-lowland/delta flipped to 0.
  Litmus test: far-mountain edit ⇒ ZERO river regens even on an opted-in river;
  pinned-v1 river byte-stable across replay until explicit adoptRegion under the
  REAL bump.
- **[x] 035-B — park split + THE CYCLE-GUARD INVARIANT** (`00d2c71`): one park
  algorithm id, two roles via the registry's new optional `dagRole(params)` +
  `dagRoleFor` (the ONLY sanctioned host read of stage/currencies): rural
  varieties stay stage 2 / produce vegetation; `urban-park` resolves to stage 4 /
  consumes settlement / produces NOTHING. buildRegionUpstream generalizes water →
  {water, settlement}: stage-4 consumers receive the generated `city-street`
  network as `UpstreamArtifacts.settlement`. Urban-park entrances align to
  generated street crossings on the ring (S5 test: every walk-diagonal boundary
  endpoint ≤30 m of an exact street×ring crossing); rural varieties proven
  upstream-inert (4-variety byte-identity); park v2→3, golden byte-identical.
  Cycle guard (standing registry contract test, guards 037/038): nothing may
  consume `settlement` while producing a currency the city consumes — asserted
  over every resolvable role of every algorithm + stage-above-city.
- **[x] 035-C — farmland peri-urban** (`<this commit>`): farmland → stage 4,
  `consumes: ["elevation", "settlement"]`, BOTH wired in-phase: gate lanes
  radiate from the generated arterial exits (entry = ring-projection of the
  arterial's nearest vertex ≤45 m — city output is clipped to its own ring, so
  arterials END at the shared boundary), field-size gradient toward the wall
  line (cells ≤240 m of the city fabric split one step finer: patchwork depth+1
  + finer min, strips halve, sections/orchards quarter — all position-derived,
  ZERO rng draws). No upstream ⇒ byte-identical through the same arithmetic
  (golden unchanged); farmland v1→2. City keeps reading only the farmland
  SKETCH for outskirt suppression (untouched). Host tests: city edit cascades
  the adjacent farmland city-first (executed-order assertion); farmland edit
  never changes city bytes (inert-force skip); S7 mountain→paddy litmus. S4
  generator tests: gate lanes hang off ring entries near arterials; near-city
  fields smaller+more numerous; far fields byte-identical (locality);
  determinism + containment with upstream.
- NOTE (river v2 side effect, sanctioned degraded state): a v1-pinned river
  whose old fingerprint folded a mountain upstream (the pre-035 elevation edge)
  now computes a different expected fingerprint ⇒ its cache reads stale ⇒ it
  renders NOTHING + a needs-adoption badge instead of stale-serving — never
  silently different bytes (plan 029 §5 carve-out; the signed-off "re-meanders
  once on adopt" path). Rivers with explicit slopeSensitivity params (all
  preset-created ones) adopt byte-identically apart from the meander default.
- NOTE (fixture): `dev-vault/Campaigns/Overlap` still pins river v1 / park v2 /
  farmland v1 — after this plan it is a REALISTIC pinned-old adoption surface
  (per the arc ground rules it was deliberately NOT re-emitted).

## Plan 034 — runForwardPass unification (2026-07-15, COMPLETE — headless-only per Jonah 2026-07-14)
The keystone: the four regen drivers (flush / raw channel / cascadeFromRoot+
cascadeDownstream / replay) collapse into ONE `markDirty(roots) → runForwardPass()`
— any edit is a single (stage,id) forward pass; an edit at stage s structurally
cannot touch stage < s, asserted AT RUNTIME; live editing and campaign-open replay
share the code path verbatim. Verified Vitest + FakeHost counters only (no live
gates). 974 fast + 13 fuzz green; +19 tests over the 033 baseline.
- **[x] 034-A — source nodes at stage −1** (`4a1d932`): dag `Stage` gains −1;
  `DagNode` carries `sketchKind` (sources) / `consumesSketch`+`influenceMargin`
  (regions); `hasEdge` unifies SOURCE→REGION (033-C's raw reach as a graph edge)
  with the region→region produces∩consumes rule. Sources sort first, only feed
  forward — acyclic by construction (fuzz tier re-proven). A raw edit's dirty set
  now carries TRANSITIVE dependents (mountain sketch → river → city), which the
  pre-034 raw channel dropped. `affectedRegionIds`/`regenerateAffectedTiles`
  DELETED. District sketch-add still dirties nothing (explicit-only stands).
- **[x] 034-B — the pass** (`2239983`): dirty = downstreamClosure(regions+sources);
  one scoped-fp pass + the persistent cache view threaded; each dirty region runs
  ONCE (roots unconditionally; non-roots inert-skip on unchanged fp); staged
  repaint. RUNTIME ASSERTIONS: stage sequence non-decreasing + no write outside
  the closure — both throw, both proven live via injected violations
  (`injectForwardPassViolationForTest`). Cost-weighted cap (cheap 1 / medium 2 /
  expensive 4, budget 24) bills only genuinely fp-stale deferrable regions; NEVER
  defers a root. Replay-on-load = the SAME pass: fresh/pinned-old hydrate from
  cache; MISSING records are protected roots (rm-.mapcache stays harmless);
  fp-stale-with-cache are deferrable roots. Region roots mint their own −1 source
  (a procgen wall's raw LINE feeds the city — no stage-4→3 edge could) — closed a
  live-vs-replay divergence (§3 STOP). Adopt-all = raise all pins (durable,
  (stage,id) order) then ONE pass (P9 O(k²)→O(k)). Counter invariants standing:
  runs == dirty count, ONE fp pass, ZERO cache re-reads, repaints == touched
  stages upstream-first.
- **[x] 034-C — cap + outdated badge** (`d8f0829`): pendingPass holds exactly the
  DEFERRED ids; "Apply pending cascade" re-enters the pass with them as
  deferrable roots (no root re-run). `outdatedRegionIds()` badge surface (029
  needsAdoption pattern) + panel row w/ inline Apply button + MapView twins.
  Proven: decline ⇒ ZERO downstream writes (byte-identical record) + badge +
  Notice; reopen after decline re-derives the deferral from fp staleness alone —
  ZERO generator runs, stale bytes SERVED (painted, badged, not blanked), bill
  still applies; apply ⇒ same bytes as an undeferred pass (rm-.mapcache replay
  equivalence); under budget nothing defers.
- **[x] 034-D — preview mode** (`41e125f`, the ratified plan-035 precondition):
  `previewRegionGeometry` recomputes ONLY the root against the DRAFT shape and
  clips straight into the render store — no cache append, no fp stamp, no
  downstream, no log (byte-identical .mapcache across a 3-pause simulated drag);
  release = the ordinary commit → ONE full pass; kill-before-release leaves no
  durable trace (reopen: zero runs); `cancelRegionPreview` restores durable paint
  by pure re-clip (draft-range orphan tiles cleared first). SketchController
  dragMove → MapView 250 ms trailing debounce; release cancels the preview timer.
  Pinned-old regions refuse preview (consent stays at commit). Per-stage debounce
  tiers / closure truncation NOT added (rejected, research §6.6).
- **[x] 034-E — adopt-all O(k) proof** (`<this commit>`): pinned
  mountain→river→city k-chain ⇒ adopt-all runs each region EXACTLY once in
  (stage,id) order, 3 runs total (pre-034: 3+2+1), ONE fp pass; pins raised;
  reopen replays with zero runs.
- **STOP conditions honored**: no live-vs-replay special cases (the one
  divergence found — region raw geometry as a constraint — was fixed
  structurally, not papered); the cap never defers the root; explicit-only
  untouched (a pass only RE-generates; sources never first-time-generate).
- **Judgment calls for Jonah's eyes**: cost budget 24 + weights 1/2/4 (test
  override exists; retune freely); deferral Notice wording + panel "Outdated —
  an upstream edit is waiting to be applied here" + Apply button; on a
  cost-deferred replay a pinned-old fp-stale region now serves its pinned bytes
  with the OUTDATED badge instead of blanking (visible-not-silent, only in the
  storm-suppression path); source→region reach uses the DAG's rectangular
  expandBBox vs 033's Euclidean bboxGap — a safe over-approximation (corner
  cases over-invalidate; byte-identical + deterministic, perf-only).

## Plan 033 — consumption-aware invalidation (2026-07-15, COMPLETE — headless-only per Jonah 2026-07-14)
Declare per algorithm which raw sketch KINDS it reads and how far they reach, then
scope both the invalidation walk and the staleness fingerprint to that — killing
the P4 over-invalidation (a road edit regenerating mountains) and the P5 load-storm
(any sketch edit flipping every region's fingerprint). Verified in Vitest + FakeHost
counters + the 033-A fuzz gate; NO live gates. 955 fast + 36 fuzz green.
- **[x] 033-A — under-invalidation property harness** (`d9dacc2`, prior session): the
  shipping gate. `checkUnderInvalidation` proves per algorithm × sketch-kind that any
  non-declared kind (overlapping/touching/far) and any declared kind beyond its margin
  are BYTE-INERT — so an under-declaration fails HERE. Runs in the fuzz tier forever.
- **[x] 033-B — fast fingerprint hasher** (`790caff`): the FNV-1a BigInt-per-char hasher
  (~56 MB/s measured) replaced by a pure-TS two-lane 32-bit hash (cyrb-style, two
  `Math.imul` lanes cross-mixed, same 16-hex width) — **975 MB/s, 17.3x** on a 127 KB
  ring string. Perf is a BUDGET COUNTER (`hashByteBudget`: bytes/pass), never wall-clock
  (docs/06). Hash-equivalence not required: `FP_VERSION fp1→fp2` self-heals one recompute.
- **[x] 033-C — registry consumption declarations** (`58a3622`): each algorithm declares
  `consumesSketch` (raw kinds it reads), `influenceMargin` (m, bbox-to-bbox), `costClass`
  (routing data for plan 034's cap — nothing keys on it yet). Values from the 033-A
  VERIFIED table: city water/river/road/wall/farmland@1500 expensive; river
  water/river/mountain@30 medium; park road@30; wall road@0; farmland mountain@0;
  forest/mountain none. The fuzz harness now reads them off the registry (temporary
  MEASURED_CONSUMPTION fixture deleted; prove-the-net clones kept); a `registry.test.ts`
  row pins the exact values. `affectedRegionIds` switches from the blanket 200 m
  kind-blind reach to `kind ∈ consumesSketch ∧ bboxGap ≤ influenceMargin` — **P4: 3
  regens → 1** (road edit no longer regenerates mountains/forests); district-add ⇒ zero
  neighbour regens; margin scopes near-vs-far. The DAG output-coupling reach
  (CONSTRAINT_REACH, buildRegionUpstream/upstreamEdges) is deliberately unchanged.
- **[x] 033-D — scoped fingerprints** (`<this commit>`): `canonicalConstraints` now hashes
  ONLY the consumed kinds within the influence bbox (+ upstream DAG fps as before), so a
  far / non-consumed sketch edit leaves a region's fingerprint intact. `FP_VERSION
  fp2→fp3` (self-heal). The fp pass THROWS on a missing upstream fp (never silently
  filters — a dangling DAG edge surfaces). An invalidation-walk force whose recomputed
  fp equals the cached record's is SKIPPED (`skipInertForce`, flush/cascade opt-in only —
  a direct GM regenerate/adopt always recomputes, preserving 031-A): declared-but-inert /
  no-op edits become free (`inertForceSkipCount`). Proof: scoped hash inert to a far/
  non-consumed edit but flips inside the bbox; P5 load-storm (reopen after a far external
  road recomputes ZERO out-of-reach regions); a pinned-old region survives an unrelated
  far edit (no needs-adoption badge, no blank — the global hash would have false-blanked
  it); an inert re-commit skips the generator run.
- **STOP conditions honored**: no behavior keys on `consumesSketch` beyond what 033-A
  verifies; the invalidation walk is never special-cased (a missed read is fixed in the
  DECLARATION, harness catches it); delete-`.mapcache`+replay stays byte-identical; no
  plan 034 source-nodes / unified-pass / cost-cap behavior begun.

## Plan 032 — cache sharding, persistent view, staged repaint (2026-07-15, COMPLETE — headless-only per Jonah 2026-07-14)
The load-bearing cache/repaint floor for the pipeline arc (research §3, §6.3/6.7/6.8).
Verified in Vitest + FakeHost IO/repaint counters only (no live gates). +15 tests
(939 total green; the sole tsc error is a parallel session's untracked plan-033
`underInvalidation.*`, not this work).
- **[x] 032-A — shard the cache per region** (`8b2cc5a`): `generated.jsonl` split by
  key into per-region `region-<id>.jsonl` + a shared `world.jsonl` (keys DISJOINT
  across shards). A drop rewrites — or, for a whole-region drop, DELETES — only the
  one shard (research P6: a 10-region cascade was ~3.4 GB of vault IO); appends/reads
  scope to a shard; `readCachedTiles` enumerates shards via `adapter.list`. Migration:
  a pre-032 monolith splits line-by-line on first touch (per-folder lock, idempotent
  truncate-write, then delete), routing RAW line strings so records — incl. a
  pinned-old region's network record (the plan §3 STOP condition) — carry over
  BYTE-IDENTICALLY. Proof: region records land only in their shard; a drop deletes its
  shard + rewrites no sibling; a monolith migrates + self-deletes byte-for-byte; the
  pinned-old STOP gate (network line verbatim, still renders cache-only).
- **[x] 032-B — persistent in-memory cache view** (`5b5e4f0`): the cache is read from
  disk ONCE per campaign open (`cacheView`) and served from memory; region appends
  `.set()` into it and drops (`dropCached`) write through to disk AND `.delete()` from
  it, so no batch re-reads a held shard (research P7). Owned per-controller (not a
  module global) — a fresh controller (`reopen`/switch) starts empty, so
  delete-`.mapcache`-then-reopen still blanks a pinned-old region and a lost write is
  a fingerprint MISS that regenerates byte-identically (write-through, not deferred
  write-behind — determinism makes lost writes harmless, sidestepping the undo-log
  sequencing hazard). World-tier tiles stay on the direct `getCachedTile` disk path.
  Proof: one disk read per session, ZERO re-reads across consecutive batches;
  crash-consistency (cleared cache regenerates byte-identically on reopen, view
  rebuilt on the miss); a drop clears the live view. The 031-B per-batch read
  assertion tightens 1→0.
- **[x] 032-C — stop persisting per-tile clip records** (`6d77f3a`): a region wrote a
  network record PLUS one per-tile clip per (tile × generator) — the per-tile clips
  just re-sliced the network's bytes (the ~10 MB/region figure). Now ONLY the network
  record persists; tiles RE-CLIP it on demand (`clipNetworkToTile`, pure), so bytes
  are byte-identical to the dropped per-tile records and the network is both the
  freshness authority and the fast path. World tiers keep their own records.
  Measured on the RING city fixture: **55 region cache records → 1** (54 per-tile
  clips eliminated; 9 tiles × 6 generators). Pinned-old still renders from its network
  alone. Proof: exactly ONE persisted region record; a re-clip == `clipNetworkToTile`
  of the persisted network byte-for-byte; forced regen leaves record + render
  byte-identical.
- **[x] 032-D — staged repaint** (`<this commit>`): a batch now fires ONE repaint per
  TOUCHED DAG STAGE, upstream-first (`dirtyStages` in `withRepaintBatch`), not one
  blanket paint — a river→city cascade repaints stages [1,3] and never touches the
  untouched mountain (stage 0). MapView scopes each staged repaint to that stage's
  features via an incremental `updateData` diff (single `generated` source, no
  theme/layer changes; full `setData` on the no-stage initial/replay path). MapView
  side is build+tsc-only; visual judgment deferred to normal app use (plan §2). Proof
  (FakeHost `repaintGeneratedStages`): river→city flush repaints `[1,3]` (upstream-
  first, no `0`, no full paint); a single city regen repaints `[3]`; world generation
  repaints the WORLD_STAGE bucket; a stage's feature budget ⊂ the whole map.
- **STOP conditions honored**: pinned-old records migrate + render byte-identically
  (never blanked/re-derived); delete-`.mapcache`+replay stays byte-identical; no plan
  034 unified pass begun.

## Plan 031 — pipeline hotfixes (2026-07-15, COMPLETE — headless-only per Jonah 2026-07-14)
Four fixes from `plans/research-generation-pipeline.md` §3; mostly byte-identical,
verified in Vitest only (no live gates this arc).
- **[x] 031-A — network once per forced regen (P1)** (`cebb66f`): `generateRegionTile`
  under `force` recomputed the whole-region network once PER TILE (T× waste + T
  duplicate network records). Now force consults the (preloaded) cache like the
  non-force path — the first tile computes + writes, every later tile of the pass
  re-clips only; `generateRegion` clears the region's stale network from vault +
  shared map so the first tile recomputes fresh. Proof: `generatorRunCount` delta
  === 1 on a ~9-tile city regen; exactly ONE raw network record in generated.jsonl;
  output byte-identical.
- **[x] 031-B — batching parity** (`02f0e07`): flush / cascadeDownstream /
  cascadeFromRoot / applyPendingCascade now compute ONE fingerprint map + read ONE
  shared cache view and thread both through every region regen (like replay), and
  wrap the pass in a repaint batch (coalesced to 1 paint). buildRegionUpstream
  serves fresh upstream from the shared view (0 extra IO). Byte-identical by
  construction. Proof (FakeHost gateway/repaint counters): 1 fp pass + 1
  host.vault.readCached + 1 repaint per river→city flush; batched output ==
  from-scratch replay. (removeCached's per-region file rewrite — P6 — is plan 032.)
- **[x] 031-C — stage-ordered raw channel (P2/P3, CORRECTNESS)** (`5557ba6`): the
  raw-sketch reach walked affected regions in FABRIC FILE ORDER (roots in QUEUE
  ORDER), so a downstream stamped fresh over stale-upstream bytes survived reloads.
  Now `affected ∪ roots` merge into ONE `(stage,id)` walk (`forceRegenInStageOrder`);
  cascade still seeds from region-edit roots only (fan-out = plan 033). Only
  incorrectly-stale regions change bytes. Proof: adversarial city-before-river file
  order ⇒ river regenerates first (`forceRegenOrder`, fails on the pre-fix walk);
  fingerprint-fresh⇒bytes-fresh property; reversed-file-order determinism.
- **[x] 031-D — line-kind regions through the worker** (`<this commit>`): the worker
  job now carries `region.spine` (plain `Pt[]` + a localized zod schema); the worker
  rebuilds the corridor via `makeSpine`+`makeCorridorRegion` (shared pure
  `reconstructJobRegion`), so river/wall regen leaves the main thread. Main-thread
  fallback retained (no worker ⇒ `algorithm.generate`). Proof: JSON-round-tripped
  spine job produces byte-identical output vs the main-thread build, for river AND
  wall; polygon path + guard + malformed-spine zod throw covered.
- **STOP conditions honored**: no upstream threaded into a cache-HIT path; no
  consumption-aware invalidation / unified pass (032–034 untouched).

## Plan 030 — rearchitecture waves (2026-07-14, COMPLETE)
- **030-A DONE** (docs slice `9bb4328` + 4-agent sweep integrated, close `c3f77e6`):
  ~630 comment plan-citations → 0 across 126 src files (19 justified string
  survivors: snapshot-key test names + 1 runtime error string — deviation
  ruling in DECISIONS); docs/02 + the 3 procgen design docs deleted (folded
  into ARCHITECTURE.md + docs/procgen-design.md); ARCHITECTURE §12 = single
  invariants home w/ enforcement pointers; 030-C operators+data rule in
  CLAUDE.md; PROGRESS archived; DECISIONS indexed. Zero golden changes.
- **030-B DONE** (`c54bc2c` smoke gates + audit, `3416f93` shrink): 31 live
  gates → 5-gate smoke board (smokeBoot/phase1/smokeProcgen/version29/phase5);
  perceptual golden runner (scripts/perceptual.ts, zero deps, 8 pinned tuples,
  byte-deterministic); every deleted gate has a prove-by-breaking record
  (review/030B-break-proofs.md) — 3 real net holes found at the
  controller/paint seam, repaired + re-proven BEFORE deletion (strengthened
  vertex-edit test, river→city consumption test, styleGolden theme digests).
  Board 2198s → 308s GREEN 9/9.
- **030-C** standing convention active (CLAUDE.md + ARCHITECTURE §12.19).
- **030-D DONE** (worktree agent, integrated `a3f5067`): per-algorithm
  styleContract (14-role vocabulary) + roleColors per theme + ONE generic
  builder replaces the 8 map/themes/generated/* files (−972 lines);
  tileGeneratorIds derives from the contract + emitted-gid ⊆ contract test
  (silent-drop structurally dead); playground renders the contract; proof:
  styleGolden BYTE-IDENTICAL (no -u), perceptual 8/8 at 0.000%, ZERO per-theme
  overrides needed; smokeProcgen hardened with a rendered-pixels assertion
  after finding the raw-setStyle blank-screenshot artifact.
- **030-E DONE** (`a3dcbc9`): full doc read-through against as-built code —
  ARCHITECTURE §5 versioned determinism / §8 style contract / §9 tiers+smoke
  board / §10 portable renderer contract / §12 contract-enforced invariants;
  CLAUDE.md + docs/05/06/08 + README reconciled; playground/README.md added;
  HEARTBEAT retired to review/. PLAN 030 COMPLETE.

## Plan 029 — versioned determinism (2026-07-14, COMPLETE)
- **29-A DONE** (`612cfd2`): `ProcgenAlgorithm.currentVersion` (all 7 at 1) +
  optional `migrateParams` + `migrateParamsForAdoption` + `allAlgorithms()`;
  creation writes `currentVersion`; version-pin unit family (creation pins,
  edits keep the pin, lenient unknown-key params round-trip); fingerprint
  version-flip test verified pre-existing.
- **29-B DONE** (`b3e74f6`): adoption lifecycle — `ConfirmSink` host gateway;
  consent prompt on every direct edit of a pinned-old region (decline cancels
  the edit); `generateRegion` = the single cache-only funnel for indirect
  demands (pinned-old + no cache ⇒ renders NOTHING + needs-adoption badge,
  generator NEVER runs under an old pin); panel Adopt button, adopt-all
  command, test twins + `overrideCurrentVersionForTest`; `version29` gate
  13/13 standalone; Vespergate byte-intact. Policy docs in `e77e798`
  (CLAUDE.md versioned-determinism bullet + .mapcache carve-out; docs/05
  tuning loop).
- **29-C DONE** (`0a9c50b`, Opus worktree agent): shared
  `testkit/invariants.ts` (containment/closed-rings/mm-lattice/determinism)
  wired into all 7 suites; 6 pure metrics modules + golden-anchored bands
  (river sinuosity/width, forest cover/holes/trees, park path/water/points,
  wall spacing/count/gates, farmland fields/lanes, mountain
  peaks/contours/hachures); goldens shrink river 2→1 + city 4→1 (coverage
  converted structural, euro-medieval golden byte-identical);
  `npm run goldens:accept -- <algorithm>` explicit-only re-golden script.
- **§9 exit test DONE with a REAL change** (`67c9041`): `blobFeature` D5
  quantization bug (found by the 29-C agent, ruled bump-not-bugfix) fixed
  behind park v1→2 + `goldens:accept` + mm opt-outs removed — the full
  bump/re-golden/bands/adoption loop in one sitting, zero byte-neutrality
  analysis. The policy paid for itself on day one.
- **Plan board (T3)**: 31/35 raw = 35/35 effective — procgen41 (16/16) +
  procgen43 (7/7) standalone-green right after (environment flakes per the
  2026-07-13 rule); phase0 "dirtied dev-vault" + presetGallery = Jonah's own
  live edits (new `testing/` campaign + Preset Gallery), ruled green by Jonah
  same day. `version29` passed in-board.

Older arcs (plans 001–028, phases 0–5): `review/progress-archive.md`.
