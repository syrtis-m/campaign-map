# Progress

*Updated after every gate run. A fresh session should be able to resume from CLAUDE.md + this file alone.*

## Status: plans 021–025 arc IN PROGRESS (HEARTBEAT.md is the run's source of truth — resume there). Plan 020 (procgen v4.3) complete.

## Plans 021–025 arc (2026-07-12, reverse-chronological)
- **21-A DONE** (`4adb2eb`): fast tier `npm test` = 314 tests / ~14 s (fuzz
  describes split to `*.fuzz.test.ts`, `npm run test:fuzz` = 2/~73 s;
  314+2=316 partition proven); `scripts/gates/coverage.json` +
  `scripts/changed-gates.ts` (`npm run gates:changed`, escalates
  rng/region/clip/tileCache → full board, ref in `.lastgreenboard`);
  T0–T3 tier docs in docs/05+06; phase1 gate now uses `__GateConnectSource`/
  `__GateQuickAdd` temp notes — 16/16 with dev-vault byte-clean; injected
  hashSeed-salt break caught RED by fast tier.
- **21-B DONE** (`5030d88`): `scripts/board.ts` — one-process board runner
  (`npm run board`, `--changed`, `--gates=`, `--probe-fail-at=N`); post-gate
  probe attribution (unhealthy post-probe → untrusted result → relaunch +
  re-run capped 3; healthy + fail → genuine RED); per-gate dev-vault hygiene
  assertion w/ auto-restore; report → `shots/board-report.md`.
  `scripts/rendererSoak.ts` investigation harness: GL-leak REFUTED (50
  reload/open/screenshot cycles, canvas count flat 1, styleLoaded true, idle
  ~270 ms stable); catastrophic degradation not reproduced; best hypothesis =
  GPU/driver memory pressure across heavy generation gates; evidence in
  `review/021B-renderer-degradation.md`; fresh-process rule NOT retired.
- **Interlude (2026-07-13, `9548aec`)**: board/CLI hardening from the killed
  session finished + committed — SIGKILL on timeout (gate cap 10 min in
  board.ts, 30 s per CLI call in cli.ts; a lost-IPC-reply CLI call ignores
  SIGTERM and wedged a board 20+ min) + phase5 Exports/ hygiene (snapshot
  baseline, remove only gate-created files). Validated by a full board:
  **15/15 in 341 s, 0 relaunches, dev-vault byte-clean** — this is 21-C's
  "before" board; `.lastgreenboard` → 9548aec.
- **21-C DONE** (`62660d3`): host-agnostic `src/controller/MapController.ts`
  (~1560 ln — generation/regen/clear/undo/replay orchestration behind narrow
  host interfaces: vault adapter, notice sink, render sink; no Obsidian
  imports) extracted from MapView (now wiring + paint, −1550 ln);
  `FakeHost.ts` in-memory host double; `MapController.test.ts` 15 headless
  integration tests in the fast tier (now 329/329, ~15 s). Gate test-API
  methods stay exposed on the view as controller delegates. ZERO behavior
  change proven: full board 15/15 (395.9 s, 0 relaunches) before AND after;
  the interrupted session's 13/15 (procgen41/43) did NOT reproduce on the
  unmodified tree — environment flakiness, zero fix-edits (see DECISIONS
  2026-07-13). `.lastgreenboard` → 62660d3.
- **21-D DONE** (`4369db6`) — **PLAN 021 COMPLETE**: §4 acceptance proven —
  inner loop 17 s (<45 s), T1 ~3.1 min (<5 min), full board 6.6 min (<15 min,
  0 relaunches); rng.ts FNV-salt injection caught RED in 15 s by corridor
  golden snapshots AND independently escalated to full board by
  `gates:changed`; reverted byte-clean, 329/329 green.
  `review/021D-assertion-migration.md`: 125 assertions / 11 gates → 31
  headless-now + 12 headless-candidate + 82 genuinely-live; §2.4's ≥70%
  headless target NOT cleanly met (34% all-in / 51% domain — F1, flagged for
  Jonah in HEARTBEAT §Questions); decision: no retro-migration, 022+ tests
  born headless.
- **22-A DONE** (`5d7742e`): registry `presets`/`defaultPresetId` +
  `presetById`/`matchingPresetId` helpers; four city profiles → presets
  (`CITY_PRESETS`, id === profile id); optional display-only
  `procgen.presetId` (city never persists it — new blocks byte-identical to
  Vespergate's `{profile}` shape); Template dropdown in RegionProcgenModal +
  selection panel ("Custom (from …)" when params diverge);
  `setRegionPreset` controller twin (full commit path, center survives
  template swap). Legacy no-presetId blocks validate + regen byte-identical
  (headless test). Board 14/14 changed-scope (all 11 live gates), 269 s, 0
  relaunches · fast 338 · fuzz 2/2 · review/v4.4-preset-dropdown.png.
- **22-B DONE** (`4e6d981`): line-kind (spine) procgen + the RIVER
  generator. `makeSpine`/`makeCorridorRegion`/`distanceToSpine`/
  `validateSpineLine` in region.ts (corridor containment via the same
  signed `distanceToBoundary` convention); `src/gen/river.ts` — position-
  keyed PER-SEGMENT meander (sin² envelope, C1 at joins — a vertex edit
  re-meanders only adjacent segments), braiding with lens islands,
  `braidBias` carries delta's toward-the-mouth behavior (params are the
  whole truth), `riverMaxOffset` = pure f(params) exposed via registry
  `corridorMaxOffset`; 4 presets (lazy-lowland / mountain-torrent / canal /
  delta); per-sample quads w/ position-hashed integer ids; theme paint
  `generated-river-channel`/`-island` + all-themes coverage test;
  kind-aware `validateForProcgen` (spines MAY cross — tributaries legal,
  junction hydrology a logged v1 limitation); `createSpineForTest` headless
  twin; spine regions generate on the main thread (worker protocol is
  ring-only — logged deviation); phase5 style-load assertion now polls
  (pre-existing flaky caught + fixed); modal copy de-citified. Gate: fast
  374/374 · fuzz 4/4 · tsc+build · procgen44 16 checks PASS in two full
  boards (34.2/35.0 s) · two disjoint board env-flakes (phase0, procgen41)
  both green standalone (10/10, 16/16) — see the 2026-07-13 board-cadence
  DECISIONS entry · dev-vault byte-clean ·
  review/v4.5-river-windy-braided.png + v4.5-river-canal.png.
- **PROTOCOL (Jonah live, 2026-07-13): full board ONCE per plan (⛳ boxes);
  per-phase commits gate on T1 (fast+tsc+build+own gate standalone). See
  DECISIONS + docs/05 §Test tiers.**
- **22-B follow-ups (Jonah live)**: sharp bends → global centerline (join
  gaps/normal mismatch killed) + windiness-scaled corner fillets (canal keeps
  crisp corners; corridor stays pure f(params)); procgen rivers no longer
  double-paint the raw spine line (opacity keyed on `procgen`, selection
  kept via corridor-exact fallback `spineRegionIdAtDisplayPoint`); panel
  button "Remove city"→"Remove", city Center hint gated off line kinds.
  Golden deliberately updated. Gate: fast 374/374 · river fuzz 2/2 · build ·
  procgen44 12/12 (locality 71.7% vs re-roll 34.3%) · live check (fallback,
  button, style expr, dev:errors) · screenshots re-eyeballed · dev-vault
  byte-clean. See DECISIONS "22-B follow-ups".
- Next: 22-C FOREST (new kind, masked-noise canopy w/ interiorT fallback,
  theme paint in ALL themes).

## (pre-arc) Status: Phases 0–5 complete + Phase 6 (sketch) + post-launch corrections. On `main` @ `3e084ea`.

### Recent work (2026-07-10) — reverse-chronological, all merged to `main`
- **Fabric always visible; LOD only hides location names** (`3e084ea`, Jonah's decision after the Kanto test). Removed all per-kind fabric `minzoom` + `applyFabricReveal` + the dead `DEFAULT_FABRIC_MINZOOM`/`FABRIC_REVEAL_OFFSET`. The depth-of-field *label* system stays (names reveal by zoom); dots always on. Two non-fabric minzooms left in place + flagged: `generated-footprint` and basemap buildings (z14). See DECISIONS 2026-07-10.
- **Kanto test overworld** (`dev-vault/Campaigns/Kanto`) — a Pokémon-style region sketched with the fabric tools at real metric scale (1 unit = 150 m); built to test zoom/LOD. Surfaced that the procedural world generator auto-fills a hand-sketched fictional campaign with settlements/routes → led to **plan 019** (two-layer model: background vs. Locations, delete canonization, explicit-only generation) — TODO, Jonah shaping it.
- **Fabric LOD relative-to-overview fix** (`331362c`) — later superseded by the always-visible decision above.
- **Corrections batch 015–018** (all merged, live-verified): 015 explicit `visibility: wide/mid/close` field decoupled from `type` (QuickAdd + place-card pickers); 016 sketch-mode UX (reliable exit + pencil active-state, immediate render, undo, auto-elaborate on commit); 017 distinct per-kind fabric colors across all 5 themes (**Fable**); 018 toolbar decluttered (generate/canonize/export → settings modal).
- **Depth-of-field LOD** (`70fb361`) — 3 per-campaign focus levels (Wide/Mid/Close from overview zoom) + `+`/`−` snap stepper; superseded the per-type continuous zoom ranges. `importance` still drives label size + collision.
- **Gate hardening** (`d627bb8`) — live `isStyleLoaded()` gate (`scripts/gates/styleLoad.ts`) + static `validateStyleMin` over every theme (`styleValidation.test.ts`), closing the "green npm test but blank map" gap.
- **User-facing README 101** — rewrote `README.md` as the product doc (GM + agents).
- Branch/worktree cleanup: repo is back to a single `main`.

### Open threads (not blocking)
- **Plan 019** (two-layer background-vs-Locations model) — TODO, Jonah shaping.
- Whether the two z14 building minzooms (generated-footprint, basemap) should also become always-visible.
- Poster PNG output still not eyeballed; per-type location icons still reverted (006).
- Renderer degrades over a long CLI session (styles stop loading, `idle` stops firing) — only a full Obsidian process restart clears it; `plugin:reload`/`app:reload` do not.

## Procgen v3 rewrite (2026-07-11, IN PROGRESS — procgen_v3_design.md)

Replacing city-tier streamline/Voronoi generators with a city-scoped deterministic
growth pipeline (domains → skeleton → growth → faces/parcels). Executing per the
design doc's phases; state here + DECISIONS.md 2026-07-11.

### v3.0 — domains + skeleton (DONE, gate green: `npx tsx scripts/gates/procgen30.ts` → 13/13)
- [x] Manifest schema: `CityDomainSchema`, `domains[]` (default []), `entries[].domainId`
      (optional) — pre-v3 Generated.json parses unchanged; per-domain salvage; 12 unit tests.
- [x] `src/gen/citynet/` (Opus subagent): domain.ts (30 m lattice, position-keyed citySeed),
      profiles.ts (all 4 §6 profiles), costField.ts (10 m lattice: slope/water/bridge/canon),
      skeleton.ts (A* arterials, bridges, waterfront quays, plaza+landmarks), index.ts
      (generateCityNetwork + clipNetworkToTile). 12/12 green.
- [x] `generationService.generateDomainTile`: network record cache-or-compute at the domain
      anchor cell, per-tile clip records (`city-street`/`city-landmark`), preloadedCache for
      O(1-file-read) replay. 4 unit tests incl. delete-cache byte-determinism.
- [x] Worker `city-network` job + `workerClient.generateNetwork`.
- [x] MapView: domain resolve-or-create on city-tier generate (DomainProfileModal;
      `opts.domainChoice` = headless path for gates), replay grouped by domainId,
      regenerate/clear/auto-regen domain-aware, "Clear city domain here" menu item,
      clear-all clears domains. KEY COLLISION FIX: legacy `city-street` excluded on domain
      tiles (see DECISIONS.md — two writers on one cache key = nondeterminism).
- [x] `generated-landmark` layer + roadClass width ramps (arterial/ring/alley/court).
- [x] Gate script `scripts/gates/procgen30.ts` (unit gates + live: domain founding, manifest
      persistence, cache records, render, cache-delete determinism, explicit-only, clear-domain,
      Vespergate bridge-over-river check, review/ screenshot).
- [x] citynet unit suite green (12/12; full suite 262/262)
- [x] `npx tsx scripts/gates/procgen30.ts` → 13/13 live (incl. delete-cache byte-determinism,
      Vespergate bridge-over-river, explicit-only under pan/zoom). Two real gate-harness
      findings fixed en route: (1) Obsidian's `delete` command can't resolve dot-folder files
      (.mapcache isn't vault-indexed) — gates rmSync instead, truest "GM deletes .mapcache"
      simulation anyway; (2) queryRenderedFeatures needs the window fronted first (macOS
      occluded-window compositing, the Phase-4 dev:screenshot gap resurfacing in a new check).
- [x] Screenshot reviewed (review/006 + review/v3.0-vespergate-skeleton.png): radial spokes,
      discrete river crossings, quays — town reads as shaped. Tier-B questions queued.
- [x] committed

### v3.1 — growth loop, euro-medieval (DONE, gate green: `npx tsx scripts/gates/procgen31.ts` → 11/11)
- [x] `graph.ts` (1 cm int-lattice planar graph, exact int predicates, spatial hash),
      `growth.ts` (P&M total-ordered heap, snap/cut/trim local constraints, tensor prior +
      fabricAngleSampler blend, sketched-road pre-seed as immutable edges, bounded prune),
      `cityness.ts` (v3.1-minimal falloff×noise). Opus subagent; contract held.
- [x] Vitest gates: byte-determinism w/ growth, 2×2 seam, junction histogram (918 T vs 484 X),
      dangling <0.15, **200-domain fuzz zero-throw (~94 ms/domain)**, budget (≤2 s; measured ~87 ms
      at radius 900 — lazy cost field made v3.1 16× faster than v3.0''s skeleton alone). 267 tests.
- [x] Live gate 11/11: dense growth through worker+cache+paint (297 street parts in the clicked
      tile), live junction histogram from the cached network record, delete-cache replay
      byte-identical, explicit-only, clear-domain. Screenshots reviewed (review/007): real organic
      warren; density asymmetry across the river flagged as a Tier-B question for v3.3.
- [x] committed

### v3.2 — faces → parcels → footprints + wards (DONE, gate green: `npx tsx scripts/gates/procgen32.ts` → 12/12)
- [x] `faces.ts` (half-edge extraction, int shoelace, degenerates counted never thrown),
      `parcels.ts` (OBB lot recursion, frontage-facing footprints), `wards.ts` (ward-scale
      Voronoi, market/craft/temple/slum tags); full skeleton/sketch planarization closed the
      v3.1 planarity leak. 272 unit tests; 953 blocks / 6289 parcels / 5553 footprints at
      radius 900 in ~160 ms; quad share 63% (<70% gate); fuzz 33 s zero-throw; artifact 3.96 MB.
- [x] Legacy city-district/city-block cut off on domain tiles (all three legacy ids superseded);
      wards inherit the district paint layer by reusing its generatorId.
- [x] **One click = whole city**: founding a domain generates every tile the disc overlaps
      (shared single network compute); painting only the clicked tile read as a bug on screen.
- [x] Footprint/parcel reveal made relative to campaign overview (absolute z14/z15 never
      reached on fictional campaigns — the documented absolute-vs-relative zoom trap).
- [x] Live gate 12/12 incl. "exactly 0 generator executions for a clip-only neighbor tile"
      (proves the legacy cutoff + network reuse) and delete-cache byte-determinism with Stage C.
      Screenshots reviewed (review/008): full-disc city, genre readable in 3 s.
- [x] committed

### v3.3 — cityness, outskirts, walls/gates, landmarks (DONE, gate green: `npx tsx scripts/gates/procgen33.ts` → 11/11)
- [x] cityness completed (§5.4: canon-Location bumps — "the city grows around the GM's pins" —
      + snap-distance and parcel-minArea modulation); walls/gates (closed ring through 5
      arterial-snapped gates, wall band omitted at gates/water, grown streets breach only at
      gates); outskirts (`outskirts.ts`: ribbon cottages along arterials past the growth extent,
      lateral farm-field quads); ward "gate" tag; landmark variety (temple/keep). 279 tests.
- [x] Density bands monotonic (0.0548→0.0027 across 6 rings); pipeline ~198 ms; fuzz 34 s
      zero-throw with walls+outskirts on.
- [x] Paint: wall shares the sketched-wall stone token, gate dots, farm-field wash
      (`generated-gate` layer + landmark fill extended). styleValidation/layerOrder green.
- [x] Live gate 11/11 (wall+gates render, replay byte-identical, explicit-only, clear-domain).
      Screenshots reviewed (review/009): generated wall hugs the dense core inside the sketched
      city wall; questions queued for Jonah (double-wall rule, gate presence, field wash).
- [x] committed

### v3.4 — remaining profiles + cleanup + docs (DONE, gate green: `npx tsx scripts/gates/procgen34.ts` → 12/12)
- [x] Profile signatures: na-grid quadrant grids w/ jogs (4-way ≥ T: 338 vs 255), na-suburb
      cul-de-sacs + 185 court bulbs + loops, alleys (euro-medieval 63 / na-grid 26,
      connect-or-discard), euro-continental verified. All ≤ ~200 ms per city; 4-profile fuzz
      (200 domains) zero-throw ~25 s; quad share 61.7%.
- [x] Dead v2 code DELETED (districts/blocks/streamline streets + tests); survivors per §5.5
      (tensorField prior, corridor elaboration, fabricConstraints, voronoiCells). City tier is
      domain-only; pre-v3 city entries render from cache with a migration Notice on miss.
- [x] `procgen_explainer.md` rewritten for the v3 reality (subagent, in-voice).
- [x] Ward sketched-district exclusion restored ("you've claimed that ground").
- [x] TWO REAL BUGS found by the final sweep and fixed (see DECISIONS 2026-07-11 v3.4):
      generateTierAt render-store array aliasing (domain features double-painted into the
      legacy tile entry) and a latent-since-019 appendCachedTile write race that clobbered
      records on a freshly deleted cache file (the delete-.mapcache determinism scenario).
- [x] phase3 + phase4 gates modernized (they tested pre-019 canonize/dispatcher machinery).
- [x] **Final board all green (fresh process per gate)**: 276/276 unit · phase0 10/10 ·
      phase1 16/16 · phase2 15/15 · phase3 13/13 · phase4 11/11 · phase5 8/8 · styleLoad 5/5 ·
      procgen30–34 13/13 · 11/11 · 12/12 · 11/11 · 12/12 · test:app 8/8. Four-profile
      screenshots reviewed (review/v3.4-*.png): four visibly distinct genres side by side.
- [x] committed

**Procgen v3 rewrite COMPLETE.** The streamline "fur" is deleted; city fabric is a
city-scoped deterministic growth pipeline (domains → cost-field skeleton → int-lattice
P&M growth → faces → OBB parcels → frontage footprints → wards/walls/gates/outskirts),
clipped through the unchanged tile cache, explicit-only, byte-deterministic under cache
deletion, seam-safe by construction, ~200 ms per city in the worker.

## Environment (done)
- [x] `scripts/preflight.sh` written and green (Obsidian 1.12.7 running, `dev-vault` registered + CLI-reachable, restricted mode off, Node v22.14.0 installed locally, git repo initialized, GitHub remote `syrtis-m/campaign-map` created)
- [x] `.claude/skills/maplibre-agent-skills` and `.claude/skills/obsidian-skills` vendored (not submodules — `.git` stripped, tracked as plain files)

## Phase 0 — plugin skeleton + two spikes (DONE, gate green: `npx tsx scripts/gates/phase0.ts` → 10/10)
- [x] TS + esbuild scaffold; `npm run build` runs `tsc --noEmit` first (esbuild alone does not type-check)
- [x] dev-vault hot-reload wiring; MapLibre + our CSS bundled into styles.css
- [x] `ItemView` map tab + ribbon icon + `campaign-map:open-map` command
- [x] Spike A: MapLibre renders in the ItemView, survives split/reload
- [x] Spike B: fictional CRS + custom Google-Maps-style scale bar
- [x] Campaign config note (`*.map.md`, Zod-validated) parsing + per-campaign open commands
- [x] Three dev-vault test campaigns: Ashfall (fantasy), London (real-city), Nightreach (neon-sprawl)
- [x] `scripts/gates/phase0.ts` — 10/10; unit tests 15/15

## Phase 1 — yes-and core, vault-native (DONE, gate green: `npx tsx scripts/gates/phase1.ts` → 13/13)
- [x] Location-note model (`src/model/locationNote.ts`): Zod frontmatter schema, pinned type-taxonomy table (importance + auto zoom-range per docs/06 §3), point or sidecar-geojson geometry
- [x] Notes ⇄ map reconciliation (`src/main.ts`): vault/metadataCache watchers → 50ms-debounced full rescan → per-campaign `LocationIndex` (flatbush-backed, `src/map/locationIndex.ts`) → GeoJSON source `setData`; bad frontmatter never silently dropped — Notice + a visible `.campaign-map-warning-badge` in the view, note left untouched
- [x] `obsidian-native` theme (`src/map/theme.ts`): MapLibre style generated from live Obsidian CSS variables (`--background-primary`, `--interactive-accent`, `--text-normal`, ...), rebuilt on the `css-change` workspace event; canon-point circle layer (radius by importance) + canon-label symbol layer (size by importance, `symbol-sort-key` for collision priority, zoom-range filter expression) using **real glyph-backed text** (see font decision below) — not a DOM label hack
- [x] Google-Maps interaction grammar (`src/view/MapView.ts`): click pin → place card popup (Obsidian `MarkdownRenderer`-rendered note preview + Open/Edit/Center actions); click empty map → dropped-pin tooltip → "+ Add location here" → `QuickAddModal` (name + 3 seeded culture-consistent suggestions + type dropdown) → note created; right-click → native `Menu` (Add location here / Copy coordinates) — **implemented but CLI-unverifiable**, see DECISIONS.md; hover → name tooltip; drag pin (mousedown-threshold + live GeoJSON mutation during drag) → `processFrontMatter` geometry update, both quick-add-create and drag-move logged to the mutation log
- [x] Naming cultures (`src/gen/naming/`): seeded deterministic generator (mulberry32) + 3 profiles (`fantasy-brackish`, `modern-anglo`, `neon-corpo` per docs/06 §3) — Phase 1 stub (one culture per campaign via `crs`/`theme`); full per-region cultures are Phase 3a
- [x] Map search (`LocationSearchModal`, quick-switcher-style) + flyTo + a DOM-marker pulse-ring animation on arrival
- [x] Mutation log (`src/model/mutationLog.ts`): append-only JSONL at `<campaign>/.mapcache/log.jsonl` for map-originated writes (quick-add create, drag-move) via the Vault adapter (`append`/`write`/`mkdir` — no Node `fs`); `undo-last-map-edit` command (basic — reverses the single last entry, doesn't yet support redo or multi-step undo, see DECISIONS.md)
- [x] Wikilink completion: **free** — location notes are ordinary notes, Obsidian's own link autocomplete already suggests them (this is the whole point of "canon = notes")
- [x] `scripts/gates/phase1.ts` — 13 automated checks: reconcile (create/rename/delete → index within 500ms), bad-frontmatter warning without drop, scripted quick-add path <5s, **0 label collisions at z4/8/12/16** (queryRenderedFeatures bbox overlap), theme-follow, mutation log written, survives full reload, screenshot
- [x] Unit tests added: `src/model/locationNote.test.ts`, `src/gen/naming/culture.test.ts` — `npm test` → 27/27 passing
- [x] Seeded 2 locations each into London/Nightreach (previously empty) for visual richness alongside Ashfall's 4

### Notable engineering calls this phase (full detail in DECISIONS.md)
- **Pulled Inter glyph-PBF generation forward from Phase 2.** MapLibre GL JS has no local/system-font rendering for non-CJK text — symbol layers need real SDF glyph PBFs, full stop. Rather than fake labels with a DOM overlay (which would forfeit MapLibre's built-in label-collision engine, the actual mechanism the Tier A "0 overlaps" assertion is testing), generated Inter Regular/Bold glyphs now via `fontnik` (prebuilt binary, no toolchain needed) from the official `rsms/inter` release. `npm run fonts:build`; gitignored, regenerate on demand. This is exactly Phase 2's planned asset pipeline, exercised one phase early and scoped to the one font `obsidian-native` needed anyway.
- **Removed a redundant `ResizeObserver`** that was fighting MapLibre's own built-in one (both on the same container) and intermittently tripping the browser's "loop completed with undelivered notifications" warning — a real `dev:errors` blocker. MapLibre's own `trackResize` already handles this.
- **Themed MapLibre's default Popup chrome** (`.maplibregl-popup-content` etc.) from Obsidian CSS variables — out of the box it's a plain white card that clashes hard with dark themes.
- Right-click context menu is implemented with standard Obsidian `Menu` API but **could not be verified via the CLI** after 5 distinct attempts (direct `map.fire`, canvas `dispatchEvent`, debug-console capture, DOM diffing, `defaultPrevented` check — all confirm the handler runs correctly, but `Menu.showAtPosition()` produces no visible DOM under CLI-driven automation, most likely an OS-focus/trust gate in Obsidian's Menu component that synthetic Electron events don't satisfy). Per docs/06 §5 retry policy, logged and routed around rather than blocking — the equivalent "add location" flow is already verified via the click-empty→dropped-pin→quick-add path.

## Phase 2 — real cities + themes (DONE, gate green: `npx tsx scripts/gates/phase2.ts` → 15/15)
- [x] Vault-backed PMTiles protocol (`src/map/pmtilesVaultProtocol.ts`): `VaultPMTilesSource` implements the `pmtiles` library's `Source` interface over `app.vault.adapter.readBinary` (whole-file cache, sliced per request — see DECISIONS.md for why this still satisfies "byte-range reads" without a true partial-read primitive); registers with MapLibre's standard `pmtiles://` protocol via `Protocol.add()`, keyed by vault path — no fully-custom MapLibre protocol scheme needed
- [x] Real basemap fetched: central-London Protomaps extract (18MB, z0-15, OSM+Natural Earth, `pmtiles extract` — see DECISIONS.md for the CLI-binary confirmation) at `dev-vault/Campaigns/London/basemap.pmtiles` (gitignored, regenerate via the command in DECISIONS.md), referenced from `London.map.md`'s `basemap:` frontmatter field
- [x] Four handcrafted themes (`src/map/themes/`): `tokens.ts` (exact pinned colors/fonts, docs/06 §3), `basemapLayers.ts` (Protomaps "basemap" schema — earth/water/landuse/roads/buildings/places — themed per campaign, road-major casing gives `modern-clean` its Google-Maps gold outline and `neon-sprawl` its cyan glow via opacity+blur), `canonLayers.ts` (shared circle+label layers, extracted from Phase 1's obsidian-native so canon rendering is byte-identical across all 5 themes — quality-bar F2 provenance invisibility)
- [x] Fonts for all 4 themes fetched + glyph-PBFs built: Alegreya/Cormorant SC (parchment), IBM Plex Serif/Oswald (ink-soot), Rajdhani/Saira Condensed (neon-sprawl) — modern-clean reuses Inter. `scripts/fetch-fonts.sh` + `scripts/build-glyphs.mjs` extended from Phase 1's Inter-only manifest
- [x] Theme switcher: `switch-campaign-theme` command → `ThemeSwitcherModal` → writes `theme:` frontmatter via `processFrontMatter`; `main.ts`'s rescan now diffs campaign config (not just locations) and pushes live updates into open `MapView`s, which rebuild their style only when theme/basemap actually changed (cheap identity check — ordinary location-only rescans don't thrash the map)
- [x] `obsidian-native` also gained basemap support (real-city campaigns default to it, same as fictional ones) — refactored to share `canonLayers`/`basemapLayers` with the handcrafted themes instead of duplicating layer definitions
- [x] Real-CRS campaigns get MapLibre's native `ScaleControl` (true Mercator meters); fictional campaigns keep Phase 1's custom scale bar; `applyCampaign()` now fits bounds from the PMTiles header (`vaultBasemapBounds`) for real campaigns instead of a fixed box
- [x] **Found and fixed a real regression bug**: locations weren't indexed on cold plugin load/app reload — only `rescanCampaigns()` ran from `onLayoutReady`, `rescanLocations()` only ran on subsequent vault-event callbacks. Phase 1's gate didn't catch it because "survives full reload" only checked `dev:errors`, not that data was actually still there. Now `onLayoutReady` calls `rescanAll()`; Phase 2's gate adds an explicit regression check for this.
- [x] `scripts/gates/phase2.ts` — 15 automated checks including a live pmtiles-protocol render check (`queryRenderedFeatures` on `basemap-earth`), canon-over-basemap rendering, native scale control presence, all 4 theme backgrounds matching pinned tokens exactly, the reload regression check, full-reload-with-basemap survival
- [x] Re-ran Phase 0 (10/10) and Phase 1 (13/13) gates after all Phase 2 changes — no regressions
- [x] Visually verified all 5 themes live via CLI theme-switching on the same campaign (screenshots taken, not all committed — see below)

### Notable engineering calls this phase (full detail in DECISIONS.md)
- **Downloaded and ran the go-pmtiles CLI binary** to cut the London extract — stopped and confirmed with Jonah first, since executing a compiled binary I found via my own research (not named by him) is a meaningfully different risk than fetching inert data files.
- **VaultPMTilesSource caches the whole local file in memory** rather than doing true OS-level partial reads, because Obsidian's DataAdapter has no partial-read primitive. There's no bandwidth cost to save on a local disk file the way there would be over HTTP, so this preserves the intent of "byte-range reads" (format-correct, logical range access via the `pmtiles` library's `Source` interface) without needing a capability Obsidian doesn't expose.
- **Alegreya and Oswald are variable fonts** with no separate static Bold cut published upstream — generated glyphs from their default-weight instance only; "bold" labels in `parchment`/`ink-soot` are approximated with size, not true font-weight switching. Documented as a deferred refinement, not a blocker.

## Phase 3 — procedural generation (DONE, gate green: `npx tsx scripts/gates/phase3.ts` → 11/11)
- [x] **Deterministic seeding foundation** (`src/gen/spatialHash.ts`): the textbook algorithms for this phase (adaptive streamline seeding, Bridson Poisson-disc, MST route networks) are all order/global-coupling-dependent and would break the Tier A determinism/seam gate. Built every generator on `jitteredGridPoints()` instead — a coarse world-space grid where each cell independently hashes to zero-or-one jittered point via `hash(campaignSeed, cellX, cellY, salt)`. Callers generate over a halo-padded bbox (`expandBBox`) so a feature straddling a tile edge is computed identically by both neighboring tiles. Shared clipping (`src/gen/clip.ts`: hand-rolled Liang-Barsky for lines, Sutherland-Hodgman for polygons) gives exact matching endpoints at shared tile edges. Full rationale + the halo-sizing bug caught mid-build in DECISIONS.md.
- [x] **3b City gen** (`src/gen/city/`): tensor-field streets (RK4-traced streamlines along a field that's a pure function of world coords + the campaign's *fixed* worldBounds, never the tile bbox) → Voronoi districts (`d3-delaunay`, via the shared `src/gen/voronoiCells.ts`) → block subdivision (recursive polygon bisection, min-area 400m² per docs/06 §3) → footprints. Canon locations repel street seeding (never overwritten).
- [x] **3c World gen** (`src/gen/world/`): jittered-grid Poisson-substitute → Voronoi regions → seeded value-noise heightmap + moisture (with continental falloff toward campaign-bounds center, Azgaar "island template" lineage) → biome classification → independent-per-site settlement suitability roll (pre-named via region-based naming culture) → k-nearest-neighbor route connections (not a true MST — global coupling would break seams, logged as Tier B in DECISIONS.md).
- [x] **3a Naming + sigils**: naming cultures as regions (docs/04 F5, Azgaar's model) — `src/gen/naming/regions.ts`'s `cultureAt()` assigns culture territory via nearest-seeded-culture-center (pure function of position, no BFS/flood-fill coupling). 3 new cultures (`fantasy-sunlit`, `modern-mediterranean`, `neon-street`) give each genre regional variety alongside Phase 1's three. Seeded SVG sigil generator (`src/gen/sigil/`, snapshot-tested) for the mid location-art tier (docs/02 §4).
- [x] **3d Canonization + stitching**: `.mapcache/generated.jsonl` log-structured tile cache (`src/model/tileCache.ts`, mirrors `mutationLog.ts`'s append-only pattern) keyed by `hash(campaignSeed, tileX, tileY, zoom, generatorId)`. `src/map/generation/generationService.ts` wires cache-or-generate / force-regenerate / canonize (create the note — plain point note or note + sidecar `.geojson` for lines/polygons — then strip the feature from its cached tile, never touching other canon). MapView commands (`generate-city-here`, `regenerate-city-here`, `generate-world-here`, `regenerate-world-here`, `canonize-nearest-generated`) drive this live; generated fabric renders through its own theme-aware layers (`src/map/themes/generatedLayers.ts`) sharing canon's exact point/label recipe for settlements — provenance stays invisible per quality-bar F2.
- [x] **Web Worker** (`src/gen/worker/generationWorker.ts` + `src/map/generation/workerClient.ts`): built, esbuild's second entry point, loaded via a Blob URL (sidesteps Electron-renderer origin/CSP friction with `new Worker(file://...)`). Verified live: output byte-identical to the same generator called directly on the main thread. **Scope call**: not yet wired into the live generate/canonize/regenerate commands — those stay on the tested synchronous path; Phase 4's continuous-pan LOD dispatcher is where worker-based stutter prevention actually matters and is the natural integration point. Full rationale in DECISIONS.md.
- [x] `scripts/gates/phase3.ts` — 11 checks: generate-city-here/generate-world-here produce all expected feature types, generated fabric renders alongside canon through provenance-invisible layers, **cache-delete + regenerate produces hash-identical output** (docs/06 §2's canonical determinism assertion, verified live against the real `.mapcache/generated.jsonl` file, not just the pure-function unit tests), the full canonize flow (note created, stripped from cache, joins the canon index), regenerate-after-canonize (canon survives, surroundings adapt), full reload survival, screenshot
- [x] 22 new unit tests: `src/gen/city/{city,districts}.test.ts` (10, incl. 2×2 seam tests), `src/gen/world/world.test.ts` (7, incl. seam tests), `src/gen/naming/regions.test.ts` (4), `src/gen/sigil/sigil.test.ts` (7, snapshot fixtures), `src/map/generation/generationService.test.ts` (5) — `npm test` → 60/60 passing
- [x] Re-ran Phase 0 (10/10), Phase 1 (13/13), Phase 2 (15/15) gates after every Phase 3 milestone — no regressions at any point (49/49 total across all four gates)

### Notable engineering calls this phase (full detail in DECISIONS.md)
- **Position-deterministic seeding over classic order-dependent algorithms** — the single architectural decision the whole phase rests on; see DECISIONS.md for the full writeup including the halo-sizing bug it caught mid-build (a too-small halo let the halo bbox's own clip rectangle leak into Voronoi cell shapes near tile edges, differing between two tiles whose halo rectangles aren't the same shape — fixed by widening to `cellSize * 8`).
- **Found and fixed a real scale bug**: generators are tuned in meters (docs/06 §3 ranges), but fictional campaigns store coordinates in fake units where 1 unit = `scaleMetersPerUnit` meters. Without a conversion boundary, a single generation tile (600m) would dwarf an entire small campaign (Ashfall is ~800m×600m). Added `unitsToMeters`/`metersToUnits` conversion in `MapView`'s generation methods — `generationContext()` converts worldBounds/canonFeatures into generation-space (meters), results convert back to display-space (fictional units) before rendering, and canonized notes get display-space geometry while cache lookups stay in generation-space.
- **Settlement placement is intentionally not spacing-aware** (independent per-region-site roll rather than greedy placement with minimum distance) — a spacing-aware pass would be order-dependent and break the seam guarantee. May occasionally cluster; flagged as Tier B tuning, not a Tier A blocker.
- **`Fairenford`** (`dev-vault/Campaigns/Ashfall/Locations/Fairenford.md`) is a real generated-then-canonized settlement, committed as a demonstration fixture of the full generate → canonize flow. Re-running `scripts/gates/phase3.ts` will create additional harmlessly-named duplicates over time (each gate run canonizes a genuine new note, by design) — expected, not a bug; `rm dev-vault/Campaigns/Ashfall/Locations/Fairenford*.md` if it ever needs tidying.

## Phase 4 — continuous LOD (DONE, gate green: `npx tsx scripts/gates/phase4.ts` → 11/11)
- [x] **Viewport dispatcher** (`MapView.dispatchViewportTiles()`, debounced 200ms off `moveend`/`zoomend`): replaced Phase 3's flat merge-by-id `generatedFeatures` array with a `Map<tileKey, Feature[]>` keyed `${band}:${tileX}:${tileY}`, evicted to viewport+margin every dispatch pass — the load-bearing property an advisor review flagged before any code was written (an ever-growing array makes `source.setData()` re-parse more data on every pan, degrading perf as a session goes on). In-flight requests deduped by tile key so a re-crossed tile isn't re-dispatched, and results are discarded on arrival if their tile panned out of view first.
- [x] **Zoom bands** (`src/gen/cache/tileGrid.ts`): world tier (regions/settlements/routes) below zoom 8, city tier (streets/districts/blocks) at/above — `bandForZoom()`/`generatorIdsForBand()`. Both bands share the existing 600m tile grid; a coarser dedicated world-tile grid deferred until a real campaign's low-zoom dispatch tile-count actually demands it (see DECISIONS.md).
- [x] **`GenerationWorkerClient` wired in** (Phase 3 built it, didn't use it): `generateTile()`'s generator parameter now accepts a sync-or-async function, so the dispatcher passes a worker-backed closure through the exact same cache-read/cache-write path a direct call uses. Falls back to direct main-thread generation if the worker fails to load.
- [x] Loading shimmer (`.campaign-map-loading-indicator`, top-right, shown while `pendingTiles.size > 0`).
- [x] Perf: frame-time sampler (scripted `panBy` during the gate, `map.on('render')` timing → p95) and a synthetic-500-note-campaign index-rebuild timer (`plugin.rescanTimeMs`) — both real, live-measured numbers, not simulated. See "Awaiting Jonah's eyes" for what these numbers do and don't prove.
- [x] `scripts/gates/phase4.ts` — 11 checks: automatic world-tier population from a bare pan (no manual command), zoom-band crossing evicts the old tier, eviction bounds the tile store on a far pan, determinism survives eviction+revisit, dispatcher output actually renders (not just sits in the source), the two perf checks, full-reload survival, screenshot.
- [x] Re-ran Phase 0 (10/10), Phase 1 (13/13), Phase 2 (15/15), Phase 3 (11/11) after every Phase 4 change — 60/60 across all five gates, no regressions.
- [ ] Detail band (z16+) buildings/POIs — not built this phase; city-band footprints already render from z14 (`generated-footprint` layer), which covers the "buildings" half. Deferred, not blocking (see below).

### Notable engineering calls this phase (full detail in DECISIONS.md)
- **Three real bugs found getting the live gate green, none of them gate-script artifacts:** (1) cross-band eviction was wiping tiles a manual `generate-city-here`/`generate-world-here` override had just written, if the camera's current zoom happened to be the *other* tier — fixed by scoping ordinary eviction to the active band's own tile-key prefix, only doing a full-store clear on a genuine band transition; (2) an uncapped prefetch margin turned a single low-zoom pan into 16 tiles × 3 generators = 48 concurrent cache-I/O calls — capped the margin at a fixed 2-tile radius regardless of viewport size; (3) a pre-existing (Phase 1-era) race in `onOpen()`'s "load" handler could silently snap the camera back to the campaign's default bounds *after* an explicit `jumpTo()`, discarding whatever the dispatcher had started fetching — harmless when nothing was tied to live camera state, a real bug once the dispatcher existed. Fixed with a `campaignAppliedOnce` guard.
- **Found and fixed a real theming bug while verifying screenshots**: `obsidian-native`'s `roadMinor` and `water` tokens both resolved to the same CSS variable — generated streets were rendering the exact same color as water, functionally invisible against the background. Root-caused and fixed (`roadMinor` now reads `--background-modifier-border`); see `review/001-generated-fabric-contrast.md` for the before/after and a residual Tier B question about whether the new contrast level is enough.
- **Found and fixed a screenshot-tooling gap** (not a plugin bug): `dev:screenshot` captures the Electron window's composited back buffer, and macOS stops repainting occluded/unfocused windows — a CLI-only agent session was silently capturing stale frames. `scripts/lib/cli.ts`'s `screenshot()` now activates the Obsidian window first. This affects every phase's gate screenshots retroactively (they were likely fine, since a human wasn't stealing focus during those runs, but this closes a real gap for any future CLI-only session).
- **Gate-script robustness under continuous background load**: raised `execFileSync`'s stdout buffer (dense city fabric can produce arrays the default 1MB limit rejects outright, not just slowly), converted several fixed-`setTimeout` waits to polling loops, and rewrote one Phase 3 check that compared the *global* `generated` getter before/after — no longer meaningful once a dispatcher is continuously, independently churning that same getter's contents.
- **Observed, not chased**: gate runtimes and reported p95 fps degrade noticeably after many consecutive gate-script executions in one long-lived Obsidian session — a fresh `obsidian reload` (full renderer-window reload, not an OS/process restart) restores clean numbers every time. That it takes a *window* reload rather than fading back on its own is a real clue pointing at retained state somewhere in the renderer (the dispatcher's own timers/Map entries are a plausible suspect, not ruled out) rather than generic OS load — **unconfirmed, not root-caused**. Flagging honestly rather than asserting it's clean: if the map feels sluggish after a long uninterrupted session, this is the first thing to profile. **New data point (2026-07-08, de-slop pass):** `plugin:reload` alone is *not* enough to clear it — ran phases 0-4 back to back, phase 4 failed 5/11 (world tier simply never populated after a bare pan) even immediately after a `plugin:reload id=campaign-map`. Only a full `obsidian reload` (window reload) fixed it, restoring clean 11/11 and p95 back to ~54fps from ~19.5fps. That plugin reload — which re-runs `onload()`, re-registers views/commands, does everything a fresh plugin instance would — isn't sufficient, but a full window reload is, narrows the suspect list: it's not plugin-instance state (a `plugin:reload` would have cleared that), it's something living in the Obsidian *window*/workspace layer that survives a plugin reload — still not root-caused, but this rules out the plugin's own `onload`/`onunload` lifecycle as the leak.

## Live feedback fixes (2026-07-08, mid-session — see DECISIONS.md for full detail)
Jonah opened the app and flagged three things directly from a London screenshot; all three fixed and re-verified (all 5 gates green, 60/60):
- [x] `modern-clean`'s land tuned #f8f7f2 → #eae7de — roads/buildings render white and were nearly invisible against the old near-white land fill, which was also making labels read as washed out even though their own color was technically fine.
- [x] Place-card "Open note"/"Edit" buttons collapsed to one "Open note" button that opens straight to edit mode.
- [x] Locations no longer vanish entirely below their type's `zoomMin` — a small persistent dot (`canon-point-far`/`generated-point-far`) now shows at any zoom, Google-Maps-saved-place-style. Per-type icons (Jonah floated this) deferred as a separate craft pass, not bundled into the quick fix.
Currently paused mid-Phase-5 to do a full repo-review/de-slopping pass at Jonah's request (see below) before continuing feature work.

## Naming culture grammar fix (2026-07-08 — see git log 899326c)
Jonah, from a QuickAddModal screenshot: "what's the source of these recommended names? they suck." Two naming cultures had string-concatenation grammar bugs (`modern-mediterranean`'s connectors assumed proper-name `pre` values but several are common nouns → "Casa's Osteria"; `modern-anglo` had a bare no-space `"s"` connector → "MillsCorner Shop"). Fixed both, found the second proactively by spot-checking sibling cultures rather than waiting to be told.

## Campaign creation / naming-culture / basemap UI (2026-07-08 — see DECISIONS.md for full detail)
Immediately after the naming-culture fix, Jonah asked how to create a campaign, download basemap data, switch themes, and configure naming — correctly observing there was no UI for any of it beyond one undiscoverable theme-switch command. Built the whole surface:
- [x] "Create new campaign" command/ribbon icon + `CreateCampaignModal` — writes the full docs/02 §3 vault layout (`.map.md` + `Locations/` + `Sessions/`), not a shortcut version.
- [x] "Campaign settings" command/ribbon icon + `CampaignControlModal` — theme switch, naming-culture toggles, basemap status/attach, all in one place.
- [x] Naming cultures are a real per-campaign setting now (`namingCultures` frontmatter), threaded through `culturesForGenre`/`cultureAt`/`GenerationConstraints` with a safe empty/non-intersecting fallback. Verified live (not just unit tests): toggling a culture off actually changes QuickAdd's suggested names.
- [x] Found + fixed a real latent bug while wiring this: `generationService.ts` never set `namingGenre`, so every campaign (including real-city ones) silently generated fantasy-genre settlement names regardless of actual crs/theme.
- [x] Basemap: attach-existing-file (vault-only, no binaries) + a guided `pmtiles extract` command generator (bbox from live viewport) — deliberately not one-click download; the `pmtiles` npm dep can't write archives, and auto-running a downloaded Go binary is the same risk class DECISIONS.md 2026-07-07 required explicit sign-off for.
- [x] Found + fixed a second real bug during live verification: create-campaign's auto-open raced `metadataCache`'s async frontmatter parse and silently failed to open the new campaign (no error anywhere) — now waits for the "changed" event.
- [x] 74/74 unit tests (up from 65), Phase 2 gate 15/15, Phase 4 gate 11/11 — no regressions.

## De-slop pass (2026-07-08 — see git log e6b188a): five dead-code deletions, no behavior change
Jonah's original ask, resumed after the two live-feedback interrupts above. Cross-referenced every exported symbol against its usage across `src/`, by hand for each candidate (not just the same-name grep — that method has real false positives: e.g. `MODERN_CLEAN`/`PARCHMENT`/etc. in `themes/tokens.ts` looked "unused" by a naive grep but are consumed via the `HANDCRAFTED_THEMES` record they're assembled into, and left alone). Five things were genuinely, unambiguously dead — zero callers anywhere, verified individually:
- [x] `src/map/style.ts` (`blankWorldStyle`) — Phase-0 placeholder style, whole file deleted, fully superseded by `src/map/theme.ts`.
- [x] `generateCity()`/`generateWorld()` combinators (`city/index.ts`, `world/index.ts`) — "combine everything" convenience wrappers nothing ever called; the live dispatch path always called the individual sub-generators directly.
- [x] `cultureForCampaign()` — its own docstring already called it a superseded Phase 1 stub; `regions.ts`'s `cultureAt()` replaced it in Phase 3a.
- [x] `main.ts`'s `get themes()` — returned `null` unconditionally with a stale comment claiming Phase 2 (handcrafted themes) was still future work; zero readers.
- [x] `blocks.ts`'s discarded `void mulberry32(...)` — computed a seeded RNG and threw it away for a "future footprint variation" that was never built; removed, along with the two params (`campaignSeed`, `path`) that were only there to feed it.
Re-verified full suite after: typecheck clean, 74/74 unit tests unchanged (none of the deleted code had test coverage, because none of it was reachable), all five phase gates green (60/60 phases 0-3, 11/11 phase 4) after a full window reload.
**What did *not* get touched, and why:** a first-pass grep flagged ~40 more "unused" exports (mostly interfaces/type aliases like `VoronoiCell`, `Tensor2`, `SigilOptions`, and tuning constants like `BLOCK_MIN_AREA`, `STREET_SEED_CELL_SIZE`). Checked each: they're all genuinely used, just only *within* their own defining file (a constant consumed by the same file's own generator function doesn't need a second consumer to justify existing) — the `export` keyword on some of them is arguably unnecessary, but that's a style nit, not dead code, and not worth the diff noise this pass. Nothing else in the codebase reads as "overwritten" or newly brittle beyond what's already flagged elsewhere in this file (the reload-flakiness note above, the Tier B aesthetic items in "Awaiting Jonah's eyes").

## Next 3 actions
1. Resume Phase 5: poster export first (highest-value "keepsake," most self-contained).
2. Atlas export + campaign replay, then `scripts/gates/phase5.ts`.
3. If time allows: profile the window-reload-clears-it renderer state leak flagged above (narrowed to "not plugin-instance state" this session, still not root-caused).

## Open blockers
None.

## Awaiting Jonah's eyes
- `shots/london-contrast-fix.png`, `shots/london-far-dots.png` — the three live fixes above, visually confirmed.
- `shots/gate-phase0.png`, `shots/gate-phase1.png`, `shots/gate-phase2-london.png`, `shots/gate-phase3-ashfall-generated.png`, `shots/gate-phase4-dispatcher-city.png`, `shots/phase4-contrast-fix2.png` — screenshots of the pipeline end to end, including the Phase 4 before/after for the road-contrast fix.
- **Perf numbers are real but CI-machine numbers, not Surface Pro verification** (docs/06 §6's honest limit): frame-time sampler shows p95 ≈ 50-57fps on this dev machine during a scripted pan, and index rebuild for a synthetic 500-note campaign is well under 1s (sub-millisecond, actually — `rescanLocations()` is not the bottleneck at that scale). Both are real, gate-enforced measurements, not estimates — but only you opening the map on the actual Surface Pro confirms the docs/06 §2 target that matters.
- `review/001-generated-fabric-contrast.md` — a real contrast bug (roads rendering the same color as water) found and fixed this phase, with one remaining aesthetic judgment call: is the post-fix contrast level enough, or does it also want a line-width bump.
- Right-click context menu: implemented correctly per standard API but unverified by CLI automation (see DECISIONS.md) — please try a real right-click on a location pin/empty map when you get a chance.
- Undo is intentionally basic (single-step, no redo) — flag if you want that built out further before Phase 5's replay work depends on it.
- The four handcrafted themes are visually verified (screenshots taken during the session) but only `modern-clean` (via London) has a committed reference screenshot — happy to add parchment/ink-soot/neon-sprawl reference shots to `shots/` if useful for review, just say the word.
- Alegreya/Oswald bold-via-size-not-weight approximation (see DECISIONS.md) — low priority, flag if it reads wrong in practice.
- **Generated fabric density/spacing** (streets, settlement clustering) is functionally correct and deterministic but not aesthetically tuned — Tier B per docs/06 §2, flagged for your eyes whenever convenient, not blocking.
- **`Fairenford`** in the Ashfall dev-vault campaign is a real generated-then-canonized settlement (see DECISIONS.md) — a live demonstration of Phase 3's core exit test, not curated seed content like the original four locations.
- **Detail band (z16+) buildings/POIs** wasn't built as a separate thing this phase — city-band footprints already render from z14, functionally covering "buildings." If you had something more specific in mind for "POIs" at street level (benches, trees, shop icons), flag it and it's a small addition on top of the existing footprint layer, not a new subsystem.

## Post-Phase-4 UX pass + point-crawl + Phase 5 (2026-07-09, session)

*This session resumed after Phase 4. Work integrated to `main` and verified against the live Obsidian gates (obsidian CLI on `dev-vault`). Managed as `improve`-skill plans in `plans/` (see `plans/README.md`) executed by Sonnet subagents, merged sequentially by the orchestrator.*

### Shipped + live-gate verified (merged to `main`)
- **001 clickable pins** — tolerant hit-test (`pickFeatureNear`, 8px box) so 3–7px dots are clickable near-miss; generated-settlement clicks route to a "Add to canon" card. Phase 1 gate got a recentre+await-idle hit-tolerance check (the first version never recentred, so in the fictional CRS the dot sat off-screen — fixed).
- **002 terrain background from world data** — `generated-region` now paints ocean/coast→water, land→land (biome-driven `match`), replacing the flat 6%-opacity wash. Data was already on the features (`gen/world/regions.ts`), so this is render-only, no generator edits, no seam tests. Height relief deferred (a single overlay token's luminance flips between light/dark themes — needs a per-theme relief token; see `plans/002`).
- **003 on-map toolbar** — DOM control surface (add/generate/canonize/search/theme/settings), replacing command-palette-only discovery. `openControlPanel()` made public.
- **004 + 005 point-crawl connections** — `connections:` frontmatter list on location notes → resolved to `connection-line` features (dashed, themed, works across all styles); create via place-card "Connect to…" + a picker, remove by clicking the line. Canon-native (survives rename, vanishes with a deleted endpoint). Verified: line renders live between two Ashfall locations.
- **007 poster export v1** — high-res PNG of the current view via an offscreen `preserveDrawingBuffer` map + title cartouche, saved to `<campaign>/Exports/` (Vault adapter). PNG output not yet visually inspected.
- **Consistent dots (UX request)** — all location dots are now ONE constant size (`CANON_DOT_RADIUS=5`) at every zoom, never importance-scaled, never zoom-gated (merged the old canon-point/canon-point-far split into a single unfiltered layer; same for generated settlements, F2 parity). Labels stay zoom+importance managed. Screenshot-verified: all 8 Ashfall dots visible + identical at 50m/zoomed-out.

### Reverted
- **006 per-type icons (spike)** — the prototype's runtime `map.addImage` icon layer left the MapLibre style stuck loading forever (`isStyleLoaded()` never true → pins + connection line stopped rendering), with NO console error and green typecheck + unit tests. Only the live app caught it — exactly the spike's documented STOP-1 risk. Reverted from `main`; branch `advisor/006-per-type-icons-spike` + `plans/006-NOTES.md` kept. Redo with a sprite sheet, or pre-register images before adding the `icon-image` layer.

### Live gate status on `main` (obsidian 1.12.7, dev-vault)
Phase 0 **10/10** · Phase 1 **16/16** · Phase 2 **15/15** · Phase 3 12/14* · Phase 4 **11/11**.
*Phase 3's two failures are the **canonize** checks only — confirmed pre-existing, render-independent flakiness: they race the Phase-4 viewport dispatcher (which re-fetches tiles) and the async canonize→index reconcile, and the gate creates uncleaned canon notes that accumulate across runs. They pass on a fresh run. A background task is filed to harden them (quiesce the dispatcher, settle the index baseline, clean up created notes). Not a product regression.

### Phase 5 — in progress (autonomous build per GOAL.md)
Plans `008` atlas PDF export · `009` campaign replay + session travel paths · `010` populate-area + external-agent note contract (`docs/07-llm-note-contract.md`) · `011` import external maps (GeoJSON/Azgaar/Watabou) — dispatched to subagents. `012` = the Phase 5 Tier-A gate (`scripts/gates/phase5.ts`), authored by the orchestrator after the features land. Obsidian **Bases integration deferred** (API-gated) with a `review/` note. Poster export (Phase 5's "first" item) shipped as 007.

## Phase 5 COMPLETE (2026-07-10, autonomous build per GOAL.md)

All Phase 5 roadmap features built, merged to `main`, and verified. Managed as plans 007–012 (`plans/README.md`), executed by Sonnet subagents, merged + gate-verified by the orchestrator.

### Shipped (merged to `main`)
- **007 Poster export** — high-res PNG (offscreen `preserveDrawingBuffer` render + title cartouche) → `<campaign>/Exports/*.png`.
- **008 Atlas export** — multi-page PDF (cover map + per-location gazetteer from note bodies) via `pdf-lib` → `<campaign>/Exports/*.pdf`. Headless-verified valid `%PDF-1.7`.
- **009 Campaign replay + session travel paths** — `replay-campaign` steps the camera through mutation-log `create` entries; `show-session-path` draws an ordered line through a session note's `[[wikilinks]]` on a themed `session-path-line` layer (modeled on the point-crawl connection layer).
- **010 Populate-area** — `populate-area` scatters N deterministically-seeded, culture-named location notes across the viewport (offline, no LLM/API). `docs/07-llm-note-contract.md` documents the note-emission contract so an external agent-in-vault (the "LLM hook") can emit valid notes the plugin reconciles live — the vault IS the API.
- **011 Import** — `import-geojson` maps a vault GeoJSON file (Azgaar/Watabou export) → location notes (Points) + sidecar-geojson notes (Lines/Polygons), reusing the existing note-creation paths.
- **012 Phase 5 gate** — `scripts/gates/phase5.ts`: exercises the live export pipelines (poster PNG + atlas PDF actually written), the point-crawl/session render layers, the command+method surface, and replay.

### Real bug caught by visual verification (fixed)
Poster/atlas exports initially rendered the title over a BLANK map — the offscreen `renderPoster` map's geojson sources start empty and were never populated. Fixed with `MapView.buildExportStyle()` (bakes current canon/generated/connection data into the export style). Re-exported + eyeballed: poster now shows all pins, labels, and the connection line. The phase5 gate's file-write check passed even while blank — flagged in `review/005` as a gate-hardening follow-up (assert export *content*, not just that a file exists).

### Live gate status (obsidian 1.12.7, dev-vault) — the "Done means" checklist
- **All Tier A gates green (fresh-reload)**: Phase 0 **10/10** · Phase 1 **16/16** · Phase 2 **15/15** · Phase 3 **14/14** · Phase 4 **11/11** · Phase 5 **8/8**.
- Phase 3's two canonize checks were previously flaky (12/14). Root-caused with a *discriminating live test* (generate → capture a settlement's id → canonize → verify): canonize correctly strips the feature **by id**, creates the note, and grows the index — the failures were unsound TEST checks (name-based strip check confused by dispatcher-loaded same-named settlements; and jumping to zoom 8 = the *city* band evicted the world settlement before canonize ran). Hardened: canonize at the settlement's own world band, assert the strip by feature id, and settle the index baseline before the assertions. Now a stable **14/14**; `review/004` → RESOLVED.
- **Three test campaigns screenshot-verified this session** (`shots/verify-*.png`): Ashfall (fictional, obsidian-native — constant-size dots + point-crawl connection line), London (real-city — Protomaps basemap + blue canon dots, modern-clean), Nightreach (neon-sprawl — acid-yellow dots + neon route lines). Confirms the global rendering changes (constant dots, biome background, connections) hold across every CRS + theme path.
- **Session-degradation caveat (known):** running many gates back-to-back in one long-lived Obsidian process degrades the renderer (Phase 4's "city tier after crossing" and Phase 5's offscreen renders slow down). A full **Obsidian process quit + relaunch** clears it (a window `obsidian reload` and `plugin:reload` do NOT — it lives in the window/workspace layer, ruling out the plugin's own `onload` lifecycle). This is the single unresolved perf item — first thing to profile if the map feels sluggish after a long session.

### review/ queue (Tier B, awaiting Jonah's eyes)
`review/001` generated-fabric contrast · `002` height-relief deferred (needs per-theme relief token) · `003` Bases integration deferred (API-gated) · `004` canonize gate flakiness (task filed) · `005` poster/atlas content bug fixed + remaining visual checks (handcrafted-theme/London exports, PDF gazetteer layout, gate content-assertion).

### Deferred (with rationale, not blocking "done")
- **Obsidian Bases integration** — API-gated; locations are already notes queryable via Bases/Dataview today (`review/003`).
- **Per-type location icons** — spike (006) reverted: runtime `addImage` stalls style load; redo with a sprite sheet (`plans/006-NOTES.md`).
- **Height relief, detail band z16+, multi-step undo/redo, worker-into-live-commands, bold-weight fonts** — logged in the `plans/README.md` roadmap gap register.

**Net:** the plugin now covers the full Phase 0–5 roadmap. Three test campaigns (Ashfall fantasy / London real-city / Nightreach neon-sprawl) present and working; Ashfall exercised end-to-end this session (pins, connections, terrain, generation, exports all screenshot-verified live).

## Phase 6 — sketch/landscaping tools (2026-07-10)

User direction: GUI tools to sketch the non-location city fabric (roads/districts/
water/walls), stored durably and LOD-consistent, that FEED procedural generation
("a la Sims landscaping"). Built by a Fable agent (plans 013 + 014).

- **013 — sketch foundation (DONE):** one promotable `<campaign>/Fabric.geojson`
  canon store; sketch-mode toolbar (pencil) with line/polygon draw, delete,
  promote-to-note; `fabric` source + per-kind layers in both style builders;
  per-kind `minzoom` + source `tolerance` (LOD discipline — a road drawn zoomed-in
  doesn't tangle zoomed-out); `sketch-add`/`sketch-remove` undo. v1 scope: no
  vertex re-edit, no snapping (follow-ups).
- **014 — sketch→procedural, road→streets slice (DONE):** pure
  `generateCorridorStreets` (Chaikin smoothing → corridor tensor basis → branching
  minor streets); **2×2 adjacent-tile seam determinism test green**; features carry
  `mode: literal|generate`; a "Generate from sketch" action elaborates
  generate-mode corridors into cache streets (sketch stays canon). District/river/
  wall/park elaboration are follow-ups.

**Regression caught + fixed (live-only, 006-class):** the merge shipped two MapLibre
rule violations that made the whole style silently fail to load (map blank, no
console error, unit tests green): a `["zoom"]` expression inside a layer `filter`
(fabricLayers), and a zoom `interpolate` nested inside `["*", …]` in the
generated-street `line-width` (014). MapLibre requires `zoom` to be the top-level
expression of a paint property and forbids it in filters. Root-caused by A/B'ing
pre- vs post-013 builds across full Obsidian restarts (window reloads don't clear
the separate renderer-degradation issue). Fixed both; live-verified the style loads,
fabric renders, LOD floors hold, and generate-from-sketch produces 76 corridor
streets. **Lesson: a green `npm test` does NOT catch an invalid MapLibre style — it
needs the live `dev:screenshot`/`isStyleLoaded()` loop. Add a gate check that
asserts `map.isStyleLoaded()` after opening each campaign.**

## 2026-07-10 — Plan 019: two-layer model (background things vs. Locations)

- **019 (DONE, phases 1–5):** the procedural→canonization loop is deleted per
  Jonah's correction. The map now has exactly two content classes: **Locations**
  (note-backed, linkable, always rendered on top — `layerOrder.ts` asserts it
  per-build and per-theme-test) and **things on the map** ("fabric": sketched →
  `Fabric.geojson`, generated → `.mapcache/` + a durable request manifest
  `<campaign>/Generated.json`). Fabric never promotes to a note.
- **Explicit-only generation:** the viewport dispatcher is gone — pan/zoom runs
  zero generators (live-asserted via the new `generatorRunCount` test surface).
  `generateFabricHere(point?)` picks world/city tier from zoom, paints, appends a
  manifest entry + `generate-area` log record. Manifest replays on open (cache
  read once, then hit or deterministic regenerate). `.mapcache/` delete →
  byte-identical repaint (live-verified). Regenerate/Clear-here/Clear-all wired
  into right-click menu, control modal, palette; clears survive reopen.
- **Sketch = constraint:** every sketched feature feeds every generator run
  (`fabricConstraints.ts`, pure): streets stop at water/walls and align to
  sketched roads (the plan-014 corridor blend generalized; feed-mode/build
  removed), districts respect sketched water/districts. Sketch edits inside
  generated areas auto-regenerate affected tiles (debounced; never first-time
  generates). 2×2 seam tests with constraints crossing the seam are green;
  live-verified: water sketched over a generated tile → streets stop at the
  shoreline on their own.
- **D2:** `world-settlement` unwired from generation (named places are
  Locations); generated point/label layers removed; settlement generator kept
  for populate-area naming.
- Suite: 240 tests green. Migration: old campaigns keep their notes; generated
  sprawl reappears only where the GM explicitly generates (README notes this).

## Plan 020 — sketch-driven procgen regions (v4.0 done)
- **v4.0 pure core (2026-07-12, committed)**: `src/gen/region.ts` (polygon
  geometry: contains/distanceToBoundary/interiorT/insetRing/clipPolylineToRegion,
  interior pole on a deterministic 10 m lattice), `src/gen/procgen/registry.ts`
  (sketch-kind → algorithm; "city" registered for `district`), fabric `procgen`
  block (algorithm/seed/version/params, pre-020 files parse unchanged), citynet
  generalized disc→polygon (`regionId` replaces `domainId`; wall traces the
  sketched boundary inset; all output strictly inside the polygon;
  `districtRings` ward-exclusion retired). Hosts compile via
  `generateCityNetworkForDomain` disc shim (v4.1 removes).
- Gates: determinism byte-identical (hexagon + disc fixtures) · 2×2 seam
  bit-identical · concave L-shape contained, no throw · disc-equivalence −1.2%
  features vs v3, wall + 5 gates, density monotonic · 120-run 4-profile polygon
  fuzz zero-throw · suite 306/306 · tsc + production build green.
- Next: v4.1 host lifecycle (RegionProcgenModal, sketch-finish trigger, region
  cache keys, replay from sketch layer, disc→district migration, gate procgen40).

- **v4.1 host lifecycle (2026-07-12, committed)**: sketching a district now
  drives city procgen. RegionProcgenModal (registry-driven, replaces
  DomainProfileModal); region cache keys `region:<id>:…`; replay derives city
  fabric from the sketch layer (city-tier manifest entries retired); one-way
  disc→district migration (ran live on Vespergate's real domain);
  clear/delete/undo via `sketch-procgen-set`/`sketch-procgen-clear` log types;
  worker job `procgen-region` via the registry; disc shim removed. Gate
  procgen40 10/10 · 306/306 · tsc + build green ·
  review/v4.1-vespergate-sketch-city.png (square wall traces the sketched box).
- Next: v4.2 edit UX (select tool, vertex handles, params panel, edit→regen).

- **v4.2 edit UX (2026-07-12, committed)**: PowerPoint-style sketch editing —
  Select tool, vertex/midpoint drag-edit, Backspace vertex delete, selected-
  feature panel (name, profile, Re-roll, Regenerate, Reset center, Remove
  city), right-click "Edit shape"/"City settings…", `sketch-edit` log + undo,
  edit→regen loop (region self-edit + constraint-kind neighbors). Jonah addenda:
  building footprints/parcels always visible (zoom LOD removed); GM-draggable
  persisted city center (stability 60–69% vs 45–49% street overlap on boundary
  edits). Gates procgen41 16/16 + procgen40 rerun 10/10 · 316/316 · tsc+build
  green · review/v4.2-*.png (5 screenshots).
- Next: v4.3 consolidation (gate modernization, three-layer naming, full board).

- **v4.3 consolidation (2026-07-12, committed) — PLAN 020 COMPLETE**: gates
  procgen30–34 consolidated into procgen42 (sketch-driven city content, 9/9)
  + procgen43 (profile signatures + dead-v2 sweep, 7/7); phase3 (14/14) /
  phase4 (12/12) modernized to three-layer contracts; layerOrder renamed to
  the three-layer model; deleteFabricForTest test API; relaunch-obsidian.sh
  helper. Validation: tsc + 316/316 + build + the four changed gates
  (unchanged gates inherit prior green; next full board lands at plan-021
  21-C per Jonah's scope cut). dev-vault byte-intact. Next: the plans
  021–025 arc via HEARTBEAT.md.
