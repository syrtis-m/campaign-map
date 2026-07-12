# Architecture — Obsidian Plugin

*Rev 2, July 2026: pivoted from standalone PWA to **Obsidian plugin**. Jonah runs campaigns from Obsidian; the map opens in a tab, and campaign data lives in the vault. Earlier decisions that survive: real OSM data for modern campaigns · per-campaign themes · solo-GM · continuous world→street zoom · determinism · canon-beats-procedure.*

## 1. Why the pivot wins

| Concern (old PWA design) | Obsidian resolution |
|---|---|
| Browser storage eviction (Safari 7-day wipe) | Gone. Vault = real files on disk |
| Export/import as P0 survival feature | Data is already plain files; export demoted to keepsake output |
| Sync across Mac Neo + Surface Pro | Obsidian Sync / git / iCloud — free, already in Jonah's workflow |
| Locations as rows in a private DB | **Locations are notes.** Wikilinks, backlinks, Dataview/Bases queries, session notes link to places |
| Distribution/updates | Community plugin or BRAT; esbuild bundle |

The deep win: **a place = a note.** Locations are born as markdown notes (quick-add, import, populate-area) — GM prep, session logs, and the map share one knowledge graph. Background geometry ("things on the map"/fabric) sits below them and never becomes a note. Plan 019 established a two-layer model (Locations over fabric); **plan 020 (Jonah, 2026-07-12) refined the fabric layer into two** — GM-drawn **sketch** above **procgen fabric** — giving the **three-layer model** (§5): procgen fabric < sketch < Locations.

## 2. Stack

| Layer | Choice | Notes |
|---|---|---|
| Host | **Obsidian plugin** (TypeScript + esbuild), custom `ItemView` map tab | [Views API](https://docs.obsidian.md/Plugins/User+interface/Views); desktop-first (Electron/WebGL), mobile later via Vault-API-only discipline |
| Renderer | **MapLibre GL JS** in the ItemView | WebGL in Electron confirmed; no MapLibre-in-Obsidian plugin exists yet (obsidian-leaflet is raster/Leaflet) |
| UI in-view | Preact or vanilla + Obsidian components | Keep it light; Obsidian provides modals/suggesters — reuse them (quick-add = Obsidian modal, feels native) |
| Canon store | **Markdown notes + YAML frontmatter** in the vault | See §3 |
| Cache store | **JSONL tile-chunk files** in `<campaign>/.mapcache/` + in-memory spatial index (**flatbush**) | SQLite dropped — no OPFS story needed, cache is regenerable |
| Real-city base | **PMTiles file in the vault**, read via Vault adapter → custom MapLibre protocol | Byte-range reads from local file; flag: large PMTiles may exceed sync file-size limits — document "exclude .mapcache + basemaps from sync, re-download instead" |
| Search | Obsidian quick switcher for canon (they're notes) + MiniSearch over cache for generated names | |
| Geometry/gen | turf (tree-shaken), d3-delaunay, custom tensor-field + WFC | Unchanged — generators are pure and host-agnostic |

Dropped entirely: PWA/service worker, OPFS, IndexedDB, SQLite WASM, standalone React app shell.

## 3. Data model: the vault layout

```
Campaigns/Ashfall/               # one folder per campaign
  Ashfall.map.md                 # campaign config note (frontmatter: theme, crs,
                                 #   scaleMetersPerUnit, seed, basemap ref)
  Locations/
    The Brine Cathedral.md       # canon location = a note
    Wrenhaven Docks.md
  Sessions/                      # Jonah's existing session notes — wikilink to locations
  .mapcache/                     # generated features, JSONL per tile-band; NEVER edited by hand;
                                 #   deterministic → deletable, regenerable, sync-conflict-immune
  basemap.pmtiles                # real-city campaigns only
```

Location note frontmatter (kept minimal — quality bar: notes stay human):

```yaml
---
map: ashfall
geometry: [1204.2, -388.7]        # point; or path to geometry file for polygons/lines
type: tavern                       # drives icon, importance, zoom-range defaults
aliases: [The Brine]               # feeds search
# optional overrides only when GM insists: zoom-range, icon, importance
---
```
Note body = GM notes, artist images, wikilinks — rendered in the map's detail popup via Obsidian's own markdown renderer (embeds, links, and theme CSS all just work).

**Reconciliation:** plugin watches vault events (create/modify/rename/delete on notes with `map:` frontmatter) → updates in-memory index → refreshes GeoJSON sources. Renaming a note renames the map label. Deleting the note removes the pin. The vault is the single source of truth for canon; the map is a *view* of it.

**Complex geometry** (imported rivers, district boundaries): a location note may point at a sidecar `*.geojson` file; frontmatter stays clean.

**Mutation log** (`.mapcache/log.jsonl`): still append-only, still powers undo/redo and the campaign-replay keepsake; but canon truth is the notes, and the log is derived history, not the store.

## 3b. Interaction model (Google-Maps-grammar)

The map speaks Google Maps' input language — zero learning curve:

- **Click a pin → place card.** Anchored popup: name, type icon, note-preview (first lines + image, rendered by Obsidian's markdown renderer so embeds/wikilinks/theme CSS work). Actions: *Open note* (adjacent pane), *Edit*, *Center*. Click elsewhere dismisses.
- **Click empty map → dropped pin.** Temporary pin + minimal tooltip (coordinates / nearest canon context, e.g. "Wrenhaven District") with one primary action: **"+ Add location here"** → quick-add modal (name + type, suggestions) → note created, pin becomes real. Esc/click-away dismisses. This *is* the ≤5s yes-and flow.
- **Right-click → context menu** (Obsidian's native `Menu`): Add location here · Generate surroundings · Measure from here · Copy coordinates.
- **Hover pin → name tooltip** (desktop); hover targets ≥ 24px regardless of icon size.
- **Search modal → flyTo** with eased camera; selected feature pulses once on arrival.

## 4. Rendering model

- MapLibre style JSON per theme; same feature schema, themes own all paint.
- **Default theme = `obsidian-native`** — a Google-Maps-like style *derived from the active Obsidian theme at runtime*: read computed CSS variables (`--background-primary` → land, `--background-secondary` → water/contrast, `--text-muted` → minor labels, `--text-normal` → major labels, `--interactive-accent` → roads-accent/selection, `--font-text` → label typeface) → emit a MapLibre style JSON → hot-swap via `setStyle` on Obsidian's `css-change` event. The map always looks like it shipped with the user's theme — dark, light, or custom.
- Handcrafted themes remain per-campaign overrides for genre atmosphere; `obsidian-native` is what new campaigns get:
  - **`parchment`** — cream, serif, texture fills, atlas edge treatments (fantasy)
  - **`ink-soot`** — dark desaturated, harsh contrast, hatch fills, gaslamp POI glow (Dishonored)
  - **`modern-clean`** — Google-Maps-like, pairs with Protomaps basemap layers
  - **`neon-sprawl`** — Cyberpunk-2077-inspired (original palette, no ripped assets): near-black base, arterial roads as neon light-trails (cyan/magenta line-glow via wide low-opacity casing layers), signature acid-yellow for selection/accent, angular condensed tech typeface (e.g. Rajdhani/Saira), holographic district labels (letter-spaced, slight chromatic double-stroke), POI icons as glyph-on-dark chips, unexplored space = static/noise texture. Works over real OSM basemaps too — any real city becomes Night City at 2am. Fictional-city gen pairs it with tensor-field grid+radial fields and megablock footprints.
- Fictional worlds: fake lng/lat in a bounded box, `scaleMetersPerUnit` per campaign. **Phase 0 spike still mandatory** (labels/bearing/fitBounds in fake-coord space).
- Canon notes → GeoJSON source "canon"; cache chunks → source "generated"; identical styling per type (provenance must be invisible — quality-bar F2).
- Location art tiers unchanged: custom PNG (now just **vault images**, referenced from frontmatter — artists drop files in a folder) → procedural sigils → theme template icons (game-icons.net pool).

## 5. Procedural generation: the three-layer model, sketch-driven (plan 019 → 020)

The deterministic core holds: tile seeds `hash(campaignSeed, tileX, tileY, zoom, generatorId)`; two generation tiers (world regions/routes; city streets/districts/blocks); persist to cache; halo overlap + hierarchical seeding against seams; regeneration never touches locations or sketches.

Established in plan 019, still true:
- **No automatic generation.** Nothing generates from pan/zoom — the old viewport dispatcher is gone (a test-API `generatorRunCount` stays flat under aggressive panning). Generation runs only on an explicit GM request.
- **The request is durable, the output is not.** On map open the durable request replays: cache hit or deterministic regenerate. Deleting `.mapcache/` stays harmless.
- **Sketched fabric is a constraint.** Every generator run receives the whole fabric collection: streets stop at sketched water and walls, align to sketched roads; a sketch edit inside a generated area auto-regenerates the affected output (never first-time generates).
- **No named generated POIs.** Settlements are Locations the GM places; the settlement generator survives only to serve populate-area's naming.
- **No canonization.** Fabric never becomes a note; there is nothing to promote.

### 5.1 The three layers (plan 020, in progress)

Plan 019's fabric layer splits into two, giving a **three-layer model** with strictly different lifetimes and one z-order (`layerOrder.ts` already encodes this; plan 020 names it):

| layer | contents | source of truth | editability |
|---|---|---|---|
| 3 (top) | **Locations** — note-backed pins | `Locations/*.md` frontmatter | notes |
| 2 | **Sketch** — GM-drawn shapes (roads, walls, rivers, water, districts, parks) | `Fabric.geojson` | select/edit any time (vertices + properties) |
| 1 (bottom) | **Procgen fabric** — generated output | regenerable `.mapcache/` only | never directly; only via the sketch shape or params that drive it |

The key inversion: **a sketched district polygon IS the request for city procgen.** Sketch a district → the city generator runs inside that polygon; the wall traces the sketched boundary (inset); all output stays strictly inside the line. The v3 disc-domain flow (click at z≥8 → DomainProfileModal → disc) is **retired by plan 020**. Sketch shapes become the durable, selectable handles on generated content: move a vertex → the city adapts (identity preserved); open the shape's procgen settings → change profile/re-roll → regenerate; delete the shape → the city is gone.

### 5.2 The procgen block on the fabric feature (plan 020, in progress)

`FabricFeatureSchema.properties` gains an optional `procgen` block:

```ts
procgen: { algorithm: string,  // registry id, e.g. "city"
           seed: number,       // hashSeed(campaignSeed, featureId), persisted at creation
           version: number,    // schema version of params
           params: Record<string, unknown> }  // validated by the algorithm's own zod schema
```

- A district feature **with** a procgen block is a **procgen region**; without one it is an inert overlay shape (modal-cancel keeps it inert — sketching never silently runs a generator the GM didn't confirm).
- The seed is computed **once at creation** and persisted. Vertex edits do NOT change it — the city keeps its identity while its boundary adapts. "Re-roll" replaces it with `hashSeed(seed, "reroll")` (logged). Determinism holds because the seed is durable data in `Fabric.geojson`, not derived at run time.
- City params v1: `{ profile: ProfileId }` (room to grow — density, wall override).

### 5.3 Algorithm registry + region geometry (plan 020, in progress)

`src/gen/procgen/registry.ts` maps a **sketch kind → procgen algorithm**: `{ id, label, appliesTo, paramsSchema, defaultParams(themeId), tileGeneratorIds, generate(seed, region, params, constraints) }`. v1 registers only `city` (wrapping `generateCityNetwork`). Future bindings (park→park-gen, forest/mountain polygons, river enrichment) slot in by adding a registry entry + params schema + pure generator — **zero new host lifecycle code** (host consults the registry, never `if (kind === "district")`).

`src/gen/region.ts` is the new pure geometry core built once per run from the fabric polygon (converted to gen-space meters, vertices mm-quantized on ingest — D5): `ProcgenRegion { id, ring, bbox, centroid, area, effectiveRadius }` with `regionContains` (even-odd), `distanceToBoundary` (signed, +inside), `interiorT` (0 deep-inside → 1 at boundary; deterministic 10 m lattice, robust for concave polygons), `boundaryPointAt` (centroid ray crossing — gate/arterial azimuths), and `insetRing` (miter-clamped — the wall/ring-road path). `effectiveRadius = sqrt(area/π)` replaces the disc `radius` in all size-scaled params. Ingest validates: simple-enough ring (reject with Notice, never crash), area within `[π·150m², π·2500m²]`.

The v3 `CityDomain {cx, cy, radius}` is replaced by `ProcgenRegion` throughout `src/gen/citynet/`: cityness falloff uses `interiorT` instead of `|p−c|/radius`; the wall + ring road follow `insetRing` instead of a circle; outskirts bands are gated by `interiorT` so nothing spills past the GM's line. The plan-019 "sketched district excludes ward sites" constraint is **retired** (a district now IS the city container); same-algorithm regions may not overlap (reject at creation, like the old `domainsOverlap`).

### 5.4 Requests, cache keying, replay, migration (plan 020, in progress)

- **World tier** requests are unchanged: one entry per generated area in `<campaign>/Generated.json` (tiny, synced, merge-friendly), replayed on open.
- **City tier** requests are no longer in the manifest — they live on the sketch feature's `procgen` block. On campaign load, every fabric feature with a procgen block is regenerated/re-clipped (cache hit or recompute, single shared cache read). The manifest's city-tier entries and `domains` array are **retired**.
- **Cache keying carries the region id** (fixes a latent v3 same-tile two-domain clobber): whole network `region:<regionId>:network`; per-tile clip `region:<regionId>:<tileX>:<tileY>:<generatorId>`; render-store `region:<regionId>:<x>:<y>`. `CachedTileSchema.key` is free-form — no schema change.
- **Migration (one-way, on campaign load):** if `manifest.domains` is non-empty, each disc converts to a district fabric feature — 32-gon polygon at `(cx, cy, radius)` with a `city` procgen block (`citySeedFor(campaignSeed, domain)`) — appended to `Fabric.geojson` (`sketch-add` log entries so undo works); the domain + its city-tier entries removed from the manifest; old city cache records dropped; one Notice. Old schemas stay parseable (zod fields optional). The city regenerates under the new polygon math — output differs from the v3 disc build (accepted pre-release: the request, not the bytes, is durable).

### 5.5 Lifecycle (host, `MapView`) (plan 020, in progress)

- **Create.** Finish a district sketch (`sketch-add`) → open **RegionProcgenModal** (schema-driven form from the registry entry) → "Generate city" attaches the procgen block (`sketch-procgen-set`) and generates the whole region (one network compute, clip to every overlapping tile, paint). Cancel keeps the shape inert. No zoom gate — city procgen is polygon-scoped. "Generate fabric here" outside any region at city zoom → Notice pointing at the district tool.
- **Edit → regenerate.** Any geometry or params edit to a region (vertex drag/insert/delete, profile change, re-roll) → debounce → drop that region's cache records → recompute + repaint. Edits to constraint-kind sketches (river/road/wall/water) regenerate every region whose bbox intersects the edited feature.
- **Clear / delete / undo.** "Remove generated city" strips the procgen block (`sketch-procgen-clear`) + drops cache + unpaints, shape stays inert. Deleting the shape (`sketch-remove`) also drops cache. New log types `sketch-edit` (before+after feature) and `sketch-procgen-set`/`sketch-procgen-clear` (before+after block) make edits and procgen toggles undoable; existing `sketch-add`/`sketch-remove` undo unchanged.
- **Edit UX (PowerPoint-style, all sketch kinds).** A **Select** tool: click a sketch feature → draggable vertex + midpoint handles; `Del` on a grabbed vertex removes it (min-vertex floor), `Del` with none grabbed deletes the shape (Notice-with-undo). A selected-feature panel shows name/kind and, for registry-backed kinds, the procgen section (enable/params/re-roll/regenerate/remove). Right-click a sketch feature at any time → "Edit shape" / "City settings…". The existing pin/place-card/dropped-pin click grammar (§3b) is untouched — sketch features participate via right-click outside sketch mode.

Generation runs in a Web Worker (works inside Electron renderer) so the map tab never stutters; the region job is `{ kind: "procgen-region", algorithmId, seed, ring, params, constraints }` (main-thread fallback preserved).

## 6. Obsidian-specific risks

| Risk | Handling |
|---|---|
| Plugin API churn / Electron upgrades | Pin `minAppVersion`; keep MapLibre + generators host-agnostic behind a thin adapter — the old web-app build remains a cheap escape hatch |
| Frontmatter mass-edits by other plugins/templates corrupt geometry | Zod-validate on every reconcile; invalid notes get a warning badge on the map, never silent drops |
| Multiple map tabs = multiple WebGL contexts | Allow one map view per campaign; second open focuses existing tab |
| Vault sync conflicts on cache | Immune by design (deterministic + regenerable + sync-excluded) |
| Sync file-size limits on PMTiles | Basemaps documented as "local, re-downloadable, don't sync"; config note stores the source URL |
| Mobile (Capacitor: no Node APIs) | Use Vault/DataAdapter APIs exclusively, never `fs` — keeps mobile possible; ship desktop-first |

## 7. Non-goals (v1) — unchanged

Multiplayer/player view · VTT combat grid · 3D · phones. LLM hook moves *closer* (Phase 5): campaign data is now markdown — an agent in the vault can read the whole world and emit valid location notes.
