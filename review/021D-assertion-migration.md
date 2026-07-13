# Plan 021 §4 acceptance report + assertion-migration map (phase 21-D)

*Documentation + proof phase. No live-gate assertions were migrated and no
`src/` behavior changed here (except a transient, reverted determinism-break
injection). Later plans (022+) write their host-lifecycle tests headless-first
on the 21-C `MapController`/`FakeHost` harness; this doc is the map they follow.*

Baseline: `.lastgreenboard` = `62660d3` (full board 15/15, 395.9 s, 0 relaunches).

---

## 1. Acceptance numbers (plan 021 §4)

| §4 bullet | Target | Measured | Source | Verdict |
|---|---|---|---|---|
| Inner loop (edit → `npm test` + `npx tsc --noEmit`) | **< 45 s** | **17 s** (test 15 s + tsc 2 s) | timed this phase | **PASS** |
| Phase checkpoint T1 (T0 + fuzz + one gate) | **< 5 min** | **≈ 3.1 min** worst case | see calc below | **PASS** |
| Full board T3 | **< 15 min** | **6.6 min** (395.9 s) | `62660d3` board-report.md | **PASS** |
| Full board process boots | **≤ 4** | **0 relaunches** | `62660d3` board-report.md | **PASS** |
| Full board is one command / one report | one | `npm run board` → `shots/board-report.md` | 21-B | **PASS** |
| Injected determinism break still caught | fast tier OR change-scoped | caught by **both** | §2 below | **PASS** |
| Fixture hygiene: board ends dev-vault byte-clean, enforced per-gate | enforced | enforced by board.ts per gate (21-B); `git status --short dev-vault/` empty now | 21-B + §3 | **PASS** |
| phase1 no longer strips `connections:` from Ashfall notes | fixed | 21-A rewrote phase1 to `__Gate*` temp notes; 16/16 byte-clean | 21-A (PROGRESS) | **PASS** |
| No reduction in what is asserted (≥70% of live-gate assertions eligible to move headless) | **≥ 70%** | **34 % all-in / 51 % of domain assertions / 44 % across targeted gates** | §4 map | **NOT MET all-in; marginal + methodology-dependent for domain-only — F1** |

**T1 calc:** fast tier 17 s + fuzz tier 68 s (fresh; board-report cites 82.3 s) +
the heaviest single gate procgen41 92.3 s (`62660d3` board-report) = **177–192 s
≈ 3.0–3.2 min < 5 min**. A *typical* phase gate is 7–42 s, so T1 is normally
well under 2 min; even the worst-case single gate clears the budget. (Live-gate
wall time cited from the board report per the phase brief — no live gates were
booted for timing.)

**Fresh timings recorded this phase:** `npm test` = 15 s (329/329),
`npx tsc --noEmit` = 2 s, `npm run test:fuzz` = 68 s (2/2).

---

## 2. Determinism-break injection proof (both catch paths)

**Injection:** `src/gen/rng.ts:18`, the FNV-1a offset-basis salt in `hashSeed()`
(same salt 21-A flipped, per DECISIONS 2026-07-12):
`let h = 2166136261;` → `let h = 2166136262;`. This perturbs every
`hashSeed(...)` result → every region/generator seed shifts.

**2a — fast tier goes RED.** `npm test` with the break in place:

```
FAST tier exit=1 wall=15s
 ❯ src/gen/city/corridor.test.ts (12 tests | 2 failed) 637ms
   × generateCorridorStreets determinism > matches the seeded snapshot fixture
   × generateCorridorStreets 2x2 seam test > the 2x2 seam layout matches its snapshot fixture
 Test Files  1 failed | 30 passed (31)
      Tests  2 failed | 327 passed (329)
```

Caught in **15 s** by the two absolute-value snapshot fixtures in
`src/gen/city/corridor.test.ts` (`__snapshots__/corridor.test.ts.snap`).
Note: the ~40 other determinism tests stayed green — they compare
*regenerate-vs-original* (self-relative), which a uniform salt flip preserves;
only absolute golden snapshots catch it. `src/gen/sigil/sigil.test.ts` has
absolute snapshots too but did **not** fail — its SVG seed path does not route
through `hashSeed`. So the fast tier's determinism tripwire is specifically the
corridor golden snapshots. (Consistent with 21-A's recorded result.)

**2b — change-scoped gating escalates to full board.** With the break still in
place, `src/gen/rng.ts` is a `determinismCritical` path in
`scripts/gates/coverage.json`, so `changed-gates.ts` escalates. It prints the
verdict and `return`s **before** the `--run` block (line 159), so no board ever
boots — no kill/abort was needed. Isolated capture:

```
$ npx tsx scripts/changed-gates.ts --files=src/gen/rng.ts
== changed-gates (explicit --files) ==
changed files (1):
  src/gen/rng.ts

VERDICT: FULL BOARD — determinism-critical path changed (src/gen/rng.ts) → FULL board
(run the full board via `npm run board` — plan 021 phase B)
```

Real git-diff run (`npm run gates:changed`, diff vs `.lastgreenboard` 62660d3):

```
== changed-gates (git diff vs 62660d3) ==
changed files (5):
  .lastgreenboard
  DECISIONS.md
  HEARTBEAT.md
  PROGRESS.md
  src/gen/rng.ts

VERDICT: FULL BOARD — determinism-critical path changed (src/gen/rng.ts) → FULL board
```

The full board was deliberately NOT run with the break in place (would only
re-prove the escalation, at 6.6 min cost).

**2c — byte-clean revert + green restoration.** `git checkout -- src/gen/rng.ts`;
`git status --short` shows **no** entry for `src/gen/rng.ts` (working tree clean,
salt back to `2166136261`); `npm test` → **31 files, 329/329 passed**. Restored.

---

## 3. Fixture hygiene

`git status --short dev-vault/` is **empty** at phase start and end (dev-vault
untouched this phase). The durable §4 evidence is not the current empty status
but that the `62660d3` board passed **15/15 with the per-gate hygiene assertion
active** (21-B: after every live gate the board asserts `git status --short
dev-vault/` is empty and RED-fails a dirtying gate, then auto-restores). phase1
specifically was rewritten in 21-A to use `__Gate*` temp notes and no longer
strips `connections:` from the Ashfall notes (16/16, byte-clean).

---

## 4. Assertion-migration map

### Method & legend
Each numbered pass/fail check in each of the 11 live-gate scripts is one row.
Two checks that bundle a screenshot with an independent state assertion are
split (`procgen40 d`, `procgen41 o`). Classes:

- **HN — headless-now**: an existing fast-tier (Vitest, no-Obsidian) test already
  reproduces the invariant (test file named).
- **HC — headless-candidate**: movable to a `FakeHost`/`MapController` (or plain
  Vitest) test — logic only, no renderer (controller API named).
- **GL — genuinely-live**: needs the real MapLibre renderer / GPU / style engine
  / Obsidian app / interaction, per the phase-brief rubric (screenshots,
  queryRenderedFeatures, paint-property reads, layer paint, style-load engine,
  export pixels, frame-timing, pan/zoom wiring, bundle sweeps, dev:errors,
  plugin-load/open/reload).

**Eligible to move headless = HN + HC.** Within GL, a subtag marks rows that are
irreducible **live-harness scaffolding** (`plugin-load`, `open`, `reload`,
`dev:errors`, `screenshot-capture`) — the live shell every gate keeps regardless;
these were never migration candidates and are broken out in the summary.

Fast-tier split rule (verified against `vitest.config.ts` / `vitest.fuzz.config.ts`):
`src/**/*.test.ts` = fast tier; `**/*.fuzz.test.ts` = fuzz tier. The only fuzz
file is `src/gen/citynet/citynet.fuzz.test.ts`. The 15 `MapController.test.ts`
tests referenced below are all fast tier.

---

#### phase0 (skeleton + two spikes) — 10 checks
| # | check | class | covers / reason |
|---|---|---|---|
| a | no Node API in `main.js` | GL | bundle sweep (build artifact) |
| b | plugin enabled, no load errors | GL·scaffold | dev:errors / live app |
| c | Ashfall campaign config parses (`listCampaigns`) | HN | `src/model/campaignConfig.test.ts` (parseCampaignConfig) |
| d | per-campaign open-map opens a view | GL·scaffold | workspace lifecycle |
| e | MapLibre canvas nonzero size | GL | renderer/DOM layout |
| f | fictional scale bar shows a value (DOM) | GL | DOM wiring (math already in `fictionalCRS.test.ts`) |
| g | generic open-map shows a picker modal | GL | modal/DOM UI |
| h | tab survives split | GL | workspace UI |
| i | survives full app reload | GL·scaffold | app reload |
| j | screenshot captured | GL·scaffold | screenshot |

eligible 1/10.

#### phase1 (yes-and core) — 16 checks
| # | check | class | covers / reason |
|---|---|---|---|
| a | no Node API in bundle | GL | bundle sweep |
| b | plugin loads, no errors | GL·scaffold | dev:errors |
| c | open Ashfall map | GL·scaffold | open |
| d | connections layer + seeded line (source feature count) | HN | `src/model/connections.test.ts` (buildConnectionFeatures) |
| e | connect write-path grows connection source | HC | MapController connect-twin (`connectForTest`); `src/vault/locationOps.test.ts` addConnection |
| f | reconcile create → indexed <500ms | HC | MapController/index reconcile |
| g | reconcile rename → key follows | HC | MapController/index reconcile |
| h | reconcile delete → drops | HC | MapController/index reconcile |
| i | bad frontmatter warned, not dropped | HN | `src/model/locationNote.test.ts` (rejects missing geometry, never silent drop) |
| j | quick-add ≤5s creates note + indexes | HC | MapController `createLocation`-twin (5s wall budget is environmental) |
| k | 0 label collisions at z4/8/12/16 | GL | queryRenderedFeatures + map.project |
| l | hit tolerance near-miss → dot | GL | interaction (idle event + hitTest + qRF) |
| m | theme-follow paint property | GL | paint-property read |
| n | mutation log written for map create | HN | `MapController.test.ts` #12/#14 assert log entries; `src/model/mutationLog.test.ts` |
| o | survives full app reload | GL·scaffold | reload |
| p | screenshot captured | GL·scaffold | screenshot |

eligible 8/16.

#### phase2 (real cities + themes) — 15 checks
| # | check | class | covers / reason |
|---|---|---|---|
| a | no Node API in bundle | GL | bundle sweep |
| b | plugin loads, no errors | GL·scaffold | dev:errors |
| c | `basemap.pmtiles` present (London) | HC | plain fs-existence test, no Obsidian |
| d | locations indexed on cold load | HC | MapController replay/index reconcile |
| e | real-city basemap renders (`basemap-earth` qRF) | GL | PMTiles decode + render |
| f | canon pin renders over basemap (qRF) | GL | rendered feature |
| g | native scale control present, fictional bar hidden | GL | DOM/UI state |
| h | theme modern-clean bg matches token | GL | paint-property read |
| i | theme parchment bg matches token | GL | paint-property read |
| j | theme ink-soot bg matches token | GL | paint-property read |
| k | theme neon-sprawl bg matches token | GL | paint-property read |
| l | restore obsidian-native (config.theme) | HC | MapController/config state |
| m | fictional campaign still works | GL·scaffold | open |
| n | survives reload with basemap | GL·scaffold | reload |
| o | screenshot (London basemap + pin) | GL·scaffold | screenshot |

eligible 3/15. *(The four theme-bg checks read `getPaintProperty` off the live
map; the style-BUILD values are separately headless-covered by
`src/map/themes/fabricLayers.test.ts` (6 colors/theme) and
`src/map/styleValidation.test.ts`. Classed GL per the rubric's "layer paint";
the invariant is partially headless-reinforced but the gate's read is live.)*

#### phase3 (procgen) — 14 checks
| # | check | class | covers / reason |
|---|---|---|---|
| a | no Node API in bundle | GL | bundle sweep |
| b | plugin loads, no errors | GL·scaffold | dev:errors |
| c | open Ashfall | GL·scaffold | open |
| d | toolbar renders ≥5 buttons | GL | DOM/UI |
| e | generate-fabric-here world tier grows `generated` | HN | `MapController.test.ts` #12 (records manifest, runs generator, features>0) |
| f | city-tier district → streets/blocks/parcels/footprints/wards, ≥100 inside | HN | `MapController.test.ts` #1 + `src/gen/citynet/citynet.test.ts` (v3.2 blocks/parcels/wards) |
| g | world bg biome-driven (fill-color expression) | GL | paint/style-expression read |
| h | generated fabric renders alongside canon (qRF) | GL | rendered feature |
| i | cache-delete + replay hash-identical | HN | `MapController.test.ts` #2 (re-clips byte-identically after cache delete) |
| j | canonization commands gone / gen commands present | GL | live-app command registry (migratable only as a bundle/registry sweep) |
| k | regenerate adapts to canon; canon untouched | HN | `MapController.test.ts` #11 (constraint edit queues+flushes regen) + `generationService.test.ts` |
| l | survives reload | GL·scaffold | reload |
| m | screenshot | GL·scaffold | screenshot |
| n | fixture cleanup: manifest/fabric length 0 | HN | `MapController.test.ts` #9 (clearAllGenerated strips procgen + cache) |

eligible 5/14.

#### phase4 (explicit-only contract + perf) — 12 checks
| # | check | class | covers / reason |
|---|---|---|---|
| a | no Node API (main + worker) | GL | bundle sweep |
| b | plugin loads, no errors | GL·scaffold | dev:errors |
| c | bare pan/zoom generates NOTHING | GL | MapView viewport wiring (controller has no viewport seam → FakeHost "pan" is vacuous; invariant reinforced headless by `MapController.test.ts` #3/#13 generatorRunCount==0) |
| d | explicit gen: both tiers coexist | HC | MapController — generate both, assert counts (#12 world + #1 city) |
| e | tile store immune to panning | GL | MapView viewport wiring (bounded-by-explicit is headless via `loadedTileCount`; panning-immunity is live) |
| f | revisit determinism: identical id fingerprint | HN | `MapController.test.ts` #3/#13 replay + #2 byte-identity |
| g | explicit fabric renders through (qRF) | GL | rendered feature |
| h | perf: p95 frame time during scripted pan | GL | renderer/compositor frame timing |
| i | perf: index rebuild <1s for 500-note campaign | HC | MapController/index rescan measured on in-memory notes (wall budget environmental) |
| j | survives reload | GL·scaffold | reload |
| k | screenshot | GL·scaffold | screenshot |
| l | fixture cleanup byte-intact | HN | `MapController.test.ts` #9 (clearAllGenerated) |

eligible 4/12.

#### phase5 (keepsakes & force multipliers) — 9 scored checks (baseline-snapshot step excluded as bookkeeping)
| # | check | class | covers / reason |
|---|---|---|---|
| a | plugin loads, no errors | GL·scaffold | dev:errors |
| b | Ashfall style loads (`isStyleLoaded`) | GL | style-load engine |
| d | Phase-5 commands + view methods present | GL | live-app command/method registry (underlying logic headless: `populate.test.ts`, `importGeojson.test.ts`, `sessionPath.test.ts`) |
| e | point-crawl + session-path layers registered | GL | layer registration (sessionPathFeature headless in `sessionPath.test.ts`) |
| f | poster export writes a PNG | GL | export pipeline draws from live canvas (`posterExport.test.ts` covers `posterDimensions` math only) |
| g | atlas export writes a PDF | GL | export pipeline → PDF from canvas (`atlasExport.test.ts` covers wrapText/sanitize only) |
| h | replay-campaign runs without renderer errors | GL | dev:errors / live replay (replay logic headless in `MapController.test.ts` #3/#13) |
| i | gate-created exports removed | HC | fs cleanup (adapter), trivially headless |
| j | screenshot | GL·scaffold | screenshot |

eligible 1/9.

#### procgen40 (sketch-driven procgen regions) — 11 rows (d split)
| # | check | class | covers / reason |
|---|---|---|---|
| a | unit gates (vitest region/citynet/fabric) | HN | *literally* re-invokes existing fast tests: `region.test.ts`, `citynet.test.ts`, `fabric.test.ts` |
| b | plugin loads / cache clean | GL·scaffold | dev:errors |
| c | vespergate opens (migration runs) | GL·scaffold | open |
| d-mig | manifest.domains empty; district has city procgen block | HN | `MapController.test.ts` #4 (migrates legacy disc domain, domains→0, seed kept) |
| d-ren | city renders (`generated-street` qRF) | GL | rendered feature |
| e | headless sketch → city, all inside (outside==0) | HN | `MapController.test.ts` #1 |
| f | delete cache → replay byte-identical | HN | `MapController.test.ts` #2 |
| g | explicit-only: pan/zoom never generates | GL | MapView viewport wiring (invariant reinforced headless) |
| h | screenshot | GL·scaffold | screenshot |
| i | remove-generated-city: shape stays, cache gone, no resurrection | HN | `MapController.test.ts` #9 (strip procgen, cache gone) + #3 (replay) |
| j | dev:errors clean | GL·scaffold | dev:errors |

eligible 5/11.

#### procgen41 (PowerPoint-style sketch edit UX) — 17 rows (o split)
| # | check | class | covers / reason |
|---|---|---|---|
| a | unit gates (vitest fabric/region/citynet/generation) | HN | existing fast tests |
| b | plugin loads / cache clean | GL·scaffold | dev:errors |
| c | vespergate opens | GL·scaffold | open |
| d | footprint & parcel NOT zoom-restricted (minzoom==0) | HN | `src/map/themes/fabricLayers.test.ts` (asserts NO fabric layer carries minzoom) — **corrects the 21-C note that listed minzoom as genuinely-live** |
| e | moveVertex outward → adapts (count≠n0, inside) + regen byte-identical | HN | `MapController.test.ts` #5 (adapts to reshaped district) + #2 (byte-identity) |
| f | stored center raises vertex-edit stability vs none | HC | MapController `setRegionCenter` + `streetBuckets` (computed from controller `loadedTiles`); center-override determinism in `citynet.test.ts` |
| g | reroll → NEW seed, output changes | HN | `MapController.test.ts` #6 (re-rolls to new seed + different output) |
| h | setRegionParams profile change regenerates | HN | `MapController.test.ts` #7 (switches profile + regenerate) |
| i | sketch-edit undo restores ring + city | HN | `MapController.test.ts` #10 (undo of region create) + `fabric.test.ts` sketchUndoTarget |
| j | vertex edit on river → adjacent region regenerates | HN | `MapController.test.ts` #11 (constraint edit queues + flushes regen) |
| k | pan/zoom never generates | GL | MapView viewport wiring |
| l | off-centroid center moves plaza; reset byte-identical; outside rejected | HN | `src/gen/citynet/citynet.test.ts` "generation center override" (inside anchor + byte-identical fallback when outside) + MapController center-twin |
| m | screenshot (region + handles) | GL·scaffold | screenshot |
| n | screenshot (city after vertex edit) | GL·scaffold | screenshot |
| o-con | concave L-region containment outside==0 | HN | `src/gen/region.test.ts` (L-shape containment) + `citynet.test.ts` (v4.0 concave all-inside) |
| o-sh | screenshot (concave region) | GL·scaffold | screenshot |
| p | dev:errors clean | GL·scaffold | dev:errors |

eligible 10/17.

#### procgen42 (sketch-driven city CONTENT) — 9 checks
| # | check | class | covers / reason |
|---|---|---|---|
| a | plugin loads, no errors | GL·scaffold | dev:errors |
| b | vespergate opens | GL·scaffold | open |
| c | river-straddling district → ONE gen exec, all inside | HN | `MapController.test.ts` #1 (inside) + `generationService.test.ts` (network computed once, per-tile clips reuse) |
| d | cached network full pipeline + T-dominant histogram | HN | `src/gen/citynet/citynet.test.ts` (v3.1 junction histogram; v3.2 blocks/parcels) |
| e | walled-city payoff: wall+gates+ring+fields+bridge | HN | `citynet.test.ts` (v3.3 wall+gates, gate-d bridge, outskirts fields) |
| f | it paints (wall/gate/footprint qRF) | GL | rendered feature |
| g | screenshot (walled town) | GL·scaffold | screenshot |
| h | delete-the-shape drops region cache | HN | `MapController.test.ts` #8 (deletes shape + city, cache gone) |
| i | dev:errors clean | GL·scaffold | dev:errors |

eligible 4/9.

#### procgen43 (profile signatures + dead-code sweep) — 7 checks
| # | check | class | covers / reason |
|---|---|---|---|
| a | dead v2 generators gone + bundle-string sweep | GL | dead-code/bundle sweep (build artifact) |
| b | plugin loads, no errors | GL·scaffold | dev:errors |
| c | vespergate opens | GL·scaffold | open |
| d | four districts, one per profile, all inside | HN | `MapController.test.ts` #1 + `citynet.test.ts` profile smoke |
| e | profile signatures flip in cached networks | HN | `citynet.test.ts` (v3.4 profile signatures: na-grid 4-way≥T, na-suburb court, euro-continental no alley, euro-medieval wall+alley) |
| f | screenshot (four genres) | GL·scaffold | screenshot |
| g | dev:errors clean | GL·scaffold | dev:errors |

eligible 2/7.

#### styleLoad (013/014 blank-map regression guard) — 5 checks
| # | check | class | covers / reason |
|---|---|---|---|
| a | plugin loads, no errors | GL·scaffold | dev:errors |
| b | Ashfall (obsidian-native) style LOADS | GL | style-load engine (a schema-valid style can still fail to load — the whole point; `styleValidation.test.ts` covers schema-validity headless) |
| c | London (modern-clean + basemap) style loads | GL | style-load engine |
| d | Nightreach (neon-sprawl) style loads | GL | style-load engine |
| e | screenshot | GL·scaffold | screenshot |

eligible 0/5.

---

### Summary

| gate | total | HN | HC | GL (domain) | GL·scaffold | eligible (HN+HC) | eligible % |
|---|---|---|---|---|---|---|---|
| phase0 | 10 | 1 | 0 | 5 | 4 | 1 | 10% |
| phase1 | 16 | 3 | 5 | 4 | 4 | 8 | 50% |
| phase2 | 15 | 0 | 3 | 8 | 4 | 3 | 20% |
| phase3 | 14 | 4 | 1 | 5 | 4 | 5 | 36% |
| phase4 | 12 | 3 | 1 | 5 | 3 | 4 | 33% |
| phase5 | 9 | 0 | 1 | 6 | 2 | 1 | 11% |
| procgen40 | 11 | 5 | 0 | 2 | 4 | 5 | 45% |
| procgen41 | 17 | 9 | 1 | 1 | 6 | 10 | 59% |
| procgen42 | 9 | 4 | 0 | 1 | 4 | 4 | 44% |
| procgen43 | 7 | 2 | 0 | 1 | 4 | 2 | 29% |
| styleLoad | 5 | 0 | 0 | 3 | 2 | 0 | 0% |
| **TOTAL** | **125** | **31** | **12** | **41** | **41** | **43** | **34%** |

Three eligibility framings (all honest, denominators stated):
- **All-in**: 43 eligible / 125 total = **34%** — the robust headline, clearly
  short of 70%.
- **Domain-assertion** (exclude the 41 irreducible live-harness scaffolding rows —
  plugin-load/open/reload/dev:errors/screenshot — since those are the live shell
  every gate keeps and were never migration candidates): 43 / 84 = **51%**.
- **Targeted gates only** (the yes-and + procgen families the harness was built
  for: phase1, phase3, phase4, procgen40–43): 38 / 86 = **44%**.

**Counting-granularity sensitivity (important caveat):** rows are counted at
one-numbered-gate-check = one row. The HN-heavy logic rows each bundle *many*
sub-assertions (e.g. procgen42(d) = street/block/parcel/footprint/district
present + T>0 + T>X + alley; procgen43(e) = 4 profiles × 2–3 signatures;
phase3(f) = 5 feature kinds), while scaffolding rows are atomic (one screenshot =
one row). Splitting the bundled logic checks would inflate HN but not scaffolding:
the **all-in** figure rises to only ~45% (still clearly short), but the
**domain-only** figure rises to ~59–61%, and reaches **~70–72% if one also
reclassifies bundle-sweeps and theme-paint-*value* checks as HC** (both
defensible: a bundle grep is a plain fs Vitest; the theme-bg token is
`buildThemeStyle` output, already partly covered by `fabricLayers.test.ts` /
`styleValidation.test.ts`). So the domain-only reading sits *on the knife's edge*
of 70% and is methodology-dependent. The all-in reading is not — it is
unambiguously short. Conclusion below is framed to what is robust.

---

## 5. §4 findings

**F1 — a clean ≥70% headless-migration claim is NOT supported.** The robust
all-in figure is **34%** (43/125) — unambiguously short of 70%. The narrower
domain-only figure (excluding irreducible live scaffolding) is **51%**, rising to
a methodology-dependent **~70–72% only at finer counting granularity plus two
defensible reclassifications** (see the sensitivity caveat in §4). So the target
is missed on the robust reading and marginal-at-best on the most generous one —
either way the plan's clean "≥70% of live-gate assertions move headless" is not
demonstrably met. Reported straight rather than massaged. Why the gap:
- ~33% of live-gate "checks" (41/125) are irreducible live-harness scaffolding —
  `plugin loads` / `open map` / `survives reload` / `dev:errors clean` /
  `screenshot` — repeated across all 11 gates. They can never move headless;
  they *are* the live shell.
- The remaining GL·domain rows are dominated by genuinely-visual/engine work the
  plan itself lists as live: queryRenderedFeatures render checks (~8),
  paint/style-expression reads (~7), style-load-engine (~4), export pixels (2),
  frame timing (1), viewport wiring (4), bundle/dead-code sweeps (6).
- phase0 (skeleton), phase2 (basemap + theme paint), phase5 (export keepsakes)
  and styleLoad are structurally live (0–20% eligible) and were never the
  migration target.

**What the migration DID achieve (the important part):** the determinism /
containment / regen / undo / replay / migration *core* — where the afternoon-cost
actually lived — is now 15 fast `MapController.test.ts` tests running in ~15 s.
procgen41 (the primary edit-UX gate, previously the single slowest at 92 s) is
**59% eligible**, and its heavy checks (byte-identity, seed flip, params regen,
undo, constraint loop, center override, containment) are all HN today. procgen40
(45%), procgen42 (44%), phase1 (50%) similarly moved their substantive logic. The
harness delivered the *speed* win the plan wanted (inner loop 45s→17s, board
90min→6.6min); the 70% headcount was an over-estimate of how much of the
*assertion count* (as opposed to assertion *cost*) is non-visual.

**Recommendation for 022+:** the phase-brief's "born headless" guidance holds —
new algorithm/host-lifecycle assertions should be written as `MapController`/
`FakeHost` tests first, and each new live gate kept to the irreducible shell
(load → generate via test-API → one qRF render confirm → screenshot →
dev:errors). Do not retro-migrate the existing live gates just to chase the 70%
number; the eligible assertions that carry real cost are already headless.

**All other §4 bullets are MET** (inner loop, T1, full board wall-clock + boots +
one-command-one-report, determinism-break caught by both paths, fixture hygiene,
phase1 connections fix). See §1.

---

## 6. Verification of the 21-C agent's hand-off notes

Checked against the actual gate + test sources (not trusted blind):
- **CONFIRMED** — procgen41's determinism/center/reroll/params/undo/constraint/
  center-set-reset-reject checks and all of procgen43's profile-signature math read
  only controller state + `.mapcache` via the view's delegate test-API
  (`createRegionForTest`, `moveVertex`, `setRegionCenter`, `rerollRegion`,
  `regionContainmentReport`, `regionFeatureIds`, `generatorRunCount`,
  `networkStats`). These are HN/HC above. (Note: the brief's letter labels
  `(a)–(f),(h)` don't line up with the current script's lettering — I classified
  by assertion *content*, per the subagent enumeration, not the letters.)
- **CONFIRMED** — `streetBuckets` reads `loadedTiles`, which now lives
  controller-side (`MapController` owns `loadedTiles`), so headless twins compute
  buckets directly.
- **CONFIRMED** — genuinely-live remainder includes procgen41 pan/zoom wiring,
  the screenshots, dev:errors, and procgen43's bundle dead-code sweep + screenshot.
- **CORRECTION** — the brief listed procgen41 "layer minzoom" as part of the
  genuinely-live remainder. It is **HN**: `src/map/themes/fabricLayers.test.ts`
  already asserts NO fabric layer carries a minzoom (the Kanto ruling), which is
  exactly what procgen41's footprint/parcel minzoom==0 check verifies. Reading it
  off the live map is a live *mechanism*, but the invariant is already fast-tier
  covered — classing it live would under-count. (The `generated-footprint` z14
  minzoom flagged in PROGRESS "open threads" was removed per the 2026-07-12 LOD
  ruling, consistent with the test.)

---

## 7. Notes for DECISIONS.md (judgment calls)

- **Injection salt + tripwire**: flipping the FNV offset-basis in
  `hashSeed` (`src/gen/rng.ts:18`) is caught by the fast tier via
  `corridor.test.ts` absolute snapshots only (self-relative determinism tests
  survive a uniform salt shift; `sigil` snapshots don't route through hashSeed).
  The determinism tripwire in the *fast* tier is therefore narrow — the corridor
  golden. Change-scoped gating independently escalates any `src/gen/rng.ts` edit
  to the full board. Both paths hold; the fast-tier catch is the faster of the two.
- **§4 70% target: clean claim NOT supported (finding F1)**: 34% all-in
  (robust), 51% domain-only, ~70–72% only at the most generous granularity +
  reclassification — knife's-edge and methodology-dependent. Not a defect in the
  harness — the speed goals were all met — but the assertion-*count* migration
  ceiling is lower than §2.4 estimated, because a third of live-gate checks are
  irreducible live scaffolding and the rest are dominated by genuinely-visual
  concerns. Recommend NOT retro-migrating existing gates; keep the "born
  headless" rule for 022+.
