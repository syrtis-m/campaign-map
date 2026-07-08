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

The deep win: **canon = has a note.** A generated tavern is cache; the moment it matters at the table, canonizing it *creates a markdown note*. GM prep, session logs, and the map share one knowledge graph.

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

**Complex geometry** (districts, coastlines, canonized street edits): a location note may point at a sidecar `*.geojson` file; frontmatter stays clean.

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

## 5. Procedural LOD + canon (unchanged, one amendment)

All of rev-1's design holds: deterministic tile seeds `hash(campaignSeed, tileX, tileY, zoom, generatorId)`; zoom-band generators (world → region → city → street); generate-on-demand, persist to cache; halo overlap + hierarchical seeding against seams; canon as constraints; regeneration never touches canon.

Amendment — **canonization = note creation**: promoting a generated feature writes `Locations/<Name>.md` with frontmatter and removes it from cache. Its geometry (and any GM tweak) is now canon, wikilinkable, and syncs like any note.

Generation runs in a Web Worker (works inside Electron renderer) so the map tab never stutters.

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
