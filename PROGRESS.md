# Progress

*Updated after every gate run. A fresh session should be able to resume from CLAUDE.md + this file alone.*

## Status: Phase 1 complete (Tier A green) — starting Phase 2

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

## Phase 2 — real cities + themes (next)
- [ ] PMTiles in vault: Vault-adapter byte-range reads → custom MapLibre protocol; "download city extract" helper (Protomaps, default bbox = central London, matches our `London` test campaign)
- [ ] Real-city campaign type: location notes pinned to real streets (London campaign already has 2 seed locations waiting for a basemap)
- [ ] Four handcrafted themes (parchment, ink-soot, modern-clean, neon-sprawl) — typography, texture fills, edge treatments, furniture, ≤8 color tokens each (docs/06 pinned tokens); will need their own font glyph-PBF passes (Alegreya, IBM Plex Serif, Rajdhani, Saira Condensed) using the `scripts/fetch-fonts.sh`/`scripts/build-glyphs.mjs` pipeline built in Phase 1
- [ ] Theme switcher per campaign; verify handcrafted themes don't fight Obsidian dark/light CSS
- [ ] Install maplibre-agent-skills PMTiles patterns (already vendored in `.claude/skills/`)

## Next 3 actions
1. PMTiles vault protocol (custom MapLibre protocol reading via `app.vault.adapter`, byte-range) — the load-bearing spike for this phase, do it first
2. `modern-clean` theme (simplest of the four, pairs with real PMTiles basemap layers) — build before `neon-sprawl` per docs/03 ("neon-sprawl's glow technique is the style-spec stress test — build it second")
3. `scripts/gates/phase2.ts`

## Open blockers
None.

## Awaiting Jonah's eyes
- `shots/gate-phase0.png`, `shots/gate-phase1.png` — screenshots of Spike A/B and the live label/theme/zoom-range pipeline (real Inter-glyph labels, importance-scaled circles, obsidian-native dark theme).
- Right-click context menu: implemented correctly per standard API but unverified by CLI automation (see DECISIONS.md) — please try a real right-click on a location pin/empty map when you get a chance.
- Undo is intentionally basic this phase (single-step, no redo) — flag if you want that built out further before Phase 5's replay work depends on it.
