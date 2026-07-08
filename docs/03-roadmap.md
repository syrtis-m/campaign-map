# Build Roadmap — Obsidian Plugin

*Rev 2: re-planned around the Obsidian pivot. Every phase still ends table-usable, with an exit test.*

## Phase 0 — Plugin skeleton + the two spikes
- Scaffold: TS + esbuild plugin, dev-vault hot-reload workflow, `ItemView` map tab, ribbon/command to open.
- Obsidian CLI wired in from day one (docs/05): CLI registered on both machines, `test:app` script skeleton, test API exposed at `app.plugins.plugins['campaign-map']`, screenshot loop working.
- **Spike A (WebGL/MapLibre-in-Obsidian):** MapLibre renders in the ItemView, survives tab drag/split/close, coexists with Obsidian's CSS. *This is the pivot's load-bearing assumption — do it first.*
- **Spike B (fictional CRS):** fake lng/lat bounded box; labels, bearing, fitBounds, scale bar with `scaleMetersPerUnit`.
- Campaign config note (`*.map.md` frontmatter) parsed; blank parchment world panning at 60fps.

**Exit test:** open vault → command "Open map: Ashfall" → pan/zoom empty themed world in a tab; drag tab to a split; reload Obsidian; still works.

## Phase 1 — Yes-and core, vault-native
- **Notes ⇄ map reconciliation**: vault watcher on `map:` frontmatter → in-memory flatbush index → GeoJSON sources. Create/rename/delete/move note ↔ pin updates live. Zod validation, warning badges for bad frontmatter.
- Google-Maps interaction grammar (architecture §3b): click pin → place card (note preview via Obsidian renderer, open/edit/center actions); click empty map → dropped pin + "Add location here" tooltip → quick-add modal (name + type, culture-consistent suggestions) → note created; right-click → native context menu; hover tooltips. Drag pin → frontmatter geometry updates.
- **`obsidian-native` default theme**: MapLibre style generated from the active theme's CSS variables, regenerated on `css-change` — map matches the user's Obsidian look out of the box.
- Cartographic defaults land here (quality-bar F1/F5): importance ranks per type, auto zoom-ranges, collision priority.
- Wikilink completion for locations everywhere (they're just notes); map search = quick-switcher-style modal, flyTo on select.
- Mutation log (`.mapcache/log.jsonl`) + undo/redo for map-originated edits.

**Exit test:** run a real session — invent 10 locations from the map, wikilink 3 from the session note, rename one note and watch the label update, reload Obsidian, everything intact. *This alone beats obsidian-leaflet for your workflow.*

## Phase 2 — Real cities + themes
- PMTiles in vault: Vault-adapter byte-range reads → custom MapLibre protocol; "download city extract" helper writing `basemap.pmtiles` ([protomaps docs](https://docs.protomaps.com/pmtiles/maplibre)); document sync-exclusion. Install [maplibre-agent-skills](https://github.com/maplibre/maplibre-agent-skills) in the repo first.
- Real-city campaign type: location notes pinned to real streets.
- Four handcrafted themes (`parchment`, `ink-soot`, `modern-clean`, `neon-sprawl` — architecture §4) with explicit craft scope (quality-bar F4/F6): cartographic typography, texture fills, edge treatments, map furniture, unexplored-space treatments, ≤8 color tokens each; template icon sets (game-icons.net); custom PNG markers from vault images; georeferenced artist overlays. `neon-sprawl`'s glow technique (stacked casing layers) is the style-spec stress test — build it second, after `modern-clean`.
- Theme switcher per campaign (`obsidian-native` default; handcrafted themes as genre overrides); verify handcrafted themes don't fight Obsidian dark/light CSS.

**Exit test:** laptop offline → your real city pans from vault-local PMTiles, fictional pins on real streets, ink-soot theme, inside Obsidian.

## Phase 3 — Procedural generation
*(Generators are pure/headless and host-agnostic — this phase is nearly untouched by the pivot.)*
- 3a **Naming + sigils**: seeded per-genre name generators; seeded SVG sigil composition.
- 3b **City gen**: tensor-field streets → Voronoi districts → block subdivision → footprints ([Wonka 2008](https://peterwonka.net/Publications/pdfs/2007.SG.Esch.InteractiveProceduralStreetModeling.Sketch.pdf), [phiresky survey](https://github.com/phiresky/procedural-cities/blob/master/paper.md)); GM-placed field constraints.
- 3c **World gen**: Poisson → Voronoi → heightmap → biomes → settlements → routes (Azgaar pipeline, headless).
- 3d **Canonization + stitching**: canonize = *create the note*, remove from cache; generators take canon as constraints; regenerate-region never touches notes; add-location snaps into fabric (quality-bar F2).
- Requirements: halo overlap + hierarchical seeding; 2×2 adjacent-tile seam snapshot tests mandatory (F3). Generation in a Web Worker.

**Exit test:** generate a city; canonize a street (it becomes a note); regenerate the district → street survives, surroundings adapt; cache folder deleted → map regenerates identically.

## Phase 4 — Continuous LOD
- Zoom-band dispatcher over `.mapcache/` chunks; loading shimmer; detail band (z16+) buildings/POIs.
- Perf pass: 60fps pan on the Surface Pro *inside Obsidian*; index rebuild time on vault open <1s for 500-note campaigns.

**Exit test:** scroll world→street into never-visited territory: coherent detail at every band, identical on revisit, identical on the other machine after sync (cache excluded — regenerates the same by seed).

## Phase 5 — Keepsakes & force multipliers
- **Poster export first**: 300dpi tiled offscreen render, furniture, cartouche, gazetteer margin.
- **Atlas export**: PDF from maps + location notes + artist images — the notes ARE the gazetteer now.
- Campaign replay from mutation log; per-session travel paths (session notes already date-stamp the log).
- LLM hook: agent-in-vault reads campaign markdown, emits valid location notes ("populate this district with 5 shops").
- Azgaar/Watabou import; Obsidian Bases integration (locations as a base view) if Bases API allows.

## Standing risks
| Risk | Mitigation |
|---|---|
| MapLibre misbehaves inside Obsidian | Phase 0 Spike A before anything else; adapter keeps web-app escape hatch |
| Frontmatter corruption by templates/other plugins | Zod at reconcile; visible warning badges; never silent-drop |
| Generator output looks bad | Headless + snapshot fixtures; craft budget in 3b |
| Scope creep toward VTT | Non-goals list (architecture §7) is load-bearing |
| Obsidian API churn | Pin minAppVersion; host-agnostic core |
