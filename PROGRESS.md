# Progress

*Updated after every gate run. A fresh session should be able to resume from CLAUDE.md + this file alone.*

## Status: Phase 2 complete (Tier A green) — starting Phase 3

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

## Phase 3 — procedural generation (next)
- [ ] 3a Naming + sigils: seeded per-genre name generators (extend Phase 1's 3-culture stub into full region-based naming cultures), seeded SVG sigil composition
- [ ] 3b City gen: tensor-field streets → Voronoi districts → block subdivision → footprints; GM-placed field constraints
- [ ] 3c World gen: Poisson → Voronoi → heightmap → biomes → settlements → routes
- [ ] 3d Canonization + stitching: canonize = create the note, remove from cache; generators take canon as constraints; regenerate-region never touches notes; add-location snaps into fabric
- [ ] Halo overlap + hierarchical seeding; 2×2 adjacent-tile seam snapshot tests mandatory; generation in a Web Worker
- [ ] `scripts/gates/phase3.ts`

## Next 3 actions
1. `src/gen/rng.ts`/naming culture system already exists (Phase 1) — extend to region-based inheritance (3a) and add sigil generation before touching city/world gen, since it's the smallest/lowest-risk piece
2. Tensor-field city street generator (3b) — pure/headless per CLAUDE.md, unit-tested with seeded snapshot fixtures, no DOM/map/Obsidian imports; this is the phase's load-bearing novel piece
3. Determinism + 2×2 seam snapshot tests from the start, not bolted on after — docs/06 marks this mandatory "from phase 3 on"

## Open blockers
None.

## Awaiting Jonah's eyes
- `shots/gate-phase0.png`, `shots/gate-phase1.png`, `shots/gate-phase2-london.png` — screenshots of the pipeline end to end, including the real London OSM basemap with a canon pin rendered indistinguishably alongside it.
- Right-click context menu: implemented correctly per standard API but unverified by CLI automation (see DECISIONS.md) — please try a real right-click on a location pin/empty map when you get a chance.
- Undo is intentionally basic (single-step, no redo) — flag if you want that built out further before Phase 5's replay work depends on it.
- The four handcrafted themes are visually verified (screenshots taken during the session) but only `modern-clean` (via London) has a committed reference screenshot — happy to add parchment/ink-soot/neon-sprawl reference shots to `shots/` if useful for review, just say the word.
- Alegreya/Oswald bold-via-size-not-weight approximation (see DECISIONS.md) — low priority, flag if it reads wrong in practice.
