# Decisions Log

*Append-only. Format: date, decision, alternatives considered, reversibility.*

## 2026-07-08 — Local Node.js install without a package manager

**Decision:** Downloaded the official Node v22.14.0 darwin-arm64 tarball from nodejs.org and symlinked its `bin/` into `~/.local/bin` (already first on PATH), since neither `node`/`npm` nor `brew`/`nvm`/`fnm`/`volta` were present on the build machine.
**Alternatives:** wait for human to install Node; use a different package manager. Rejected — preflight requires network+Node, and a direct binary download is standard/reversible.
**Reversibility:** fully reversible — delete `~/.local/opt/node-*` and the symlinks in `~/.local/bin`.

## 2026-07-08 — dev-vault registration requires editing Obsidian's global vault registry

**Decision:** The Obsidian CLI only operates against vaults already known to the running app (`~/Library/Application Support/obsidian/obsidian.json`); there is no CLI command to register a new vault, and the `obsidian://open?path=` URI only resolves vaults that already contain a known path. To make `dev-vault/` CLI-addressable, quit the running Obsidian app, added a `dev-vault` entry to `obsidian.json` (new random hex id, `"open": true`), and relaunched. Confirmed with Jonah before relaunching since this touched global (out-of-repo) state and briefly closed his `ao3-archiver` session.
**Alternatives:** drive the GUI "Open folder as vault" dialog (no click/GUI-automation tool available in this environment); skip live CLI integration entirely (rejected — CLI-driven testing is load-bearing per docs/05 and docs/06 Tier A gates).
**Reversibility:** reversible — removing the `dev-vault` entry from `obsidian.json` (or just its `"open": true` flag) restores prior behavior; `ttrpgs` and `ao3-archiver` entries were left untouched other than clearing the stale `"open"` flag on `ao3-archiver` (harmless — only affects which vault auto-opens next launch).

## 2026-07-08 — GitHub repo created fresh

**Decision:** No existing `campaign-map` repo under the user's GitHub account; created `syrtis-m/campaign-map` (private, matching the pattern of the user's other in-progress/private repos) via `gh repo create --source=. --remote=origin`.
**Alternatives:** none — user's `/goal` invocation explicitly authorized autonomous commit+push.
**Reversibility:** reversible (repo can be deleted/renamed later).

## 2026-07-08 — Phase 0 "blank parchment world" = literal placeholder style

**Decision:** Roadmap Phase 0 says "blank parchment world panning at 60fps", while architecture §4 pins `obsidian-native` (CSS-variable-derived) as the default theme for new campaigns, with handcrafted themes like `parchment` as per-campaign overrides landing Phase 1/2. Read "parchment" here as colloquial ("blank, parchment-colored, non-broken-looking"), not a commitment to the `parchment` theme id. Implemented `src/map/style.ts` as a single-layer MapLibre style (background only) using the pinned `parchment` land token (`#f2e8cf`, docs/06 §3) as a neutral placeholder color — no theme system exists yet.
**Alternatives:** build the real `obsidian-native` runtime style generator now — rejected, it's explicitly scoped to Phase 1 and depends on reading live Obsidian CSS variables + `css-change` events, which is real work belonging to that phase's roadmap bullet.
**Reversibility:** fully reversible — `blankWorldStyle()` is replaced wholesale by the theme system in Phase 1/2.

## 2026-07-08 — Custom scale bar instead of MapLibre's ScaleControl

**Decision:** MapLibre's built-in `ScaleControl` computes meters-per-pixel from the map's actual (real) latitude via true Web Mercator math. Fictional campaigns use fake lng/lat as coordinates (architecture §4, Spike B), so the built-in control would show numerically meaningless units. Wrote `src/map/fictionalCRS.ts`: treats fake coordinates as degrees at the equator, converts pixel distance → fake-degree distance → real-world meters via each campaign's `scaleMetersPerUnit`, then rounds to a "nice" 1/2/5×10^n step, Google-Maps-style (docs/06 §3: "when genuinely undecided, pick the option closest to Google Maps behavior").
**Alternatives:** disable the scale bar for fictional campaigns entirely — rejected, quality-bar / Spike B exit criteria explicitly calls for a working scale bar in fake-coordinate space.
**Reversibility:** reversible/extensible — real-city campaigns (Phase 2) can just use MapLibre's stock `ScaleControl` since their coordinates are true lng/lat; the custom bar only needs to apply to `crs: fictional` campaigns.

## 2026-07-08 — Manual DOM patch for map-tab header/title text

**Decision:** Obsidian doesn't re-invoke `ItemView.getDisplayText()` after `setState()` changes what it would return — confirmed empirically (calling the undocumented `leaf.updateHeader()` after `setState` did not change the rendered header text). Both the tab-strip title and the center-pane header title are patched directly in `MapView.refreshHeaderTitle()`, using `leaf.tabHeaderInnerTitleEl` (undocumented but stable, used by many community plugins) for the tab and a scoped `.view-header-title` DOM query for the pane header.
**Alternatives:** live with the generic "Campaign map" title until the leaf is closed/reopened — rejected, fails the Phase 0 exit test's implicit requirement that the opened tab reads "Map: Ashfall".
**Reversibility:** reversible — if a future Obsidian version re-queries `getDisplayText()` properly, this patch becomes a no-op-safe redundant write, not a correctness hazard.

## 2026-07-08 — Pulled Inter glyph-PBF generation forward from Phase 2 into Phase 1

**Decision:** docs/06 §3/§4 scope font glyph-PBF generation to Phase 2 ("download + generate glyph PBFs via font-maker in Phase 2"). But MapLibre GL JS has no local/system-font text rendering path for non-CJK text — `symbol` layers require a `glyphs` URL serving pre-baked SDF PBFs, full stop (confirmed against the installed maplibre-gl v4 type defs: only `localIdeographFontFamily` exists as a font fallback, and that's CJK-only). Phase 1's Tier A "Label collisions" assertion (docs/06 §2) explicitly expects `queryRenderedFeatures` on real symbol layers, which is also the only mechanism that gets MapLibre's built-in label-collision engine "for free" instead of reimplementing it in DOM. Rather than fake Phase 1 labels with a custom DOM-overlay layer (real GL symbol layers must exist for that assertion to mean anything, and reinventing collision detection would contradict "generators/themes own paint, never reinvent MapLibre's job"), generated Inter Regular/Bold glyph PBFs (ranges 0-255, 256-511 — Basic Latin + Latin-1 Supplement + Latin Extended-A, i.e. all English/European campaign names) now, via `fontnik` (prebuilt native binary installed cleanly, no build toolchain needed) fed with static TTFs from the official `rsms/inter` v4.1 GitHub release (OFL-1.1, see ATTRIBUTIONS.md). Scripts: `scripts/fetch-fonts.sh` (source TTFs, gitignored) → `scripts/build-glyphs.mjs` (PBFs, gitignored, `npm run fonts:build`); esbuild copies `assets/fonts/glyphs/` into the dev-vault plugin output. This is exactly Phase 2's asset-manifest pipeline, just exercised one phase early and scoped to the one font `obsidian-native` actually needs (its pinned default is "inherit theme font, fallback **Inter**").
**Alternatives considered:** (a) DOM-positioned HTML labels instead of GL symbol layers — rejected per above (breaks the Tier A assertion's intent, forfeits built-in collision handling); (b) a public glyph CDN (e.g. fonts.openmaptiles.org) — rejected outright, violates the locked "full function offline" product bar; (c) wait and block Phase 1 on Phase 2 — rejected, "never block" + "when genuinely undecided, pick the option closest to Google Maps behavior" (Google Maps has always-on labels).
**Reversibility:** fully reversible/additive — Phase 2 still does its own (larger) font pass for the four handcrafted themes' custom typefaces; this only pre-builds the one fallback font `obsidian-native` needed anyway, using the identical tool/scripts Phase 2 would have needed to create regardless.

## 2026-07-08 — Removed MapView's manual ResizeObserver (duplicate of MapLibre's own)

**Decision:** `MapView` originally attached its own `ResizeObserver` on the map container to call `map.resize()`, which intermittently produced the browser's "ResizeObserver loop completed with undelivered notifications" warning in `dev:errors` (a hard blocker per docs/06 — errors must be empty). Traced it into `maplibre-gl`'s bundle: `Map` already attaches its own debounced (50ms) `ResizeObserver` on the same container whenever `trackResize` is on (the default) — two independent observers reacting to the same element's layout changes is exactly the browser's documented trigger for that warning. Deleted the redundant observer entirely; MapLibre's built-in one already keeps the canvas sized correctly (confirmed via the Phase 0/1 split-pane and window-reload screenshots, both taken after this fix).
**Alternatives considered:** debounce/rAF-defer the manual observer's callback (tried first, reduced but did not eliminate the warning — two observers were still both firing); globally suppress the specific warning string via a `window.addEventListener('error', ...)` filter — rejected as heavy-handed (would mask unrelated future ResizeObserver bugs too).
**Reversibility:** trivially reversible (the deleted code is a self-contained ~10-line block); no behavior lost since MapLibre's own resize handling covers the same need.

## 2026-07-08 — Right-click context menu: implemented, CLI-unverifiable (logged, not blocking)

**Decision:** `MapView.handleContextMenu` (standard Obsidian `Menu`/`addItem`/`showAtPosition` API, same shape used by hundreds of community plugins) is wired to `map.on('contextmenu', ...)`. Five distinct verification attempts, all inconclusive in the same way — no menu DOM appears, but also **zero errors** anywhere (`dev:errors`, `dev:console` with `dev:debug on`, DOM child-count diffing, `event.defaultPrevented` check confirming the handler *did* run past its guard clause and into `preventDefault()`): (1) `map.fire('contextmenu', {...})` directly; (2) same with a proper `cancelable` synthetic `MouseEvent`; (3) `canvas.dispatchEvent(new MouseEvent('contextmenu', ...))` to go through MapLibre's own DOM listener instead of bypassing it; (4) full debug-console capture (`dev:debug on` + `dev:console`) around the call; (5) `document.body.children` count before/after to catch a menu that renders and immediately self-closes. All five point the same direction: the handler executes correctly up to and past `preventDefault()`, but `Menu.showAtPosition()` produces no visible DOM under CLI-driven automation specifically — most likely Obsidian's `Menu` gates on real OS-level window focus/trust that a synthetic, automation-driven Electron event lacks, not a defect in the plugin's code. Per docs/06 §5 retry policy (5 distinct attempts, then log-and-route-around — this used exactly that budget), routing around: left the implementation as-is (it's correct, standard API usage) and logging this as a CLI-testing gap rather than a Tier A blocker, since Phase 1's actual Tier A gate assertions don't require the context-menu path (the equivalent "add location here" flow is already covered end-to-end via the click-empty-map → dropped-pin → quick-add path, which **is** verified).
**How to actually verify:** a human clicking right-click for real inside Obsidian (docs/06 §6 residual limit: some things need real interaction). Flagged in PROGRESS.md's "awaiting Jonah's eyes" section.
**Reversibility:** N/A — no code change made, just a verification-method limitation being logged per protocol.

## 2026-07-08 — Downloaded + ran the go-pmtiles CLI binary (confirmed with Jonah first)

**Decision:** Cutting the London test campaign's basemap (docs/06 §4 pins a central-London Protomaps extract) requires the official `pmtiles extract` tool — a compiled Go binary from `github.com/protomaps/go-pmtiles` releases; no JS/npm equivalent exists for the *extract* operation (the `pmtiles` npm package is a read-only client library). Downloading and executing a compiled binary I found via my own GitHub API research (not named by Jonah) is meaningfully riskier than fetching inert data files, so I stopped and asked before doing it — confirmed via AskUserQuestion. Ran `pmtiles extract https://build.protomaps.com/20260707.pmtiles dev-vault/Campaigns/London/basemap.pmtiles --bbox=-0.20,51.46,-0.05,51.54`: 18MB, 288 tiles, z0-15, valid PMTiles v3 archive (verified with `pmtiles show`), OSM/Natural-Earth attribution present in metadata (recorded in ATTRIBUTIONS.md).
**Alternatives:** skip a real basemap and test the vault-protocol integration against a synthetic fixture only, leaving the real extract as a manual step for Jonah — this was offered as an option; Jonah chose to authorize the real download instead.
**Reversibility:** fully reversible — `basemap.pmtiles` is gitignored (large binary, regenerable); the go-pmtiles binary itself lives only in the session scratchpad, never committed or installed system-wide.

## 2026-07-08 — Bug found: locations weren't indexed on cold load/reload

**Decision (bugfix, not a judgment call, logged for the record):** `main.ts`'s `onload()` called `this.app.workspace.onLayoutReady(() => this.rescanCampaigns())` — only campaigns got scanned on startup; `rescanLocations()` only ran from `onVaultChange()`, triggered by actual vault/metadataCache events. Result: opening a campaign right after a cold Obsidian launch (or `plugin:reload`) showed zero pins until *something* touched a location note. Caught manually while eyeballing the London basemap screenshot (index.size was 0 despite two committed seed locations) — Phase 1's gate's "survives full app reload" check only asserted `dev:errors` was clean, not that location data actually survived, so it passed right through a real bug. Fixed: `onLayoutReady(() => this.rescanAll())` (campaigns + locations both). Phase 2's gate adds an explicit regression check (index.size > 0 for two campaigns immediately after a full `obsidian reload`).
**Lesson applied going forward:** "survives reload" gate assertions must check actual state, not just absence of errors — re-verified Phase 0's and Phase 1's gates still pass after this fix (both green, no other regressions).
**Reversibility:** N/A, straightforward bugfix.

## 2026-07-08 — Phase 3 generator architecture: position-deterministic seeding over classic order-dependent algorithms

**Decision:** The textbook algorithms for the exact steps docs/03 §Phase 3 lists — adaptive streamline seeding (seed spacing from *existing* streamlines), Bridson Poisson-disc sampling (active-list + random pick), MST route networks, Voronoi relaxation — are all order/global-coupling-dependent: what a tile generates depends on what else has already been generated or on the whole point set, which breaks the Tier A determinism/seam gate (docs/06 §2: same seed twice deep-equal; 2×2 adjacent tiles' edge-crossing line endpoints match within ε). Built every Phase 3 generator on one shared primitive instead: `src/gen/spatialHash.ts`'s `jitteredGridPoints()` — a coarse world-space grid where each cell independently hashes to zero-or-one jittered point via `hash(campaignSeed, cellX, cellY, salt)`, never depending on neighboring cells or scan order. Callers generate over a halo-padded bbox (`expandBBox`) so a feature straddling a tile edge is computed identically by both neighboring tiles. Concretely: city streets are RK4-traced streamlines from these seed points along a tensor field that is itself a pure function of world coordinates + the campaign's **fixed** `worldBounds` (never the tile bbox — an early bug: the field's singularities were originally derived from the tile bbox, which would have made the field itself tile-dependent); districts and world regions are Voronoi cells from the same seeded points via `d3-delaunay`, clipped per-tile with a hand-rolled Liang-Barsky (lines) / Sutherland-Hodgman (polygons) clipper (`src/gen/clip.ts`) chosen specifically because both tiles apply the identical linear-interpolation formula to the identical pre-clip vertex pair at a bit-identical shared-edge coordinate, giving exact (not just epsilon-close) matching endpoints; settlements are an independent per-region-site suitability roll (no spacing-aware greedy placement); routes connect each settlement to its k-nearest neighbors within a max distance (a local pairwise rule, not a global MST) for the same reason.
**Bug caught mid-build:** the first Voronoi seam test failed (vertex counts/values mismatched between adjacent tiles) with `DISTRICT_HALO = cellSize * 3`. Root cause: cells near the halo bbox's own *outer* clip rectangle get artificially clipped by that rectangle rather than by a real neighbor bisector, and two tiles' halo rectangles aren't the same shape, so that artificial clip differed between them. Fixed by widening the halo to `cellSize * 8` (generous enough that cells intersecting the tile bbox are several site-rings away from the halo's own boundary) — extracted as `VORONOI_HALO_MULTIPLIER` in the new shared `src/gen/voronoiCells.ts` so city districts and world regions both get the fix for free. A second apparent failure after that (unique vertex *values* matched but raw occurrence counts didn't) turned out to be a test-methodology bug, not a generator bug — GeoJSON ring closure duplicates the first vertex as the last, and a shared corner point can be touched by a different number of neighboring polygons on each side, so raw point-occurrence counts across tiles were never a valid comparison; fixed the test to dedupe before comparing.
**Alternatives considered:** implement the textbook adaptive/greedy algorithms and try to make them seam-safe via post-hoc reconciliation (e.g. always regenerate a fixed halo region and merge) — rejected as much more complex and still fragile, since the coupling that breaks determinism is internal to the algorithm, not just at its boundary. A true MST for routes was considered and rejected for the same reason (whole point set can shift which edges are minimal).
**Reversibility:** the k-nearest-neighbor route rule and independent-roll settlement placement are visually cruder than what a true MST / spacing-aware placement would give — flagged as Tier B (docs/06 §2) aesthetic tuning opportunities for later, not required to change; the underlying seeding/halo/clip primitives they'd be rebuilt on stay the same either way.

## 2026-07-08 — Web Worker for generation: built and proven, not yet wired into the live commands

**Decision:** docs/02 §5 requires generation to run in a Web Worker so the map tab never stutters. Built the full pipeline: `src/gen/worker/generationWorker.ts` (postMessage-dispatched to the same pure generators everything else uses — it's the one file in `src/gen/` that isn't host-agnostic, kept in its own `worker/` subfolder for that reason), a second esbuild entry point (`esbuild.config.mjs` now builds `generation-worker.js` alongside `main.js`, no `external` list needed since `src/gen/` has zero Obsidian/DOM imports), and `src/map/generation/workerClient.ts` — loaded via a Blob URL built from the vault-adapter-read worker bundle text (sidesteps `new Worker(file://...)` origin/CSP friction in Electron's renderer, same class of problem `glyphs.ts` solves for font PBFs one level less indirectly). Verified live via a `test-generation-worker` command: round-trips a real request through `postMessage`, and its output is byte-identical to calling the same generator directly on the main thread (139/139 features, same seed/bbox) — the worker bundle is genuinely running the same deterministic code, not diverging.
**Scope decision:** did NOT rewire `generate-city-here`/`generate-world-here`/etc. to route through the worker. Those commands are the tested, working Tier A surface (11/11 gate); moving them to async worker calls mid-session would re-risk a feature that's already proven, for a property (UI stutter prevention) that isn't what the Tier A gate checks (determinism/seams are proven by the exhaustive pure-function unit tests regardless of which thread runs them) and that this manual, one-tile-at-a-time "generate here" command flow doesn't really stress yet — real stutter risk shows up under Phase 4's continuous pan-triggered dispatch, which is also the natural place to route every tile request through this client instead of calling generators directly. Building the infrastructure now and wiring it fully in Phase 4 splits the risk sensibly instead of taking it all at once.
**Reversibility:** fully additive — `GenerationWorkerClient` is unused by the current command set but ready; Phase 4's LOD dispatcher swaps `generateCityStreets(...)` direct calls for `workerClient.generate("city-street", ...)` with no change to the generator contracts themselves.

## 2026-07-08 — Post-review fixes: generated-content bounds bleed, dead line-canonization path, gate-check honesty

**Decision (three small fixes from a self-review pass, all before Phase 3's commit was final):**
1. **Generated fabric bled past campaign bounds.** `GENERATION_TILE_SIZE`/`WORLD_REGION_CELL_SIZE` are anchored at the generation-space world origin with a fixed size, not to any one campaign's bounds — for a small campaign (Ashfall is ~800m×600m), a single 600m generation tile can extend well past the campaign's own edges, and a 700m world-region cell barely fits inside it at all (confirmed empirically: Ashfall's one in-bounds region site landed on `ocean` biome for this seed, meaning `generate-world-here` could produce *zero* settlements ever, no matter how many times you ran it — a real quality-bar F4 blank-void risk, not a cosmetic one). Fixed two ways: (a) added `featureTouchesBBox()` in `MapView.ts` to filter generated features to those actually touching the campaign's `worldBounds` before rendering/merging (the cache still stores the generator's true unfiltered output, so `.mapcache/` delete-and-regenerate hash-identical still holds — only the view-level render/merge step filters); (b) lowered `WORLD_REGION_CELL_SIZE` from 700 to 250 (`src/gen/world/params.ts`, not a docs/06 §3 pinned value) so a modest campaign has several region sites inside its own bounds instead of ~1. Both verified via the live gate: `generate-world-here` now reliably produces in-bounds settlements at Ashfall's scale.
2. **Line-canonization was dead, untested code.** `createLocationNoteWithSidecar` / the non-Point branches of `createLocationNoteFromFeature` and `canonizeFeature` were built specifically for the roadmap's "canonize a street" exit test, but `MapView.canonizeGeneratedNear` only ever searches Point features (no canon-line render layer exists yet to show a canonized street back on the map, so the UI path was deliberately Point-only) — meaning nothing called or tested the line branch. Rather than delete working, well-designed code, added a direct unit test (`generationService.test.ts`) exercising the full real path (not mocked): canonize a generated `LineString`, assert the sidecar `.geojson` is written with matching geometry and the note's frontmatter `geometry` field points to it. Live street-canonization via the UI stays deferred to Phase 4, which is also where canon-line rendering (a real, non-trivial addition: a canon-line layer, sidecar-geojson loading in `rescanLocations`, nearest-line hit-testing) belongs.
3. **A gate check's name oversold what it verified.** "regenerate-city-here after canonize: canon survives, surroundings regenerate" only asserted `index.size` was unchanged (canon survives) — it never actually checked that surroundings *regenerated*. Renamed to "...fabric actually regenerates" and added a real assertion: the tile's `city-street` features must differ (not byte-identical) before vs. after the forced regenerate, so a silent no-op regenerate would now fail loudly.
4. **Gate/unit-test split, made explicit** (already implicit in the gate's file header, recorded here too): the live CLI gate (`scripts/gates/phase3.ts`) verifies determinism against the real on-disk cache (`.mapcache/generated.jsonl` delete + regenerate, hash-identical) — an integration-level property unit tests can't touch. Seam correctness (2×2 adjacent-tile edge-crossing endpoints matching within ε) is *not* re-derived via the CLI; it's exhaustively covered by the 17 dedicated Vitest seam tests in `src/gen/{city,world}/*.test.ts`, which run against the exact same pure generator functions the live commands call. The live gate's "generated fabric renders alongside canon" check confirms the rendering pipeline works, not seam geometry a second time.
**Also fixed while chasing the above:** two flaky live-gate checks (`isStyleLoaded()` can transiently be `false` — `obsidian-native`'s `css-change` listener can rebuild the MapLibre style independently of any command the gate script issues, and `queryRenderedFeatures()`/`getStyle()` briefly return nothing/throw mid-rebuild; and `canonize-nearest-generated`'s index-size check raced the debounced vault-event → `rescanLocations()` chain). Both fixed by polling instead of a single fixed-delay wait — general robustness lesson for any future CLI gate touching `obsidian-native` campaigns or vault-reconcile timing.
**Reversibility:** all four are refinements to already-committed Phase 3 work, verified via two consecutive clean 11/11 gate runs plus a full 49/49 re-check across all four phase gates and 61/61 unit tests after the changes.

## 2026-07-08 — Phase 4 dispatcher: viewport-windowed tile store, zoom bands, worker wiring

**Decision:** Built the continuous-LOD dispatcher docs/03 Phase 4 calls for. Core design, an advisor review flagged before writing any code: `MapView`'s Phase 3 `generatedFeatures` was a flat array that only ever grew, merged by feature id — fine for one-tile-at-a-time manual commands, but under continuous pan-triggered dispatch it's both an unbounded-memory leak and a perf hazard (`source.setData()` re-parses the *entire* FeatureCollection on every merge, so cost grows with total tiles ever visited, not tiles currently on screen). Replaced with `Map<tileKey, Feature[]>` keyed `${band}:${tileX}:${tileY}`, evicted to viewport+margin on every `moveend`/`zoomend` (debounced 200ms), with in-flight requests deduped by tile key (not just a numeric requestId) so a re-crossed tile isn't re-dispatched and a result arriving after the tile panned out of view is discarded (`wantedTiles` snapshot checked on resolution).
**Zoom bands:** `src/gen/cache/tileGrid.ts`'s `bandForZoom()`/`generatorIdsForBand()` — world tier (regions/settlements/routes) below zoom 8, city tier (streets/districts/blocks) at/above it. Both bands reuse the same 600m `GENERATION_TILE_SIZE` grid rather than a separate coarser world-tile grid — these are small fictional campaigns (docs/06), not continents; deferred a dedicated world-tile-size grid until a real campaign's dispatch tile-count at low zoom actually demands it (see the margin-cap fix below for why this mattered sooner than expected).
**Worker wiring:** `generateTile()`'s generator parameter now accepts `Feature[] | Promise<Feature[]>`, so the dispatcher passes `(seed,bbox,constraints) => workerClient.generate(...)` through the exact same cache-read/cache-write path a direct synchronous generator call uses — no new cache-adjacent function needed. Falls back to direct main-thread generator calls if `GenerationWorkerClient.create()` fails (`plugin.getGenerationWorker()` returns null rather than throwing).
**Three real bugs found while getting the live gate green (not just gate flakiness — each is a genuine product-correctness issue Phase 3's gate never could have caught, since nothing dispatched automatically then):**
1. **Cross-band eviction wiped manually-forced tiles.** First eviction design deleted any loaded tile-key not in the current dispatch's `wanted` set, full stop — so a `generate-city-here` call issued while the camera is at a *world*-tier zoom (a legitimate, documented override, docs/03 3b) got erased by the very next automatic world-band dispatch pass 200ms later, since its `city:*` key was never going to be in a world-band `wanted` set. Fixed by scoping ordinary eviction to the *current* band's own key-prefix only, and only doing a full-store clear on a genuine band *transition* (tracked via `lastDispatchedBand`) — a manual override from the "other" tier now survives ordinary same-zoom dispatch churn, and still correctly disappears when the camera actually crosses into a different LOD tier.
2. **Uncapped prefetch margin caused a concurrency burst.** The eviction fix above surfaced a second, harder-to-see bug through its symptoms: at low (world-tier) zoom the on-screen viewport can span dozens of 600m tiles, and the original `margin = viewport-size * 0.5` scaled the prefetch radius with it — a single `moveend` at zoom 6 was dispatching **16 tiles × 3 world generators = 48 concurrent `generateTile()` calls**, each doing real async vault cache I/O. This wasn't just gate-script flakiness (though it caused plenty): it's the same "bound the work per dispatch" property advisor flagged for the tile *store*, showing up on the fetch side instead of the eviction side. Fixed by capping the margin at `GENERATION_TILE_SIZE * 2` regardless of viewport size — bounds concurrent in-flight generation at any zoom, at the cost of shorter look-ahead prefetch at extreme zoom-out (acceptable per docs/06: these are small campaigns, not continents).
3. **A pre-existing camera-reset race, invisible until something depended on live camera state.** `onOpen()`'s `map.on("load", ...)` handler unconditionally re-ran `applyCampaign()` (i.e. `fitBounds()` back to the campaign's default view) once the async MapLibre "load" event fired — a redundant safety-net call for the one case `setCampaign()`'s own synchronous `applyCampaign()` can't cover (a campaign set on the view before the map object existed). Harmless in Phase 3, where nothing was tied to live camera position between view-open and "load" firing. Became a real bug once the dispatcher existed: opening a campaign and immediately `jumpTo()`-ing elsewhere (exactly what both a test script *and* a GM clicking a search result right after opening the map would do) could have "load" fire *after* the jump, silently snapping the camera back and discarding whatever the dispatcher had started fetching for the jumped-to viewport. Fixed with a `campaignAppliedOnce` guard: the "load" handler's fallback only fires if `setCampaign()`'s own synchronous call hasn't already run.
**Gate-script robustness (not product bugs, but real fixes to make the Tier A gate itself trustworthy under the new continuous background load):** (a) `scripts/lib/cli.ts`'s `execFileSync` calls now set `maxBuffer: 50MB` (default 1MB) — a dense city-band tile easily produces hundreds of block/footprint features, and a gate check pulling the full `generated` array at city zoom was failing the eval round-trip outright, not just slowly; (b) `scripts/gates/phase4.ts` aggregates counts/id-fingerprints *inside* the browser context (`generatedCounts()`, `generatedIdFingerprint()`) rather than shipping full feature arrays across the CLI bridge, for the same reason, belt-and-suspenders with (a); (c) `scripts/gates/phase3.ts`'s `generate-city-here`/`generate-world-here`/canonize-index-update checks converted from fixed `setTimeout` waits to polling loops — the dispatcher's own background cache I/O now competes with a manual command's generation work and the vault-reconcile chain for the same async I/O queue, so a fixed budget comfortable in Phase 3 alone is no longer reliably enough; (d) that same file's "regenerate-city-here after canonize" check was comparing the *global* `generated` getter before/after, which the now-continuously-active dispatcher can independently churn regardless of what the check's own regenerate call did — rewritten to call `generateCityHere()` directly and diff its own scoped return value (full geometry, not just feature ids, since a street's id is a pure function of cell position and wouldn't change even if canon-avoidance altered its path).
**Also fixed while verifying screenshots (not a dispatcher bug, found via the same live-testing pass):** `dev:screenshot` captures the Electron window's composited back buffer, which macOS stops repainting once the window is backgrounded/unfocused — an agent driving Obsidian purely via CLI (never actually clicking the window) was capturing frames frozen from whenever the window was last visually frontmost, silently stale relative to live DOM/map state. `scripts/lib/cli.ts`'s `screenshot()` now runs `osascript -e 'tell application "Obsidian" to activate'` first. Separately, found and fixed a real theming bug this surfaced: `obsidian-native`'s `roadMinor` and `water` tokens both resolved to `--background-secondary` (literal color collision — generated streets rendered the same color as water, near-invisible against `--background-primary`); `roadMinor` now reads `--background-modifier-border` instead. See `review/001-generated-fabric-contrast.md` for the before/after and the residual Tier B craft question (is the new contrast level enough, or does it want a width bump too).
**Alternatives considered:** a separate, coarser tile-size grid for world-band dispatch specifically (would more directly address bug #2) — deferred; the margin cap solves the immediate concurrency problem with a two-line change, and a dedicated world grid is a bigger, cache-format-adjacent change better justified by an actual large campaign hitting the cap's limits, not a hypothetical one.
**Reversibility:** all fixes are localized (eviction scoping, margin cap, one boolean guard, one CSS token, gate-script robustness) — none touch the generator contracts, cache format, or determinism guarantees. Verified via repeated phase3.ts and phase4.ts gate runs (both 11/11 clean across multiple consecutive runs post-fix) plus the full 65/65 unit test suite.

## 2026-07-08 — Live user feedback on London: three real UX fixes

**Decision:** Jonah opened the app and flagged three things directly from a screenshot, mid-session. All three were real, fixed immediately:
1. **`modern-clean`'s land tuned #f8f7f2 → #eae7de.** Within the docs/06 §3 ±10% L/C-in-OKLCH tuning budget this file's header grants agents, logged here per that rule. Root cause: `roadMinor`/`roadMajor`/buildings all render white, and #f8f7f2 was close enough to white that roads/buildings barely separated from the land fill — which was also dragging down how legible `labelMajor` text looked even though its own color contrast ratio was technically fine in isolation. Real Google Maps' land tone is a soft gray for exactly this reason, not near-white — the fix moves `modern-clean` closer to its own stated inspiration, not away from it. `scripts/gates/phase2.ts`'s pinned-token assertion updated to match (was asserting the old value verbatim).
2. **Redundant place-card buttons.** "Open note" and "Edit" both just opened the same file — the only difference was which Obsidian view-mode it landed in. Collapsed to one "Open note" button that opens directly to source/edit mode (`{ state: { mode: "source" }, eState: { focus: true } }`), matching what "Edit" used to do; "reading mode open" wasn't a use case anyone asked for.
3. **Locations vanished entirely below their type's `zoomMin`.** `canon-point`/`canon-label` (and `generated-point`/`generated-label`) are correctly filtered to a type's designed zoom range (docs/06 §3 taxonomy) so a shop doesn't clutter a city-wide view — but that meant zooming out past a location's range made it disappear completely, unlike Google Maps' saved-place pins, which stay as a small dot at any zoom. Added `canon-point-far` / `generated-point-far` — a small, unlabeled circle filtered to *only* `zoom < minZoom`, so it never double-renders with the full-detail circle. Verified live: a `shop/tavern/venue` (zoomMin 14) and a `landmark` (zoomMin 10) both correctly show as small dots zoomed out to country-wide view (zoom 6), zero features in the full-detail layer at that zoom.
**Alternatives considered (far-zoom dots):** per-type icons instead of a plain dot (Jonah's message floated this) — deferred; a dot is the direct, low-risk fix matching the immediate ask, and per-type iconography is a bigger craft investment (icon pool integration, docs/02 §4's "theme template icons" tier) better done as its own pass rather than bundled into a quick live-feedback fix.
**Reversibility:** all three are small, localized, and independently revertible. Re-ran Phase 0/1/2/3 gates after the changes (all green) — full results logged in PROGRESS.md.

## 2026-07-08 — Campaign creation, naming-culture, and basemap UI: closing a total UI gap

**Decision:** Three consecutive Jonah messages named the same underlying gap from different angles: "how do i create a new map, download map data, change themes of a map, etc? no UIUX right now", then immediately after, "how do i change what the naming generator is doing, i didn't know there even was a naming generator." Checked before building anything: `switch-campaign-theme` already existed as a command (just undiscoverable — Command Palette only, no ribbon icon), but campaign creation, naming-culture selection, and basemap acquisition had zero UI of any kind — creation meant hand-authoring a `*.map.md` note's frontmatter from memory, and naming culture had no config surface at all (`cultureAt`/`culturesForGenre` always used every culture matching the derived genre). Asked Jonah which pieces to build via AskUserQuestion rather than assuming scope; he asked for all four (create-campaign modal, naming picker, control panel, and — explicitly — the basemap download flow, including sign-off for the risky part).
**What shipped:**
1. **`CreateCampaignModal`** + "Create new campaign" command/ribbon icon — prompts name/world-type/theme/seed, writes `Campaigns/<Name>/<Name>.map.md` + `Locations/` + `Sessions/`, matching docs/02 §3's vault layout exactly (not a simplified version of it).
2. **`CampaignControlModal`** ("Campaign settings" command/ribbon icon) — theme switch, naming-culture toggles, basemap status, all in one discoverable place instead of scattered commands.
3. **Naming cultures are now a real per-campaign setting.** `namingCultures` frontmatter field (`CampaignConfigSchema`); `culturesForGenre()`/`cultureAt()`/`buildCultureCenters()` take an optional `restrictTo`/`activeCultureIds` that narrows generation to the chosen subset, falling back to the full genre set if the restriction is empty or doesn't intersect the genre — a UI bug or stale id can never zero out naming entirely. Verified live, not just unit-tested: toggling off `fantasy-sunlit` on a fresh fictional campaign changed QuickAdd's suggestions from mixed-culture to brackish-only ("The Drowned Blackathreach", "Drownfenhold", "Saltinreach").
4. **Found and fixed a real bug while wiring the above through:** `generationService.ts`'s `generateTile()` built its `GenerationConstraints` without ever setting `namingGenre` — so `settlements.ts`'s `constraints.namingGenre ?? "fantasy"` fallback meant *every* campaign, including real-city ones (London), silently generated fantasy-genre settlement names regardless of actual crs/theme. This was latent since Phase 3; nothing had exercised it because no per-campaign naming config existed to reveal the gap until now. Fixed by deriving `namingGenre` from `genreForCampaign(campaign.config.crs, campaign.config.theme)` at the same call site. Regression-tested directly: spy on the generator, assert `namingGenre === "modern"` for a real-crs campaign.
**Basemap: the deliberately incomplete part.** Jonah authorized building the download flow, but building it fully isn't safe to do autonomously: the `pmtiles` npm dependency (v3.2.0, already in the project) is read-only — no extract/write API exists in pure JS — and the only way to cut a real extract is the `pmtiles extract` CLI, a compiled Go binary (same one DECISIONS.md 2026-07-07 required explicit sign-off to download and run, because executing a binary I found myself is a materially different risk than fetching inert data). Auto-downloading and executing that binary from inside the plugin would also violate the locked "Vault/DataAdapter APIs only, never Node fs" architecture (keeps mobile possible). So the shipped basemap UI is the safe subset: (a) a dropdown to attach any `.pmtiles` file already present in the vault (pure Vault API, no binaries), and (b) a guided command generator — bbox pre-filled from the current map viewport, today's date for Protomaps' daily build URL, a "copy command" button — that produces the exact command for Jonah to run himself, same mechanism as how the London basemap was actually cut. Explained this tradeoff back to him rather than silently building a narrower version of what he asked for.
**A second real bug found during live verification (not caught by unit tests, since it's a timing issue unit tests with a fake adapter can't reproduce):** the create-campaign auto-open callback called `rescanCampaigns()` immediately after `vault.create()`'s promise resolved, assuming the metadata cache would already have the new file's frontmatter parsed. It doesn't — `metadataCache`'s frontmatter parse is a separate, later event, not synchronous with `vault.create()` resolving. Live-driving the exact flow via the Obsidian CLI reproduced it directly: the note was written correctly to disk, but the newly created campaign silently failed to open, no error surfaced anywhere. Fixed by awaiting the `metadataCache` "changed" event for the new file (3s-bounded fallback) before looking the campaign up; also added `console.error` alongside the existing failure `Notice` in the modal's catch block, since Notices auto-dismiss and leave no trace — this exact gap is why a live error Jonah saw mid-session couldn't be retroactively diagnosed from Obsidian's own state.
**Reversibility:** all additions are new files/fields (`namingCultures` is optional, defaults preserve prior behavior for every existing campaign) except the two bug fixes, which are narrowly scoped (one constraints field, one async ordering guard). Verified via Phase 2 gate (15/15) and Phase 4 gate (11/11), full unit suite (74/74, up from 65 — nine new tests covering the restrictTo fallback behavior and the namingGenre regression), and live end-to-end verification of every new UI surface through the Obsidian CLI (create campaign → auto-opens; toggle naming culture → QuickAdd suggestions actually change; attach/view basemap on London; copy-command bbox reflects live viewport).

## 2026-07-10 — Zoom legibility redesign: three focus levels + depth-of-field labels

**Decision (Jonah-authorized, relitigates a docs/06 §3 pinned default):** Jonah found the per-type continuous zoom ranges "too complex to use quickly" and asked to cut down to (a) three "focus levels" with +/- snap buttons plus free scroll for granular zoom, and (b) three label categories by how many focus levels show a name — "at all 3, only 2, or only 1" — with the dot always present as a small "bokeh" marker at every zoom, categories genre-neutral, zoom levels that "work for all maps" (London as the example).

**What shipped:**
1. **Depth-of-field buckets** replace `zoomMin`/`zoomMax` label gating: `focus: deep|medium|shallow` derived from type (`TYPE_FOCUS` in `locationNote.ts`), overridable per-note via `focus:` frontmatter. deep = named at all three focus levels, medium = Mid+Close, shallow = Close only. Reveal is *nested* (zoom in → more names light up). `importance` still drives label size + collision priority. `zoomMin`/`zoomMax` kept only for incidental camera math (search fly-to, generation-band split), no longer for labels.
2. **Three bucketed label layers** (`canon-label-deep/medium/shallow`, same for `generated-`) via a shared `focusLabelLayers()` so canon and generated stay byte-identical (F2). Filters are **kind-only** (`["==",["get","focus"],depth]`); the reveal floor is each layer's numeric `minzoom`. Zoom is never in a filter — this is the exact class that blanked the style twice (013/014); the new `canonLayers.test.ts` is the tripwire, and `styleValidation.test.ts` + the styleLoad gate cover it too.
3. **Focus levels are per-campaign relative, not absolute.** Measured live: fit-zooms diverge hard — London 11.5, Ashfall 4.7, Nightreach 5.1 — so absolute levels (e.g. 11/14/17) would jump a fictional world 6 levels past its overview. Levels = `[overview, overview+3, overview+6]`, captured right after `fitBounds`; reveal floors (medium = overview+1.5, shallow = overview+4.5) pushed onto the layers via `setLayerZoomRange` (a live per-layer update, re-applied after every restyle since `setStyle` wipes zoom ranges). This is why the buckets can't be baked into the built style — the overview zoom isn't known until the camera is fit.
4. **Focus stepper UI** (`buildFocusControl`, bottom-right): `+`/`−` snap to the prev/next focus level via `easeTo`, with a three-dot `●○○` readout of the current level. Free scroll/trackpad zoom is untouched.

**Alternatives considered:** absolute focus zooms (rejected — the live fit-zoom measurement showed fictional vs real diverge by ~6 levels; "works for all maps" required relative). Zoom-in-a-paint-`case` for reveal (rejected — `["case",[">=",["zoom"],...]]` is the forbidden zoom-nesting class; bucketed-layer `minzoom` is the safe pattern the codebase already learned). A `maxZoom` cap so deep labels drop out when zoomed in (rejected — contradicts "labeled at all 3 levels"; MapLibre's collision engine handles clutter via `symbol-sort-key` + `text-optional`).

**Live-verified (not just unit tests — the style-load class is invisible to `npm test`):** full Obsidian reload, `isStyleLoaded() === true`; London reveal by `queryRenderedFeatures` — Wide: no minor labels; Mid: landmark "Baker Street Bookshop" reveals; Close: shop "Kings Arms" reveals. Ashfall (fictional) got relative focus `[4.7,7.7,10.7]` with "Ashfall City" (deep) labeled at Wide and its other locations as bare dots — screenshot in `shots/focus-london-mid.png`. Focus stepper snaps through the three levels; readout tracks. `dev:errors` clean. 195 unit tests pass (+8).

**Reversibility:** additive (`focus` field/frontmatter optional; `zoomMin`/`zoomMax` retained). The label-layer split and the removal of the old `zoomFilter` (`["get","minZoom"] <= ["zoom"]`, itself a latent zoom-in-filter instance) are the substantive changes; both are localized to `canonLayers.ts`/`generatedLayers.ts` and covered by tests.

## 2026-07-10 — Plan 017: dedicated per-kind fabric colors (six kinds, six colors, five themes)

**Decision (Jonah's #1 visual complaint):** "can't really tell the difference between roads / walls / river / water / district / park … in any theme." Root cause: fabric kinds borrowed unrelated tokens — `river` used `water` (identical), `park` used `roadMinor` (a road color), `wall` used `labelMinor` (a text color), `district` used `poi` (which in neon-sprawl *is* the road cyan). Added six dedicated fabric tokens to `ThemeTokens` (`fabricWater/River/Road/Wall/Park/District`), set genre-tuned values for all four handcrafted themes (pinned table added to docs/06 §3), and rewired `fabricLayers.ts` to use only these. Palette discipline (quality-bar F6, ~≤8 semantic colors) kept by *reusing shades of existing hues* where they read (fabric-water = the theme water in modern-clean/parchment; fabric-road = road-major in parchment/ink-soot/neon-sprawl, casing-gold in modern-clean) and inventing hues only where the palette had none: park green, wall stone, river-vs-water shade, district wash.

**Per-theme intent:** modern-clean = Google grammar (gold sketched arterials vs white generated streets, pale park green, AOI-peach district wash). parchment = hand-drawn atlas (blue-gray river ink over sage water, olive parks, dark stone walls, dusty-rose region tint). ink-soot = noir (steel-blue river, moss parks, sandstone walls, smoky-violet districts; fabric-water lifted bluer than the pinned basemap water — #14181c on #22211f land was nearly invisible for a *sketched* harbor). neon-sprawl = neon-noir (electric-blue river vs cyan roads, warning-orange perimeter walls, synthetic-green parks, low-opacity purple district wash — kept 0.18 per the purple-slab lesson in generatedLayers.ts; fabric-water #10344a because the pinned #101820 is indistinguishable from the #0d0d11 land). obsidian-native derives at runtime: road = `--text-muted`, district = `--interactive-accent` wash, and water/river/park/wall from a light/dark neutral pair chosen by background luminance (Obsidian CSS vars carry no reliable green/blue to derive from).

**Extra paint choices:** fabric-water's `fill-outline-color` is now the river hue (shoreline definition; rivers stay coherent entering a lake); park opacity 0.35→0.45 (colors are now purposeful, the wash can afford to read); district 0.15→0.18 (still far below slab territory).

**Constraints respected:** paint-only change (themes own ALL paint; no color on features); no `zoom` in any filter, no nested zoom interpolate — untouched; all styles still pass `validateStyleMin` (styleValidation.test.ts, 10/10). New regression test: `fabricLayers.test.ts` asserts six pairwise-distinct fabric colors in every handcrafted theme *and* in obsidian-native under both stock dark and stock light CSS values (201 tests total, green).

**Alternatives:** per-kind casing/double-stroke treatments (deferred — color distinctness is the must-ship core; casing is craft-budget polish); making the new tokens optional with fallbacks (rejected — required fields force every future theme to answer the six-kind question at compile time).

**Reversibility:** additive tokens + localized paint edits in `fabricLayers.ts`/`theme.ts`; fully revertible per theme. Live cross-theme screenshot verification deliberately left to the orchestrator (plan 017's verification note).

## 2026-07-10 — Explicit `visibility` field, decoupled from `type` (plan 015)

**Decision (Jonah-authorized — the correction in plan 015):** Jonah asked to stop deriving label visibility from `type` ("i don't want to keep a mental model of what type is visible at what levels… it's just another friction point"). Label visibility is now an **explicit, first-class note field**: `visibility: wide|mid|close` in frontmatter, set in a prominent picker in QuickAdd and editable one-click from the place card. It maps 1:1 to the internal depth bucket (`wide→deep`, `mid→medium`, `close→shallow`) at the parse boundary in `locationNote.ts`; the runtime gate (feature `focus` property, the three bucketed label layers, their `minzoom` reveal floors) is **untouched** — this plan only changes *which bucket a note lands in and how that's decided*.

**What changed:**
1. **`type` no longer gates visibility.** `parseLocationNote` resolves `focus` from explicit `visibility` → else legacy `focus:` → else the single global default **`mid`/medium** (`DEFAULT_VISIBILITY`). It is **never** `focusForType(type)` anymore. Changing a note's `type` alone does not change what's visible.
2. **`focusForType` survives only as a pre-selection hint** — `defaultVisibilityForType(type)` seeds the QuickAdd picker and gives generated/imported features a sensible explicit value. Nothing reads it as a runtime gate.
3. **Explicit write everywhere.** `createLocationNote`/`…WithSidecar` take a `visibility` (defaulting to the type hint) and write it into frontmatter + the mutation log (replay parity). QuickAdd writes the GM's chosen value. The **canonize path** (`createLocationNoteFromFeature`) carries the generated feature's `focus` prop → explicit `visibility`, so a canonized city stays as visible as its pin was (this was the one behavioral-regression risk the decoupling introduced). Place-card edit (`setLocationVisibility`) writes `visibility` and deletes any legacy `focus` key so a note never carries two sources of truth.
4. **Zod stays strict.** `visibility: z.enum(["wide","mid","close"])` — an unknown value fails the whole parse → warning badge (the "never a silent drop" discipline), NOT a soft coerce-to-default that would mask a typo.

**Alternatives considered:** (a) rename the internal `FocusDepth` enum (`deep/medium/shallow`) to `wide/mid/close` everywhere — rejected: drags in `canonLayers` filter values, `FOCUS_REVEAL_ZOOM_DEFAULT` keys, `generatedLayers`, `styleValidation`, i.e. the exact zoom-blank blast radius; the boundary-mapping keeps the runtime layer stable. (b) Keep the frontmatter key `focus` but only relabel the UI — rejected: `visibility` reads plainly and the GM-facing values (`wide/mid/close`) tie to the +/- focus-stepper's own Wide/Mid/Close vocabulary. (c) Segmented control vs. dropdown in QuickAdd — chose a dropdown with self-explanatory option labels (fully satisfies the plan; no fiddly active-state CSS).

**Live-verify (orchestrator, not run here):** add a location choosing each of Wide/Mid/Close; confirm the name reveals at the right focus level (Wide always; Mid from the Mid step; Close only at Close). Confirm a note with no `visibility` behaves as `mid`. Confirm changing a place card's visibility updates the map without a manual frontmatter edit, and that a canonized generated city keeps its Wide-level name.

**Reversibility:** additive and back-compat — legacy `focus:` frontmatter still parses; the feature schema and label layers are unchanged. Removing the feature = drop the `visibility` schema key + picker and restore `focus: fm.focus ?? focusForType(fm.type)`. Typecheck + full suite green (197 tests).

## 2026-07-10 — Fabric LOD floors made relative to campaign overview (fix: "can't see parks/walls")

**Bug (Jonah, on Ashfall):** "i don't see the different colors for parks — check others as well." Not a color bug (obsidian-native park = #5d7a4e green, all six kinds distinct). Root cause: plan 013's `DEFAULT_FABRIC_MINZOOM` is **absolute** MapLibre zoom (park 10, wall 11), calibrated for a real city (~z11 overview). A fictional world (Ashfall overview z4.7, Nightreach z5.1) rarely reaches z10–11, so its two finest fabric kinds — park and wall — never render at any zoom the GM actually uses. Confirmed live: at z8 on Ashfall, water/river/road/district render but park=0, wall=0. This is the exact same absolute-vs-relative-zoom problem already fixed for the depth-of-field label focus levels.

**Fix:** fabric reveal is now **relative to the campaign overview**, mirroring `applyFocusReveal`. Added `FABRIC_REVEAL_OFFSET` (`src/model/fabric.ts`): water/river 0, district 0.5, road 1, park 1.5, wall 2 — coarse→fine ordering preserved but **compressed to ≤2** so all six appear within a gentle zoom-in of overview rather than requiring extreme close-up. `MapView.applyFabricReveal()` sets each `fabric-<kind>` layer's `minzoom` to `overview + offset` via `setLayerZoomRange` (the live per-layer update, never a filter), called at every site `applyFocusReveal` is (captureOverviewZoom + load + both styledata handlers), so it survives restyle. The baked absolute `DEFAULT_FABRIC_MINZOOM` stays as the fallback for offscreen export (no live overview).

**Verified live:** after the fix, Ashfall (overview 4.7) fabric floors = water/river 4.7, district 5.2, road 5.7, park 6.2, wall 6.7; at z7 all six kinds render (park + wall included). Applies to every campaign — a real city (London overview 11) gets park at 12.5, wall at 13, still sensible for street-level detail. Typecheck + 217 tests green (added `FABRIC_REVEAL_OFFSET` ordering/compression tests).

**Reversibility:** additive (offset table + one MapView method + four one-line call additions); revert = drop `applyFabricReveal` calls, layers fall back to the baked absolute minzooms.

## 2026-07-10 — LOD only hides location names; fabric always visible (Kanto-test decision)

**Decision (Jonah, after the Kanto overworld test):** "everything should be visible at every LOD/zoom level" → clarified to "**LOD should only impact visibility of location names**." So zoom-based hiding now applies to ONE thing — location-name labels (the depth-of-field `visibility: wide/mid/close` system, kept as-is). Everything else — every sketched fabric kind (road/wall/river/water/district/park) and every location dot — renders at every zoom, never gated by kind/type.

**What changed:** removed all fabric zoom-LOD. `fabricLayers.ts` layers no longer carry a `minzoom`; deleted `MapView.applyFabricReveal()` + its 4 call sites; deleted the now-dead `DEFAULT_FABRIC_MINZOOM` / `defaultMinZoomFor` / `FABRIC_REVEAL_OFFSET` from `fabric.ts`. The `fabric` source keeps its `tolerance` (that's geometry *simplification* for perf when zoomed out — fewer vertices — NOT hiding; the feature always draws). This supersedes the two prior fabric-LOD steps (plan 013's baked minzooms and the 2026-07-10 relative-reveal fix `331362c`).

**Kept:** the depth-of-field LABEL system (bucketed canon/generated label layers + `applyFocusReveal` + the `visibility` field) — names still reveal by zoom, which is the one place LOD is wanted. Location dots stay constant/always-on. `importance` still drives label size + collision priority (that's sizing/collision, not zoom-hiding).

**Left in place, flagged for a follow-up decision:** two non-fabric, non-name minzooms — `generated-footprint` (procedural building footprints, z14) and the real-city basemap buildings (z14). Removing them means drawing every building at region zoom (real perf/clutter cost), so they're out of scope for "sketched fabric + names"; revisit if "everything" should extend to procedural/basemap building detail.

**Live-verified:** full restart → on Kanto at the overview zoom (z4.6) all six fabric kinds render (park/wall were 0 before) while only the two `wide` town labels show and the `mid` ones (Route 1, Viridian Forest) stay bare dots — LOD confined to names. No fabric layer carries a minzoom. `dev:errors` clean; styleValidation + 212 tests green.

**Reversibility:** the removed machinery is recoverable from git (`331362c`/`70fb361`); re-adding a `minzoom` per fabric kind restores gating.

## 2026-07-11 — Procgen v3.0 kickoff (domains + skeleton) — deviations & judgment calls

**Context:** executing `procgen_v3_design.md` (city-scoped deterministic growth rewrite). Phase v3.0 scope: manifest domains, cost field + Stage-A skeleton (arterials/waterfront/bridges/plaza), host wiring, replay grouping.

- **Legacy city generators stay ON for domain tiles — EXCEPT `city-street`** (design §2/§9 transition, sharpened): the v3 per-tile street clip uses the SAME cache key (`seed:x:y:0:city-street`) as the legacy streamline generator, so two writers on a domain tile would be last-write-wins nondeterminism — a determinism-gate failure by construction. On domain tiles the network clip owns the `city-street` record and the streamline generator is excluded (`DOMAIN_SUPERSEDED_LEGACY_IDS`); districts/blocks stay legacy until v3.2. Non-domain tiles and the world tier are untouched. The render store keys domain clips under a separate `domnet:` namespace so the two coexist without eviction fights.
- **`generateFabricHere` gained `opts.domainChoice`** — the headless path that founds a domain without the profile modal. Rationale: every Tier-A gate drives generation via `eval`/commands; a Modal awaiting a click would hang CLI automation (the same OS-trust class as the Phase-1 right-click finding). Interactive flows (palette/menu/toolbar) omit it and get the modal, exactly as designed.
- **`defaultProfileForTheme`: `obsidian-native` (and unknown themes) → `euro-medieval`.** Design §3.1 pins parchment/ink-soot → euro-medieval and modern-clean/neon-sprawl → na-grid but is silent on obsidian-native; euro-medieval is the fantasy-leaning default and the modal makes it one click to change.
- **"Clear city domain here" is right-click-menu only for now** (design §3.2 calls it a menu item; palette parity is a one-liner later if wanted).
- **`routeHints` host threading deferred** (design §5.0 marks it optional): `GenerationConstraints.routeHints` exists and skeleton consumes it, but MapView does not yet mine world-route output for endpoints — absent hints → hashed compass bearings, as specified. Logged as a v3.3+ nicety.
- **Regenerate-here on a domain tile regenerates the WHOLE domain** (network + every manifest tile of it), not just the clicked tile: growth is globally coupled within the disc, so per-tile regen would leave sibling tiles clipped from a stale network. Same rule for sketch-edit auto-regen (design §7.3's influence-radius = the domain disc).
- **Clear-here on a domain tile clears that tile's records but keeps the domain + network record** (clear-here clears *tiles*; Clear-domain clears the city). A later generate inside the disc re-clips from the surviving network.

## 2026-07-11 — Procgen v3.1 (growth loop) — deviations & judgment calls

- **Cityness split:** v3.1 ships the minimal field (center falloff × noise) because growth needs it for priority/extent; canon-Location bumps + outskirts move to v3.3 as designed.
- **CityProfile gained `segmentLen`, `branchProb`, `edge`** — §6's table lists no step length, branch probability, or growth-extent threshold; growth needs all three. Values documented in profiles.ts.
- **Tensor field + heightAt seeded by citySeed, not campaignSeed** (D6: the pure network contract carries no campaign seed). Deterministic; costs only cross-domain field alignment with the world tier — acceptable until someone notices, then thread campaignSeed as an explicit constraint field.
- **`maxSegments` never binds at radius 900** (space saturates ~2184 segments via snapping) — kept as the D3 hard bound, not a tuning knob.
- **Skeleton pre-seed polylines are not mutually planarized on insert** (arterial×arterial crossings away from the center stay unnoded); growth cuts them where it meets them. Full planarization is v3.2's faces prerequisite — MUST land there or face extraction will see phantom crossings.
- **Perf headline:** lazy/memoized cost field took generateCityNetwork from ~1460 ms (v3.0) to **~87 ms** (v3.1, radius 900 incl. growth). 200-domain fuzz ≈ 94 ms/domain.
- Gate-harness learnings (procgen30/31): Obsidian's `delete` command can't see dot-folder files → gates `rmSync` the cache (truer simulation anyway); `queryRenderedFeatures` checks need the window fronted first (macOS occluded-window compositing — same class as the Phase-4 dev:screenshot gap).

## 2026-07-11 — Procgen v3.2 (faces/parcels/footprints/wards) — deviations & judgment calls

- **Founding a domain now generates ALL tiles the disc overlaps**, not just the clicked one (design §7.1 said "tile entry", singular). Screenshot review made the call: painting one 600 m tile of a 1.8 km city reads as a bug ("I asked for a city, got a rectangle"). One click = one whole city; the batch shares ONE network compute + one cache-file read (`generateDomainTiles`), and each new tile still logs its own `generate-area` record so single-step undo semantics are unchanged.
- **Footprint/parcel zoom-gating made RELATIVE to the campaign overview** (footprints overview+4, parcels +5, via `applyFocusReveal`'s existing lifecycle). The baked z14/z15 minzooms are real-city calibrations a fictional overview (~z4.5) never reaches — the same absolute-vs-relative trap as the retired fabric reveal. This is §8 perf gating of generated building DETAIL (12k+ tiny polygons per domain), not fabric-kind hiding; the Kanto "LOD only hides names" ruling left the footprint minzoom explicitly open. Flag for Jonah: if "everything visible" should extend to building detail at overview zoom, remove both setLayerZoomRange calls + the baked minzooms.
- **Wards reuse generatorId `city-district`** so they inherit the legacy district paint layer unchanged; the legacy Voronoi district + block generators stopped running on domain tiles (all three legacy city ids are domain-superseded now). Legacy still serves pre-v3 manifest entries without a domainId.
- Subagent deviations (full list in its report, all sane): ward sites are plaza+arterial arc-length points (not literal junctions); "gate" ward tag deferred to v3.3; ~13 self-touching faces per city counted-and-skipped (pockets around cul-de-sac tips — revisit at v3.3 screenshots); skeleton polylines resampled to 8 m for the graph only; water-centroid blocks dropped (docs/04 guard); footprint depth capped 0.85×width so frontage alignment holds by construction; `parcelMinFrontage` applied as footprint-eligibility filter, not a split stop.
- **Quad share 63% vs the <70% gate** — passes but thin; watch when v3.4 tunes profiles.
- Feature volume: ~15 k features/domain (3.96 MB artifact, §3.3 fine). Per-tile counts (~1700) exceed the §8 "~2×" note; mitigated by the relative minzoom gates. Live pan after a full-domain paint stayed responsive in gate runs; phase4's fps gate re-verifies at v3.4.

## 2026-07-11 — Procgen v3.3 (cityness/outskirts/walls/gates) — deviations & judgment calls

- **Ring/wall via polar interpolation through gate points** (network distance = arc length along each arterial), not a BFS lattice contour — same §5.1.5 observables (closed ring, gates exactly on ring∩arterial, ~ringRadius), fraction of the cost. Revisit only for terrain-hugging walls.
- **Outskirt field band is lateral** (beyond the ribbon cottages, off the road) rather than a farther longitudinal arc — arterials end at the rim, a longitudinal band mostly fell outside the domain.
- **`edge` growth-extent thresholds raised** (e.g. euro-medieval 0.12→0.22) so a real countryside annulus exists; city core ends ~0.8–0.85 R. Screenshot-reviewed; flagged for Jonah in review/009.
- **Only GROWN streets are gate-restricted at the wall** — arterials cross at gates by construction; waterfront quays may cross (water gates). Sensible; documented.
- Cityness canon bumps: settlement-type Locations (city/town/village) 0.15–0.3, other canon Points 0.05–0.1; also modulates snap distance (1.25−0.5c) and parcel minArea — curves are ours, §5.4 names the knobs without formulas.
- `wallChance` profile param added for euro-continental's hashed "optional" wall; ward "gate" tag by cell-contains-gate.
- Paint: generated walls share the sketched-wall stone token (F2), gates are 3 px stone dots (never Locations, I4), farm fields are park-hue at 0.12 opacity.

## 2026-07-11 — Procgen v3.4 (profiles + cleanup) — deviations, real bugs found, gate modernization

- **Profile signatures shipped** (subagent): na-grid per-quadrant hashed azimuth pairs replacing the tensor prior (+ pass-through crossing cuts, grid profiles only — required to flip the histogram to 4-way-dominant: 338 X vs 255 T); na-suburb `snapProb` 0.55 (unsnapped ends ARE the cul-de-sacs) + octagonal court bulbs (185 at r900); alleys as connect-or-discard segments (euro-medieval 63, na-grid 26 — never dangle, protecting the connectivity gate); euro-continental verified per §6. Quad share improved to 61.7%.
- **Dead v2 code deleted** (§5.5): districts.ts, blocks.ts, generateCityStreets + tests. Survivors: tensorField (orientation prior), streamlines + corridor.ts whole (sketch-corridor elaboration is still live), fabricConstraints, voronoiCells. Host references removed first so the tree never broke. Legacy worker/direct maps are world-only; `legacyIdsFor("city")` returns [] — pre-v3 city manifest entries render from surviving cache records only, with a Notice pointing at "Generate fabric here" on a miss.
- **Ward sketched-district contract restored**: v3 wards now drop sites inside GM-drawn district polygons (the plan-019 "you've claimed that ground" rule the deleted legacy generator carried; the subagent flagged the gap, host threaded constraints into buildWards).
- **REAL BUG (double-paint aliasing)**: generateTierAt stores its returned array by reference in the render store; generateFabricHere pushed domain features into that same array — every domain feature was silently duplicated into the legacy tile entry (double-painted live, replay-vs-live id-set mismatch). Caught by phase4's modernized revisit-determinism check; fixed by copying.
- **REAL BUG (cache write race, latent since plan 019)**: `appendCachedTile`'s exists→append-or-write is not atomic; two concurrent generators (replay's Promise.all) racing on a freshly DELETED cache file both took the truncating `write` branch — last writer clobbered the first record (world-region vanished; a worse interleaving produced a byte-diff "determinism failure" that was actually file corruption). Fixed with a per-file promise write-chain in tileCache.ts. The delete-`.mapcache/`-and-replay gate now passes deterministically in the exact failing flow.
- **Gate modernization**: phase3 + phase4 still tested pre-plan-019 machinery (canonize commands, per-tier generate commands, the viewport dispatcher, band eviction) — stale since 019, passing only by state-dependent luck. Rewritten to assert the CURRENT contracts (canonize-gone, explicit-only pan, tier coexistence, request-bounded tile store, replay determinism on file records, regenerate-adapts-to-canon). procgen34's live na-grid domain moved to sketch-free ground (sketched pre-seeded roads legitimately jog a grid — the clean-flip assertion wants open land).
- **Final board (fresh Obsidian process per gate — the documented long-session renderer degradation makes back-to-back gate runs in one process fail spuriously on render checks; restart clears it, unchanged since Phase 4):** unit suite 276/276 · phase0 10/10 · phase1 16/16 · phase2 15/15 · phase3 13/13 · phase4 11/11 · phase5 8/8 · styleLoad 5/5 · procgen30 13/13 · procgen31 11/11 · procgen32 12/12 · procgen33 11/11 · procgen34 12/12 · test:app 8/8.
- Fixture care: gate runs drift dev-vault location notes (a connection-removal check ate Ashfall City's demo connections; a visibility write stamped Gatetown) — reverted; gates could use a fixture-restore epilogue someday.

## 2026-07-12 — Plan 020 v4.0 (sketch-driven procgen regions: pure core) — deviations & judgment calls
- **`generateCityNetwork` signature gained an explicit `profileId`** — the profile
  used to ride on CityDomain; with regions it lives in registry params, so the
  citynet entry takes it as an argument. The registry's `generate()` matches
  plan 020 §5 exactly.
- **Wall/ring wobble removed**: the ring road + wall now trace
  `insetRing(region, …)` — the inset of the GM's sketched outline. Polar wobble
  is meaningless on a hand-drawn boundary. Wall-quad count halves on the disc
  fixture (fewer, longer segments); flag for aesthetic review at v4.2 screenshots.
- **Real (latent) v3 bug fixed in growth**: the wall-crossing check ran on the
  raw proposed segment only; snap/trim could then move an endpoint across the
  ring. Exposed by inset-ring corners; now rechecked on the final segment with
  the endpoint interval excluded (ring T-junctions survive). "No street crosses
  the wall away from a gate" is now actually enforced.
- **Wards on concave regions**: convex regions clip ward cells to the ring;
  concave regions drop cells with any vertex outside (deterministic, may leave
  coverage gaps near notches — known v1 limitation, screenshot check at v4.2).
- **`interiorT` may dip slightly below 0 near the true pole** (10 m lattice
  underestimates maxInteriorDistance); all consumers tolerate it; don't surface
  raw values in UI without clamping.
- Ruling trail: extra derived region fields, gate-as-ring-vertex representation,
  `clipPolylineToRegion` multi-part arterials, concave ward strategy — all
  orchestrator-approved before implementation.

## 2026-07-12 — Plan 020 v4.1 (host lifecycle) — deviations & judgment calls
- **`generateRegionTile` takes `tileGeneratorIds` explicitly** rather than the
  FabricFeature (host resolves the algorithm once; service stays dumb).
- **`createRegionForTest(ringUnits, algorithmId, params, name?)`** is the
  headless modal bypass for gates (modal hangs CLI automation — same split as
  the old `domainChoice`). Consequence: overlap-reject/invalid-ring Notices and
  the modal itself have no automated coverage; the geometry beneath them is
  unit-covered in region.ts. Manual/visual check owed at v4.2.
- **Undo asymmetry kept** (matches generate-area/clear-area precedent):
  `sketch-procgen-set` undo appends a `sketch-procgen-clear`;
  `sketch-procgen-clear` undo restores without appending — no undo ping-pong.
- **Live Vespergate migration ran as the real test**: `dom:-8:10` (Jonah's
  city, founded 2026-07-12) → district feature `fabric-mri7r4bj-ll0bd5` with a
  city procgen block; seed carried over via `citySeedFor` so the city keeps its
  identity. Manifest domains now `[]`; the 5 hand-sketched inert districts
  untouched. The migrated dev-vault state is committed as the new baseline.
- Gate procgen40 10/10 (containment 2900 features outside:0, migration,
  byte-identical replay after rm .mapcache, pan Δ0, remove-city persistence,
  dev:errors clean). Gate lesson: `plugin:reload`, never `plugin:enable`
  (enable is a no-op when already enabled → stale code).

## 2026-07-12 — Plan 020 v4.2 (edit UX) + two Jonah rulings — deviations & judgment calls
- **Jonah ruling (LOD)**: "small buildings pop in and out at different zooms —
  i'd rather they always show." Zoom gating removed from `generated-footprint`
  and `generated-parcel` (baked minzoom + the applyFocusReveal relative-reveal
  overrides). Generalizes the Kanto-test ruling to generated fabric: zoom LOD
  affects location names only. Overview readability checked (fine urban
  texture, not noise). Perf on Surface Pro at 12k+ always-on polygons is
  unmeasured — if 60fps breaks, fix is paint treatment (opacity ramp in
  themes), NOT re-adding zoom gates.
- **Jonah ruling (city center)**: plaza/arterial anchor is now a persisted,
  GM-draggable point (optional `params.center` on the city procgen block;
  absent = automatic). Measured stability win: boundary-vertex-edit street
  overlap 45–49% without a stored center vs 60–69% with one. Distinct circular
  handle (not a glyph — font/zoom-scaling robustness); Reset center returns to
  automatic byte-identically.
- **Plan-020 gate (b) reframed**: ">50% id-overlap after a vertex edit" is
  unattainable with a centroid-anchored skeleton (edit ≈ re-roll spatially,
  ~46% vs ~47%) and clip-ids are re-minted per ring — comparison is
  coordinate-bucketing, and the asserted invariants are seed preservation,
  byte-determinism, containment, and with-center > without-center stability.
  Fuller fix (geometry-stable growth anchoring so only the rim re-flows) is
  generator work — queued as an open question.
- **Undo is single-level on sketch-edit/procgen-block entries** and dead-ends
  the chain (matches pre-existing undoLastEdit single-shot; true multi-level
  needs an undo cursor — out of scope, noted as regression on what is now the
  primary gesture). No-op-edit guard prevents a bare vertex click from wedging
  Cmd-Z.

## 2026-07-12 — Plan 020 v4.3 (consolidation) — judgment calls & provenance
- **Gate consolidation**: procgen30–33 → procgen42 ("sketch-driven city
  content": one river-straddling district proves skeleton/growth/faces/
  parcels/wards/walls/gates/bridges/containment/lifecycle on the CURRENT
  contract); procgen34 → procgen43 ("profile signatures + dead-v2 sweep":
  four districts side-by-side, per-profile signatures asserted in cache).
  Fewer, sharper gates; disc-era mechanics gone.
- **Board provenance (honest stamp)**: this phase's validation ran tsc,
  316/316 unit, build, and ONLY the four new/modified gates (phase3 14/14,
  phase4 12/12, procgen42 9/9, procgen43 7/7) per Jonah's scope cut.
  Unchanged gates (phase0–2/5, styleLoad, procgen40/41, test:app) inherit
  their prior green from this session's earlier runs; the next FULL board is
  required at plan-021 21-C (MapController extraction) and re-proves plan 020
  wholesale there.
- **Renderer-degradation data point** (for plan 021 §2.2): three gates ran
  clean in ONE Obsidian process; the 4th stalled with zero output; fresh
  process → 7/7. Degradation onset ≈ 4th gate-scale workload.
- **Process lesson (memory + here)**: subagent transcript mtime is NOT a
  liveness signal — a 40-min gate bash writes nothing until it returns; and a
  main-session interrupt can cancel background agents (killed the first v4.3
  agent; its on-disk work was inherited by the replacement, nothing lost).
- shots/ goldens for not-re-run gates were restored to committed versions
  (rerun churn is not signal); phase1's connections-stripping remains open as
  plan 021 §2.4b.

## 2026-07-12 — Plan 021 phase A (fast testing) — judgment calls
- **Green-board ref storage**: committed `.lastgreenboard` file (currently
  b8e6e04), overridable via `--ref=<sha>` on changed-gates. Alternatives: git
  tag, CLI-only. Chosen for durability + greppability; reversible (delete
  file → hardcoded fallback).
- **"Slow test" boundary**: exactly the two fuzz describes (200-region
  ~50 s, 30-polygon ~19 s) — nothing else exceeded ~1.2 s. Split via
  `*.fuzz.test.ts` naming + separate vitest config. Reversible by moving
  the describes back.
- **changed-gates excludes `**/*.test.ts` from gate scoping** (unit tests are
  the fast tier's domain; gates never exercise them) — deliberate deviation
  from err-toward-over-inclusion; safe because unit-test edits can't change
  gate-observed runtime. `.fixtures.ts` NOT excluded (still matches
  `src/gen/**`) — accepted over-inclusion.
- **Coverage globs err toward over-inclusion**: `src/main.ts` mapped into
  phase3/phase4/procgen40–43 (it registers generation/procgen commands);
  under-inclusion is the only unsafe direction.
- **Determinism-break injection proof (plan 021 §4, partial for 21-D)**:
  flipped the `hashSeed` FNV salt → fast tier RED (corridor golden
  snapshots); reverted byte-clean. Full acceptance re-proof is 21-D.

## 2026-07-12 — Plan 021 phase B (board runner + renderer investigation)
- **Board report path = `shots/board-report.md`** (stable single file agents
  paste into PROGRESS.md). Alternative: review/board-<date>.md (history, but
  clutters Tier-B queue). Reversible: DEFAULT_REPORT in board.ts.
- **`test:app` excluded from board** (single-gate wrapper subsumed by
  coverage.json gates; including it double-runs). `--changed` prologue drops
  fuzz tier (scoped run ≠ generator checkpoint) but keeps build. Reversible:
  prologue arrays in board.ts.
- **Renderer degradation: EVIDENCE DOCUMENTED, fresh-process-per-gate NOT
  retired.** 50-cycle soak refutes GL/Map-instance leak (canvas count flat,
  styleLoaded true throughout); catastrophic degradation not reproducible on
  demand. Best hypothesis: cumulative GPU/driver memory pressure across heavy
  generation gates (+ possible macOS compositor suspension), not reload
  count. Probe-driven restarts shipped as mitigation; onunload
  detachLeavesOfType hardening deferred as unprovable. Revisit on a
  deterministic repro.

## 2026-07-13 — Plan 021 phase C (MapController extraction)
- **21-C closed with ZERO fix-edits**: the interrupted session's 13/15 board
  (procgen41/43 "gate exited 1") did not reproduce — both gates pass
  individually AND in a full 15/15 board on the unmodified extracted tree.
  Failures attributed to environment flakiness in that session's long-lived
  Obsidian process (wall-clock signatures: procgen41 110.7s fail vs ~80–92s
  typical = late-timeout shape; procgen43 11.7s fail vs 16.2s pass = died
  early). Precedent adopted: before root-causing a "gate exited 1" from a
  long-lived process, re-run the gate individually on a fresh build first.
- **Known probe gap (logged, not fixed)**: a gate can fail on session
  degradation while pre/post health probes read "healthy" — the probe does
  not discriminate every degradation mode. Relevant to plan 021 §2.2's open
  investigation; revisit on a deterministic repro.
- **Teardown parity audit** (extraction safety evidence): MapController owns
  no disposable resources (no listeners/timers/workers/DOM; generation worker
  stays plugin-owned, borrowed via `host.gen.getWorker()`); MapView `onClose`
  still disposes map/timer/keydown.

## 2026-07-13 — Plan 021 phase D (acceptance gate)
- **§4 ≥70% headless-migration target NOT cleanly met — recorded as F1, not a
  phase failure**: 125 live-gate assertions mapped → 31 headless-now, 12
  headless-candidate (43 = 34% all-in; 51% of domain assertions). ~33% of all
  live-gate checks are irreducible live scaffolding (plugin load/open/reload,
  dev:errors, screenshots × 11 gates); the remainder is dominated by
  plan-designated-live concerns (paint, qRF, style-load, exports, frame
  timing, bundle sweeps). Decision: NO retro-migration of existing gates —
  the 21-C harness captured the cost core (procgen41, slowest gate at 92 s,
  is 59% eligible) and plans 022+ write tests born-headless. Flagged for
  Jonah in HEARTBEAT §Questions. Full map:
  review/021D-assertion-migration.md.
- **Fast-tier determinism tripwire is narrow**: only the corridor golden
  snapshots (corridor.test.ts) catch a uniform hashSeed salt flip — sigil's
  seed path doesn't route through hashSeed, and ~40 self-relative determinism
  tests survive any uniform flip by construction. Acceptable because
  gates:changed independently escalates ANY rng.ts edit to full board
  (defense in depth); worth a golden snapshot per new generator in 022+.
- **Injection-proof correction to 21-C notes**: procgen41's footprint/parcel
  minzoom check is headless-now (covered by fabricLayers.test.ts), not
  genuinely-live as previously noted.

## 2026-07-13 — Plan 022 phase A (preset pattern + city retrofit)
- **City profile dropdown REPLACED by the Template dropdown** (not rendered
  alongside): city presets are 1:1 with profiles, so both controls would be
  the same value twice; `profile` stays valid in schema/params (the template
  picker sets it). Custom-detection implemented generically + unit-tested;
  first param-divergent algorithm (river, 22-B) exercises "Custom (from …)"
  live. Reversible: re-add the profile control in MapView/modal.
- **City never persists `presetId`**: city params always match a preset, so
  display is derived at render via `matchingPresetId`; keeps every new city
  procgen block byte-identical in shape to Jonah's existing Vespergate
  blocks. `presetId` (display-only, optional) is reserved for algorithms
  whose params can diverge into Custom.
- **`matchingPresetId` deep-equals only preset-defined keys** so orthogonal
  params (e.g. persisted `center`) don't break template matching.
- **Board report for changed-scope runs → /tmp**, keeping tracked
  `shots/board-report.md` reserved for full-board milestones. Accepted; the
  ⛳ 22-F full board will refresh the tracked report.

## 2026-07-13 — Plan 022 phase B (spine support + river)
- **Spine (line-kind) regions generate on the MAIN thread, bypassing the
  generation worker** (plan 022 §2 deviation): the worker protocol
  reconstructs a region from `region.ring` via `makeRegion` and would lose
  `region.spine`/`corridorMaxOffset`; rivers are geometry-light (a few
  hundred quads vs a city's tens of thousands of segments), so the direct
  path is correct and cheap. Alternative — extending the worker protocol to
  carry spines — deferred until a heavy line-kind algorithm needs it (wall
  elaboration, 22-E, is the likely trigger). Reversible; polygon regions
  keep the worker path unchanged.
- **Corridor region reuses ProcgenRegion wholesale**: `ring` is the spine
  bbox grown by `corridorMaxOffset` (a plain CCW rectangle) used ONLY for
  the tile-overlap range; containment is spine-aware via
  `distanceToBoundary` = `corridorMaxOffset − distanceToSpine` (same
  positive-inside convention every caller relies on). Cache keys stay
  `region:<featureId>:…` — the id is the contract, not the geometry type.
- **`braidBias` param carries delta's braids-toward-the-mouth behavior** —
  params are the whole truth (determinism §1); no preset-id branch anywhere
  in the generator. All five river params default to the simplest prior
  behavior (straight uniform channel), honoring the additive-params rule.
- **Channel emitted as per-sample quads sharing bank vertices, not one
  ribbon polygon**: a long meandering ribbon self-intersects and clips
  badly; quads clip robustly per tile and each id hashes on its centerline
  endpoints (position, never emission order; integer for
  `clipNetworkToTile`'s `Number(id)` sort).
- **Tributaries: crossing river spines are legal** (plan 022 §3.1) —
  channels union visually where they overlap; junction hydrology (width
  growth after a confluence, smooth bank merge) is a logged v1 limitation.
  Line-kind edits are therefore NEVER rejected on overlap (unlike
  polygons); `validateForProcgen` is the kind-aware host entry.
- **Spine ingest valves**: `SPINE_MIN_LENGTH_M` 20 m (below useful
  elaboration) / `SPINE_MAX_LENGTH_M` 40 km (mirrors the REGION_MAX
  perf/area valve — corridor tile range stays bounded).
- **Per-generator golden snapshot added** (river.test.ts, sha256 + type
  counts) per the 21-D tripwire note: self-relative determinism tests
  survive a uniform algorithm change; the golden does not. Every 022+
  generator gets one.
- **Harness hardening (CROSS-CUTTING, not river code): phase5's "open
  Ashfall, style loads" assertion now POLLS `isStyleLoaded()`** instead of a
  single-shot read. The 22-B full board caught this pre-existing flaky (the
  gate fast-fails in ~4 s: `openAshfall` polls for readiness, then a
  `css-change` style rebuild lands in the sub-second gap before the recheck
  and reads false — while every downstream export/replay/screenshot check
  passes, proving Ashfall is functional). Not a phase-B regression: the
  `styleLoad` gate loads the identical ashfall obsidian-native style and
  passed 5/5 in both full boards; it waits properly, phase5 didn't. Fix
  mirrors phase3's `waitForStyleLoaded` poll. Touches a non-phase-B gate
  (affects every future phase's board), so flagged for the orchestrator.
- **Banks = the channel polygon's edge, NOT a separate emitted feature**
  (plan 022 §3.1 "banks as the channel SDF's zero set" describes the
  channel boundary, not a distinct generatorId): the generator emits only
  `river-channel` + `river-island`. On the v4.5 review screenshots the
  channel water reads with a legible bank against the dark ground purely by
  fill contrast, so NO separate bank outline layer was added — themes own
  all paint, and if a future theme needs a crisper bank it is a paint-only
  `fill-outline`/line layer keyed on `river-channel`, never a generator
  change. Considered and deliberately omitted, not missed.

## 2026-07-13 — Jonah live intervention: board cadence (BINDING protocol change)
- **Ruling (Jonah, in-session):** the full board runs **ONCE per plan**, at its
  final ⛳ phase — never per phase, never per commit. Repeated ~6-min boards
  (plus flake-chasing re-runs) turned hours of dev into >24 h.
- **Why it was happening:** `board --changed` auto-escalates to FULL whenever a
  determinism-critical path changes (src/gen/region.ts etc.) — during a
  generator arc that is almost every phase; and the 021-B renderer-degradation
  flake produced disjoint one-gate failures across board runs, each "clean
  sweep" attempt costing another ~6 min.
- **How applied:** per-phase commit bar is now T1 = fast suite + tsc + build +
  the phase's OWN live gate standalone (+ fuzz iff generator behavior
  changed); unchanged gates inherit the previous board's green. Board-flake
  rule codified: a gate that fails in a board but passes standalone
  immediately after counts GREEN (log both results); never re-run the whole
  board to chase a sweep. Updated: CLAUDE.md, docs/05 §Test tiers, docs/06 §2,
  plans 022–025 protocol paragraphs, HEARTBEAT §Execution rules.
- **22-B gate evidence under this ruling:** fast 374/374 (24.6 s) · fuzz 4/4
  (88.5 s — the prior session's 4.5 s board "fuzz FAIL" was its kill, not a
  red) · tsc + build green · procgen44 PASS in BOTH full boards run this
  session (34.2 s / 35.0 s) · the two board failures were disjoint env flakes
  (board 1: phase0, 5.4 s post-relaunch, then 10/10 standalone; board 2:
  procgen41, then 16/16 standalone) · dev-vault byte-clean (a third board was
  killed mid-run by the intervention; its two `__p41_test__` fixtures were
  restored via git, .mapcache cleared — harmless by design).

## 2026-07-13 — 22-B follow-ups (Jonah live: rivers)
- **Sharp-bend fix is structural, two parts.** Root cause of the notches in
  Jonah's screenshot: v1 emitted channel quads PER SEGMENT — a literal gap
  between each spine vertex and the next segment's first sample, plus
  mismatched bank normals across the join. Now ONE global centerline is
  sampled (per-segment meander keying unchanged), normals are central-
  difference across the whole line, and quads bridge joins sharing bank
  vertices. On top, a **corner fillet**: near each interior vertex the
  centerline blends (cos² weight) toward a quadratic Bezier (entry, vertex,
  exit). Fillet radius scales with `windiness` — a canal (windiness 0) keeps
  engineered crisp miters, natural rivers round their bends — and is capped
  at FILLET_MAX_M=60 and 0.35× each adjacent segment. Corridor stays a pure
  monotonic f(params): `riverMaxOffset` gains `windiness·FILLET_MAX_M/2`
  (the Bezier's deviation bound).
- **Identity blast radius widened, documented, tested:** a fillet reads BOTH
  adjacent segments, so a vertex edit now also re-shapes ≤FILLET_MAX_M of arc
  into the neighbors' tails. Locality test cutoff moved (x<850 → x<780) with
  the rationale in-line; edit-vs-reroll gate measures 71.7% vs 34.3% overlap
  — the contract holds. **Golden snapshot deliberately updated** (uniform
  algorithm change; the tripwire worked as designed).
- **Double-paint fix: opacity, not filter.** `fabric-river` line-opacity is
  now `["case",["has","procgen"],0,0.95]` — a procgen river's raw spine line
  is invisible (its channel is the paint) but stays RENDERED, so
  queryRenderedFeatures still hit-tests it (sketch = selectable handle,
  locked decision). Plus a corridor-exact selection fallback
  (`spineRegionIdAtDisplayPoint`, line-kinds only): clicking the meandered
  channel selects the river even where it swings past the 6px line box.
  Clicking generated CITY fabric still does not select its district —
  unchanged, deliberate.
- **Panel de-citified:** the selected-region "Remove city" button is now
  "Remove" for every kind; the city-only Center hint (drag-◆) no longer
  renders for spine regions.
- **Live-check hygiene note:** an errored check script left a headless view
  with `sketchMode=true` but no sketch bar, which silently no-ops
  buildSelectionPanel AND made deleteFabricForTest return false (a stray
  fixture survived until git-restore). Interactive flows can't reach that
  state (toggleSketchMode keeps flag+bar together); scripted flows should
  reset leaves first (procgen44 already does).

## 2026-07-13 — Plan 022 phase C (FOREST, done inline on Opus 4.8)
- **Done inline, not by subagent** (Fable 5 credits exhausted mid-run killed the
  22-C subagent; user switched the session to Opus 4.8). Advisor concurred:
  respawning a cold subagent just re-burns the credits that already died — the
  orchestrator had full context loaded.
- **Canopy = global-lattice CELL fill, NOT marching squares** (deviation from
  plan 022 §3.2's literal "marching squares", logged per HEARTBEAT rule).
  Rationale: (1) the marching-squares module is what plan 023 §4.1 actually
  builds — building bespoke iso-contouring here on spec is exactly the
  speculative complexity the 2026-07-13 velocity ruling targets; (2) advisor
  2026-07-13 — every candidate passes the same UNIT gates (determinism, seam,
  containment); only the screenshot separates "forest" from "blocky", so build
  the cheapest contained canopy, RENDER, escalate only if it looks wrong. It
  looked like a forest (review/v4.6-forest-broadleaf.png), so it shipped.
  **The canopy upgrades to real marching squares in plan 023.**
- **Containment without clipping** (advisor): a cell is emitted only when all 4
  corners are ≥ (jitter + 1 mm) inside the ring, so every position-hashed
  jittered vertex stays strictly inside — no per-tile clip needed for
  containment, and `density`/`clearings`/`edgeRaggedness` fall out for free.
- **Watertight edges:** corner jitter hashes on the shared lattice VERTEX (not
  the cell), so the four cells meeting at a vertex displace it identically — no
  gaps/overlaps. Feature ids hash the cell's lattice indices (position, integer
  for clipNetworkToTile's Number(id) sort).
- **Trees carry the "forest" read** (advisor): a position-hashed jitter grid of
  `forest-tree` points, weighted toward the ragged edge and scaled by density —
  they sell the woodland even where the canopy thins (visible on the dead-wood
  screenshot, which is mostly stipple by design at density 0.35).
- **`variety` is a param, carried onto features as `forestType`** (broadleaf/
  conifer/mixed/swamp/dead-wood): params stay the whole truth (determinism), and
  themes get a discriminator to tint per variety later without a preset-id
  branch. Paint keys on `generatorId` today; `forestType` is the future hook.
- **Clearing threshold remapped into the noise's active band** (0.72 −
  clearings·0.45): fractal noise concentrates near 0.5, so the naive
  `1 − clearings·0.7` almost never cut a glade (caught by the unit test).
- **§5.2 open question (inert un-generated forest paint) — DECIDED, flag to
  Jonah:** a faint canopy-green fill (fabricForest at 0.28 opacity) for the
  un-generated sketched forest, dropping to opacity 0 once a procgen block is
  attached (same mechanism as the river spine line — fill stays rendered so
  queryRenderedFeatures still hit-tests it for selection). Reasonable default;
  Jonah may want a different inert treatment.
- **New `fabricForest` token** (deeper than fabricPark) added to ThemeTokens +
  all 4 handcrafted themes + obsidian-native FABRIC_ON_LIGHT/DARK. Forest reads
  as a distinct kind from park (F2), verified by the all-themes coverage test.
- **`createRegionForTest` made kind-aware** (optional `kind`, default district):
  a forest overlapping a CITY is legal because `overlappingRegion` keys on the
  ALGORITHM id — only same-algorithm regions clash (headless-tested).
- **Real-GUI confirmation:** Jonah sketched + generated a forest through the
  actual sketch UI mid-review (the manual stray he then deleted) — the new kind
  works end-to-end interactively, not just via the headless twin.

## 2026-07-13 — Plan 022 phase D (PARK, Opus 4.8 phase subagent)
- **Resumed a killed session's dirty tree per wake protocol** — park.ts /
  waterEmit.ts / tests / registry / theme edits were code-complete but red on
  two tests; the phase subagent finished it rather than restarting clean
  (remaining work was clear from diff + plan §3.3).
- **Degradation-ladder thresholds: court ≥200 m, island ≥130 m
  maxInteriorDistance (pond ≥25 m).** Plan §3.3 mandates the court→island→pond
  ladder but not values; the killed session's thresholds (130/80) didn't
  actually rung the ladder at the test's region sizes. Values picked mid-range
  of the constraints the degradation test encodes; only japanese-garden output
  in small regions moves; the maxD-500 golden snapshot passed UNCHANGED.
  **Flag for Jonah**: rung sizes are tunable if gardens drop their court/island
  too eagerly (or not eagerly enough) in real sketches.
- **`waterEmit.ts` extraction (per plan §3.3 "extract to a shared module"):**
  island/bridge blob emitters now live in `src/gen/waterEmit.ts`; river.ts and
  park.ts both import it — park never imports the river generator. Pond
  pre-023 fallback = seeded harmonic-radius blob (same closed-form trick as
  the river meander); upgrades to smooth-min SDFs with plan 023 fields.
- **procgen46 gate composition counts are per-tile-clipped** (pond:2 bridge:3
  court:2 across tiles) — features spanning tile boundaries appear in each
  tile's records; NOT a duplication bug. Single-artifact truth is the unit
  snapshot (pond:1 island:1 bridge:1 court:1 rock:10 specimen:6). The gate
  asserts ≥1 per element.
- **Stale registry test updated, not preserved:** `algorithmForKind("park")`
  now resolves (that IS the phase); `road` still has no algorithm.

## 2026-07-13 — Plan 022 phase E (WALL, Opus 4.8 phase subagent)
- **Towers get a seeded per-segment PHASE** (`hashSeed(seed,"wall-tower-phase",
  a,b)`), not pure geometry: pure geometry would make re-roll a no-op (the
  spine doesn't change) and the edit-locality-vs-re-roll gate unsatisfiable.
  Same identity trick as the river meander — edits re-phase only adjacent
  segments; re-roll re-phases all.
- **Gates key on SKETCHED roads, not generated streets.** §3.4's "align to the
  stage-3 streets" is the plan-024 cascade target; reading stage-3 output in a
  stage-4 generator pre-024 is the exact layering violation the adversarial
  review killed. Implemented against raw `roadLines` constraints; street
  alignment lands with 024's DAG. Documented in wall.ts header.
- **Moat + bastions project to the deterministic LEFT normal** of the sketched
  line: an open polyline has no inside/outside; picking a fixed normal keeps
  the corridor pure f(params) and puts moat + bastions on one coherent
  "outboard" side. GM controls the side by draw direction (flag if this needs
  an explicit `side` param instead).
- **Double-wall suppression: 28 m corridor, segment-level, city's own wall
  BAND only** (ring road + city gates survive; the GM's wall + its towers/
  gates take over the fortification read). Signal is the RAW sketch — legal
  input for every stage; strict no-op when no wall sketch exists, so every
  pre-existing city is byte-identical (unit-asserted).
- **`fabric-wall` sketch line hides once a procgen block exists** (opacity
  keyed on `procgen`, selection via the existing corridor fallback) — same
  double-paint kill as river spine/forest fill.
- **Parallel-session artifact:** plans/026 + 027 (forest/park visual
  overhauls) appeared untracked mid-phase from a separate research session;
  left uncommitted + flagged in HEARTBEAT §Questions rather than folded into
  this run (checklist scope is Jonah's call).

## 2026-07-13 — Plans 026–028 slotting + board collapse (Jonah, via research session)
- **Plans 026–028 (forest/park/river visual overhauls) ratified and slotted**
  into HEARTBEAT as two waves: wave 1 (VO-W0 paint-module split + 26-A/27-A/
  28-A ∥P1 + 27-B/28-B ∥P2) after 22-F; wave 2 (26-B → 26-C → 27-C/28-C ∥P3)
  after 023. Rationale: A/B phases have no 023 dependency (visual wins pulled
  forward); 26-B/27-C need 23-C marching squares; 26-C's glyph module feeds
  27-C/28-C; 28-B precedes 23-E by checklist order (river-slope coupling
  builds on the new meander math); everything lands before 024 so the cascade
  integrates final geometry once.
- **∥ protocol:** ∥ groups are CODE-parallel only (disjoint generators; VO-W0
  removes the generatedLayers.ts collision; 27-A owns tokens.ts in P1).
  Integration, live gates, boards, and commits always serialize; the
  unattended driver runs ∥ boxes as consecutive solo phases (one-kill-one-
  phase-rework stands); attended sessions may fan out worktree subagents
  within one invocation.
- **Board collapse (Jonah):** ONE full board covers all three overhaul plans,
  run at 28-C — not one board per plan. Every other wave box commits on T1.
  The once-per-plan cadence and board-flake rule apply to the 026–028 block
  as a whole.

## 2026-07-13/14 — Plan 022 phase F (FARMLAND, Opus 4.8 phase subagent; plan-022 board)
- **Strip-axis pinned to constant world-X** (audit fix on the interrupted
  agent's generator): keying strip orientation on the region bbox's longer
  axis meant a vertex edit that flips the dominant axis rotated EVERY strip —
  edit ≈ re-roll, violating edit-locality. A constant axis keeps fields
  world-stable under any boundary edit. "Strips radiate off lanes" still
  holds (lanes follow the same lattice).
- **Farm stack paints BELOW city district/footprints/streets** (farmland is
  cascade stage 2, city stage 3 — city-over-farmland reads city-on-top).
  Deliberate divergence from forest (canopy paints above footprints).
  **Flag for Jonah** with the v4.9 screenshots.
- **Inert paint = forest §5.2 mechanism exactly**: fabricFarmland 0.28 fill,
  opacity 0 once `procgen` present; fill stays for hit-testing.
- **Self-contained rectangle splitter** rather than importing
  parcels.subdivideBlocks (CityProfile-coupled) — park precedent endorsed.
- **paddy-terraces omitted entirely** (not stubbed): additive-params rule
  makes it a legal later addition at 23-E, where elevation exists.
- **Board conduct:** first board externally killed mid-phase4 (main-session
  interrupt cancels bg tasks — known failure mode); prologue + phase0–3 were
  already green so the board was RESUMED (`--no-prologue --gates=<remaining>`)
  rather than re-run — one logical board. procgen45 failed in-board on a CLI
  eval flake (`failed: => started` — eval succeeded, wrapper threw; same
  signature as the phase4 in-board flake that passed on the resumed check)
  and passed standalone 12/12 immediately after → counts GREEN per the
  2026-07-13 flake rule; board not re-run. Combined: 16/16 gates, 0 probe
  relaunches.

## 2026-07-14 — VO-W0 (generatedLayers per-kind split, Opus 4.8 phase subagent)
- **world.ts + city.ts each export TWO fragments** (worldRegion+worldRoute,
  cityBlock+cityStreet) instead of one function per kind: the original emit
  order interleaves (region first, route near the end; city block mid-stack,
  street last), and byte-identity forbids reordering. The composer spreads 9
  fragments in the original sequence.
- **Coverage tests deliberately NOT split** alongside the modules: their
  assertions are cross-module composition contracts (island>channel,
  farm<district, whole-array assertLayerOrder) — exactly what must survive
  the split; splitting them would drop coverage, not move it.
- **Byte gate kept as a repeatable script** (scripts/gates/vo-w0-style-bytes.ts,
  --out <dir>): builds all 6 theme styles (4 handcrafted + obsidian-native
  light/dark) through the plugin's own code path; board can adopt it later.

## 2026-07-14 — Visual-overhaul wave 1, ∥ group P1 (26-A/27-A/28-A, concurrent Opus 4.8 worktree agents)
- **Fan-out conduct:** three worktree agents ran concurrently (attended-session
  clause of the ∥ protocol); integration was strictly serial in checklist
  order — apply patch → fast+tsc+build → phase's own live gate standalone →
  screenshots eyeballed → commit+push. Two agents were killed mid-run by
  transient API stalls; both resumed from transcript with zero rework (patches
  were already durable on disk in one case).
- **Two real integration bugs caught at the seam (not by the agents):**
  (1) vo27-park counted raw cache records — per-tile clipping splits one
  logical lawn into N tile records, so "ONE merged lawn" must count DISTINCT
  feature ids (same semantics documented for procgen46, phase D); (2) the new
  `park-canopy` gid was missing from PARK_TILE_GENERATOR_IDS, so canopy
  features were generated then silently dropped from cache — the exact
  uncached-gid trap 28-A predicted for river-bank and fixed in its own patch.
  Checklist candidate for future new-feature-type work: "new gid ⇒ registry
  tileGeneratorIds entry" belongs next to "paint in ALL themes".
- **Degraded-process eval flakes, diagnosed:** vo27-park failed twice at
  RANDOM checks whose evals returned VALID results (`failed: => started`,
  `failed: => {"count":187,"outside":0}`) after ~6 gate runs in one Obsidian
  process; a fresh process (relaunch-obsidian.sh) went 14/14 immediately.
  Matches the docs/05 long-session renderer degradation; standalone gates
  after several runs should relaunch first rather than chase evals.
- **26-A rank fade is a constant step, not zoom-ramped** — the zoom×rank
  composition is research-flagged as screenshot-dependent; `rank` is emitted,
  so the zoom-interpolate is a paint-only drop-in later if Jonah wants loners
  to fade at overview zooms. Tints derive from each theme's fabricForest by
  relative channel moves (no new tokens; 27-A owned tokens.ts).
- **27-A canopy is city-park-only and interior-clumps-only** (formal/wild/
  japanese get their treatments in 27-B; perimeter belt deferred to 27-B;
  polygon-union canopy to 27-C w/ marching squares). Overlapping canopy blobs
  double-darken at intersections until 27-C — known-rough, opacity 0.85.
  **Flag for Jonah**: two-green renders in 1 of 4 park varieties this phase.
- **28-A judgment calls:** channel opacity 0.85→1.0 (deliberately-overlapping
  ribbons/welds must not double-darken; casing carries the edge read);
  lazy-lowland rarely braids now (26 m channel can't open a 0.4-width island —
  suggest width-relative lens amplitude in 28-B if Jonah wants wide rivers
  braiding); optional thalweg line-gradient deferred (needs lineMetrics
  plumbing); a real fabricRiverBank token is a want (bank color is a local
  darken() for now).
- **Gate naming:** 28-A's live gate shipped as `procgen49.ts` and 26-A's as
  `procgen49-forest.ts` (the agents numbered independently). Both registered
  in coverage.json; names left as-is — renumber cosmetically if it grates.

## 2026-07-14 — Visual-overhaul wave 1, ∥ group P2 (27-B/28-B) — WAVE 1 COMPLETE
- **Third per-tile-clip gate-bug instance:** vo27-park's closed-loop check
  read first≈last off single cache records; a closed loop spanning tiles is
  N open per-tile polylines. Replaced with an endpoint-degree circuit test
  (mm-quantized; closed circuit ⇔ zero odd-degree endpoints — tile-edge cut
  points appear in both neighbours, degree 2). PATTERN now firmly
  established: any gate assertion about whole-artifact topology must be
  clip-aware (distinct ids for counts, endpoint degree for closure, unit
  snapshots for exact shape). Candidate for docs/06's gate checklist.
- **27-B judgment calls (flagged by the agent, endorsed):** formal-garden
  basin reuses `park-pond` (plan's `park-water` name doesn't exist in the
  shipped schema) and is intrinsic/size-gated — the "formal has no pond"
  test was updated deliberately; bare-park entrance edit-locality is
  per-edge-local for INCLUSION but diagonal PAIRING is index-based over the
  entrance list (road-authored entrances fully local + tested; the sacred
  tree-scatter locality guarantee unchanged). Point dressing = tinted circle
  markers; SDF symbols are 27-C.
- **28-B judgment calls (flagged, endorsed):** amplitude saturates once the
  R_c≥2W clamp binds (≈windiness 0.5 at default widths) — the slider's top
  half now adds skew, not amplitude; **flag for Jonah** (empirically real,
  but the knob feels subtler; 28-B suggests width-relative lens amplitude if
  wide rivers should braid/wind more). λ + clamp read base `params.width`,
  not grown local width — strict per-segment identity, and the clean 23-E
  seam is meanderSegment's params block. Kinoshita Js=1/32 canonical,
  θ₀max=1.9; the plan's "verify vs Abad WRR 2023" research flag stands.
- **Remote drift mid-phase:** Jonah deleted GOAL.md on GitHub (3968cfb);
  27-B rebased over it cleanly. The overnight-run assumption "only this
  session pushes" is false when Jonah is live — push failures get a fetch +
  inspect before any rebase.

## 2026-07-14 — Plan 023 phase A (fields core, Opus 4.8 phase subagent)
- **Bit-exactness by construction, not by testing alone:** the retrofit moved
  the distance/containment primitives VERBATIM (character-identical
  arithmetic, same evaluation order) from region.ts/fabricConstraints.ts into
  src/gen/fields/sdf.ts and imported them back one-way — region.ts's diff
  reads as a pure move. The corridor-vs-polygon dispatch and the two distinct
  even-odd closure conventions were deliberately NOT unified: unifying
  reorders floats. Proof stack: every pre-existing .snap byte-unchanged +
  fuzz double-run byte-identity + a NEW city SHA-256 digest golden captured
  on clean HEAD before any source edit (closes the §2 gap that the city had
  no committed golden) + live regenerate byte-compare on the real migrated
  Vespergate district (fields23a 7/7).
- **§2's elevation-noise entries (valueNoise2DWithDeriv, fbmEroded) deferred
  to 23-B** — zero consumer in 23-A; shipping them here would be
  untested-in-anger surface. RATIFIED by the orchestrator; they land with
  their first consumer (the elevation model). Combinators/transforms DID ship
  ahead of consumers (unit-tested; 23-B/C masked-noise needs them) — the
  difference is they're pure math with exhaustive unit tests, not a
  tuned-by-eye noise surface.
- **City golden = SHA-256 digests** of the serialized network, not full JSON
  (~10 MB) — identical bit-exact detection, no repo bloat.
