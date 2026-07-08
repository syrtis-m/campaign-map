# Progress

*Updated after every gate run. A fresh session should be able to resume from CLAUDE.md + this file alone.*

## Status: Phase 0 complete (Tier A green) — starting Phase 1

## Environment (done)
- [x] `scripts/preflight.sh` written and green (Obsidian 1.12.7 running, `dev-vault` registered + CLI-reachable, restricted mode off, Node v22.14.0 installed locally, git repo initialized, GitHub remote `syrtis-m/campaign-map` created)
- [x] `.claude/skills/maplibre-agent-skills` and `.claude/skills/obsidian-skills` vendored (not submodules — `.git` stripped, tracked as plain files)

## Phase 0 — plugin skeleton + two spikes (DONE, gate green: `npx tsx scripts/gates/phase0.ts` → 10/10)
- [x] TS + esbuild scaffold (manifest.json, package.json, esbuild.config.mjs, tsconfig.json); `npm run build` now runs `tsc --noEmit` first (esbuild alone does not type-check)
- [x] dev-vault hot-reload wiring — `npm run build`/`dev` write straight into `dev-vault/.obsidian/plugins/campaign-map/`, including maplibre-gl.css bundled into styles.css
- [x] `ItemView` map tab (`src/view/MapView.ts`) + ribbon icon + `campaign-map:open-map` command
- [x] Spike A: MapLibre renders in the ItemView, survives tab drag/split (independent WebGL contexts per pane, confirmed via screenshot) and a full `obsidian reload`
- [x] Spike B: fictional CRS (`src/map/fictionalCRS.ts`) — fake [lng,lat] bounded box via `fitBounds`, custom scale bar (Google-Maps-style "nice number" rounding) since MapLibre's built-in ScaleControl assumes real-world latitude
- [x] Campaign config note (`*.map.md` frontmatter, `src/model/campaignConfig.ts`, Zod-validated) parsed; per-campaign `open-map-<slug>` commands auto-register; generic `open-map` command opens a `FuzzySuggestModal` picker when >1 campaign exists, direct-opens when exactly 1, warns when 0
- [x] Three dev-vault test campaigns seeded: `Campaigns/Ashfall` (fictional/fantasy), `Campaigns/London` (real-city, basemap deferred to Phase 2), `Campaigns/Nightreach` (fictional/neon-sprawl)
- [x] `scripts/gates/phase0.ts` (+ `scripts/lib/cli.ts` helper) — 10 automated checks: bundle has no Node API, plugin loads clean, config parses, per-campaign command opens a view, canvas renders nonzero, scale bar has a numeric reading, generic command shows a picker at 3 campaigns, split survives, full reload survives, screenshot captured
- [x] Exit test manually verified + screenshotted (`shots/gate-phase0.png`): open vault → open a campaign map → pan/zoom empty themed world → split pane → full Obsidian reload → still works, zero console errors throughout
- [x] Unit tests: `src/model/campaignConfig.test.ts` (Zod round-trips, rejects missing crs/marker/bad theme), `src/map/fictionalCRS.test.ts` (scale-bar math) — `npm test` → 15/15 passing

## Phase 1 — yes-and core, vault-native (next)
- [ ] Notes ⇄ map reconciliation: vault watcher on `map:` frontmatter (location notes, not campaign config notes) → in-memory flatbush index → GeoJSON sources
- [ ] Google-Maps interaction grammar: click pin → place card; click empty → dropped pin + "Add location here" → quick-add modal; right-click → native context menu; hover tooltips; drag pin → frontmatter geometry update
- [ ] `obsidian-native` default theme generated from Obsidian CSS variables, rebuilt on `css-change`
- [ ] Cartographic defaults: importance ranks + auto zoom-ranges + collision priority per docs/06 §3 type-taxonomy table
- [ ] Wikilink completion for locations; map search modal (quick-switcher-style) with flyTo
- [ ] Mutation log (`.mapcache/log.jsonl`) + undo/redo for map-originated edits
- [ ] `scripts/gates/phase1.ts`

## Next 3 actions
1. Zod schema + parser for location-note frontmatter (`geometry`, `type`, `map`, `aliases`) in `src/model/`
2. Vault watcher + flatbush index wiring in main.ts (create/modify/rename/delete → index update within 500ms, per Tier A "Reconcile" assertion)
3. GeoJSON source + circle/symbol layers added to the map style so canon locations actually render as pins

## Open blockers
None.

## Decisions of note (see DECISIONS.md for full log)
- Had to install Node locally from the official tarball (no brew/nvm on this machine) and register `dev-vault` in Obsidian's global vault list by hand (no CLI vault-creation command exists) — confirmed with Jonah before touching that global file.
- Phase 0's "blank parchment world" roadmap line was implemented as a literal placeholder style (single background layer, parchment land token `#f2e8cf` from the pinned theme table) — full theme system lands Phase 1/2, this is intentionally minimal.

## Awaiting Jonah's eyes
- `shots/gate-phase0.png`: three-pane split screenshot of the blank themed world (Spike A/B combined). Nothing else queued yet — Tier B review/ items will start landing once theming/generation work begins in Phase 1–3.
