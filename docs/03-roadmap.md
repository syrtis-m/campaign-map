# Build Roadmap — Obsidian Plugin

> **HISTORICAL — the phases below shipped (Phase 0–5 complete; plans/README.md is
> the ledger, PROGRESS.md the current state).** Kept as the record of the original
> phase design and exit tests; do not update — new work is planned in
> `plans/NNN-*.md`.

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
- Google-Maps interaction grammar (architecture §3b): left-click pin → no popup (amended Jonah 2026-07-15 — place card retired from left-click; open/center/connect/visibility live on the right-click menu); click empty map → dropped pin + "Add location here" tooltip → quick-add modal (name + type, culture-consistent suggestions) → note created; right-click → native context menu; hover tooltips. Drag pin → frontmatter geometry updates.
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
- 3d **Constraints + stitching** *(superseded by plan 019 — canonization deleted)*: generators take locations AND sketched fabric as constraints; regenerate never touches notes or sketches; generation is explicit-only with a durable request manifest (quality-bar F2).
- Requirements: halo overlap + hierarchical seeding; 2×2 adjacent-tile seam snapshot tests mandatory (F3). Generation in a Web Worker.

**Exit test (rewritten by plan 019):** generate a city; sketch a river across it → streets re-adapt to stop at the shoreline on their own; close and reopen the vault → the generated area repaints; cache folder deleted → map regenerates identically; pan/zoom anywhere → zero generator runs.

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

## Current procgen phase — Plan 020: sketch-driven regions (v4.0–v4.2 SHIPPED 2026-07-12; v4.3 in flight)

## Procgen v4 arc — plans 021–028 (SHIPPED 2026-07-14)

The full 021–025 arc plus the 026–028 visual-overhaul waves landed over
2026-07-12 → 2026-07-14 (review/HEARTBEAT-arc-021-028.md has the box-by-box log; plans/README.md
rows carry per-phase commits). Summary: fast-testing infrastructure (fuzz tier,
board runner, headless harness) → the algorithm suite (rivers/forests/parks/
walls/farmland) → constraint fields + elevation (mountains, contours,
hillshade/3D) → the cross-layer regen cascade (stage DAG, fingerprints, city
consumes the generated river channel) → street-pattern presets + numeric
benchmarks (12 presets, metrics module, Preset Gallery campaign + contact
sheet in review/gallery/). Next axis: the rearchitecture waves (plan 030) +
versioned determinism (plan 029), both ratified 2026-07-14.

*Phases 0–5 above are the product build axis (all shipped). Procgen has its own
version axis; **v4** is the current work. Plan 020 (Jonah, 2026-07-12) moves city
generation from disc domains (click at z≥8 → DomainProfileModal → disc) to the
**three-layer model**: a sketched district polygon IS the request for city procgen,
and the city fills that polygon (wall traces the sketched boundary; all output
strictly inside). See `plans/020-sketch-driven-procgen-regions.md`. Commit per green
gate.*

- **v4.0 — pure core (DONE, commit 430710c).** `src/gen/region.ts` (region geometry), `src/gen/procgen/registry.ts` (sketch-kind → algorithm), fabric-schema `procgen` block, citynet generalized disc→polygon, `districtRings` ward-exclusion retired. No host changes; unit gates: determinism (byte-identical twice), 2×2 seam via clip, concave-polygon smoke (L-shaped region, all output inside, no throw), disc-equivalent sanity (32-gon ≈ old disc within tolerance), 4-profile fuzz on random polygons.
- **v4.1 — host lifecycle (DONE, commit 55db381; procgen40 gate 10/10; live Vespergate domain migrated).** RegionProcgenModal, sketch-finish trigger, region cache keys, replay-from-sketch-layer, one-way manifest.domains→district migration, clear/delete flows, worker job, new log types. Gate `scripts/gates/procgen40.ts` (live Vespergate): sketch a district headlessly → city appears; byte-diff cache after `rm`+replay; pan generates nothing; migrate a seeded pre-v4 manifest.
- **v4.2 — edit UX (DONE, commit be4f0c1; procgen41 gate 16/16). Two Jonah rulings shipped with it: building footprints/parcels render at every zoom (no LOD pop-in), and the city center/plaza is a GM-draggable persisted handle (params.center) — pinned centers measurably stabilize boundary edits (street survival 60–69% vs 45–49%).** Select tool, vertex/midpoint handles, `sketch-edit` log + undo, schema-driven params panel, edit→regen loop. Gate `procgen41.ts`: move a vertex → city adapts + determinism holds; re-roll changes the city; remove-procgen leaves an inert shape; screenshot review.
- **v4.3 — three-layer consolidation (IN FLIGHT).** layerOrder comments/tests renamed to the three-layer model, gates procgen30–34 + phase3/4 modernized to sketch-driven flows, DomainProfileModal deleted, CLAUDE.md + docs updated, DECISIONS/PROGRESS entries, full board green one-gate-per-fresh-process.

**Exit test (plan 020 §10):** sketch a district polygon → params modal → a city fills
exactly that polygon with the wall tracing the sketched boundary; drag a boundary
vertex → the city re-adapts and stays inside, determinism intact; re-roll → a
different city, same polygon; delete the shape → the city vanishes; delete
`.mapcache/` and reopen → the city repaints byte-identically; pan/zoom anywhere →
zero generator runs; a pre-v4 campaign with disc domains migrates to district
sketches on load. *(All exit-test behaviors verified live by gates procgen40/41;
v4.3's full one-gate-per-fresh-process board is the remaining formality.)*

## Next procgen arc — Plans 021–025 (designed, not started; numeric order = execution order)

Numbered by build order; each plan is self-contained for a cold-start agent
(intent, invariants, pitfalls in its §0):
1. **021 — fast testing** (first, so the rest build quicker): fuzz-tier
   split, renderer-degradation root cause, single-process board runner,
   MapController + FakeHost headless harness, change-scoped gating, T0–T3.
2. **022 — algorithm suite**: rivers (windiness/braiding), forests (types),
   parks (incl. japanese-garden), walls, farmland; preset-dropdown pattern
   everywhere; spine (line-kind) procgen.
3. **023 — constraint fields + elevation**: layered SDFs + masked noise;
   analytic-derivative fBm with gradient-damped octaves; contour lines;
   hillshade + 3D terrain via raster-DEM.
4. **024 — cross-layer regen cascade**: generated output of lower stages
   (river channel) constrains higher stages (city); turning a river's
   windiness knob regenerates the city around the new channel.
5. **025 — street-pattern presets + benchmarks** (Salat research): haussmann/
   tartan/ward-grid/eixample/baroque-axial/superblock/canal-rings/radial-star;
   metrics module makes the screenshot test numeric; preset gallery map.

## Standing risks
| Risk | Mitigation |
|---|---|
| MapLibre misbehaves inside Obsidian | Phase 0 Spike A before anything else; adapter keeps web-app escape hatch |
| Frontmatter corruption by templates/other plugins | Zod at reconcile; visible warning badges; never silent-drop |
| Generator output looks bad | Headless + snapshot fixtures; craft budget in 3b |
| Scope creep toward VTT | Non-goals list (architecture §7) is load-bearing |
| Obsidian API churn | Pin minAppVersion; host-agnostic core |
