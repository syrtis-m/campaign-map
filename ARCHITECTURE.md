# ARCHITECTURE.md — how the campaign-map plugin works

*Synthesized 2026-07-14 from the codebase, docs/, plans/, and DECISIONS.md. This is the
single high-level → medium-level map of the system for any agent (or future refactor)
that needs context. Low-level detail is deliberately left to the code — every section
names the files that own it. Where this document and the code disagree, the code wins;
where behavior and a locked decision disagree, the locked decision wins (see §12).*

---

## 1. What this is

An **Obsidian plugin** that gives a tabletop GM a Google-Maps-style map tab for their
campaign (fantasy, real-city modern, stylized). Campaign data lives **in the vault as
plain files**; the map is a *view* of it. The core product loop is "yes-and": a location
invented mid-session becomes a note + map pin in ≤5 seconds. On top of that sits a
deterministic procedural-generation engine — the GM sketches shapes (districts, rivers,
forests…) and the engine fills them with cities, meanders, canopy, terrain — plus
keepsake outputs (poster PNG, atlas PDF, campaign replay).

History in one line: this began as a standalone PWA design; it pivoted to an Obsidian
plugin (July 2026) because the vault dissolves the hard problems — browser-storage
eviction, export-as-survival, cross-device sync — and buys the deep win that **a place
= a note** (wikilinks, backlinks, session logs and the map share one knowledge graph).
Non-goals (v1): multiplayer/player view, VTT combat grid, phones, 3D beyond the
raster-DEM terrain.

Stack: **TypeScript + esbuild** (two bundles: `main.js` plugin + `generation-worker.js`
Web Worker), **MapLibre GL JS** rendered inside a custom Obsidian `ItemView`, **zod**
for every IO boundary, **Vitest** for headless tests, the official **Obsidian CLI** for
live integration gates. Desktop-first; Vault/DataAdapter APIs only (never Node `fs`) so
mobile stays possible. No SQLite, no server, fully offline.

---

## 2. The system in one page

Three **content layers** with strictly different lifetimes, one z-order
(`src/map/themes/layerOrder.ts` makes it structural — violations throw):

| layer | contents | source of truth | lifetime / editability |
|---|---|---|---|
| 3 (top) | **Locations** — note-backed pins | `Locations/*.md` frontmatter | the notes themselves; rename/delete a note ⇒ the map follows |
| 2 | **Sketch** — GM-drawn shapes (road, wall, river, water, district, park, forest, farmland, mountain) | `<campaign>/Fabric.geojson` | selectable/editable any time, PowerPoint-style (vertex handles + property panel) |
| 1 (bottom) | **Procgen fabric** — generated output | regenerable `.mapcache/` only | never edited directly; only via the sketch shape or params that drive it |

The key inversion (plan 020): **a sketched shape IS the generation request.** A district
polygon with a `procgen` block on it is a procgen *region*; the city generator fills
exactly that polygon. Move a vertex → the city adapts (same seed = same identity).
Re-roll → new seed, new city, same polygon. Delete the shape → the city is gone.
Generation is **explicit-only** — nothing ever generates from pan/zoom.

Dataflow, end to end:

```
vault files ──(zod parse at every IO boundary)──► in-memory model
  *.map.md            → ParsedCampaign            (model/campaignConfig.ts)
  Locations/*.md      → LocationIndex (flatbush)  (model/locationNote.ts, map/locationIndex.ts)
  Fabric.geojson      → FabricCollection          (model/fabric.ts, vault/fabricStore.ts)
  Generated.json      → GeneratedManifest         (model/generatedManifest.ts)  [world tier only]
  .mapcache/*.jsonl   → tile cache + mutation log (model/tileCache.ts, mutationLog.ts, demCache.ts)

GM action (sketch commit / params edit / re-roll / explicit generate)
  → MapController (controller/MapController.ts — host-agnostic lifecycle brain)
  → stage-DAG ordering (gen/procgen/dag.ts) + fingerprint staleness (gen/cache/fingerprint.ts)
  → per region: registry algorithm (gen/procgen/registry.ts)
      → pure generator in src/gen/** runs in the Web Worker (main-thread fallback)
      → whole-region network computed ONCE → clipped per tile per generatorId
      → appended to .mapcache/generated.jsonl (append-only, last-write-wins)
  → render store → MapLibre GeoJSON source "generated" → themed paint

render side (src/map/**):
  theme = MapLibre style JSON built from ThemeTokens; obsidian-native theme is
  derived live from Obsidian CSS variables; PMTiles basemaps and generated DEM
  raster tiles are served through custom MapLibre protocols.
```

Everything below the MapController line is **pure and host-agnostic** (no DOM, no
MapLibre, no Obsidian imports) — that is the load-bearing property for both testing and
any future renderer/engine migration (§10).

---

## 3. Vault data model (what persists, and where)

```
Campaigns/<Name>/
  <Name>.map.md          # campaign config note. Frontmatter (CampaignConfigSchema):
                         #   map-campaign: true · crs: fictional|real · theme · seed
                         #   scaleMetersPerUnit · bounds [minX,minY,maxX,maxY] (fictional)
                         #   basemap: path.pmtiles (real) · namingCultures: [ids]
  Locations/*.md         # a place = a note. Frontmatter: map, geometry [x,y], type,
                         #   aliases, visibility (wide|mid|close), connections: [wikilinks]
                         #   Body belongs to the human; plugin never writes below frontmatter.
  Fabric.geojson         # the sketch layer: FeatureCollection of FabricFeature
  Generated.json         # world-tier generation requests (tiny, synced, merge-friendly)
  Sessions/              # the GM's own notes; wikilink into Locations
  basemap.pmtiles        # real-city campaigns only (local, sync-excluded, re-downloadable)
  .mapcache/             # REGENERABLE, sync-excluded, deletable at any time:
    generated.jsonl      #   tile cache (CachedTile records, append = logical overwrite)
    log.jsonl            #   append-only mutation log (undo/redo + campaign replay)
    dem.jsonl            #   quantized DEM tile lattices (hillshade/3D terrain)
```

**Durable vs. regenerable is the central split.** Durable: notes, `Fabric.geojson`,
`Generated.json`, the campaign config. Regenerable: everything in `.mapcache/`.
*Deleting `.mapcache/` must be harmless — the map regenerates byte-identically. If it
doesn't, determinism broke and that's a release blocker.*

`FabricFeature` (`model/fabric.ts`): `{ id, geometry: LineString|Polygon, properties:
{ kind, name?, procgen? } }`. The optional **procgen block** is what turns a shape into
a generation request:

```ts
procgen: {
  algorithm: string,   // registry id: "city" | "river" | "forest" | "park" | "wall" | "farmland" | "mountain"
  seed: number,        // hashSeed(campaignSeed, featureId) — persisted AT CREATION, never re-derived
  version: number,     // params schema version
  params: {...},       // validated by the algorithm's own zod schema in the registry
  presetId?: string    // display-only sugar; generators NEVER read it
}
```

The **mutation log** (`model/mutationLog.ts`) records only *map-originated* writes:
`create`, `move`, `sketch-add/remove/edit`, `sketch-procgen-set/clear`,
`generate-area`, `clear-area` — each with enough before/after data to undo. It powers
undo and the campaign-replay keepsake; canon truth stays in the notes.

**Reconciliation** (`main.ts`): vault events (create/modify/rename/delete +
metadataCache changes) are coalesced (~50 ms) into a full rescan → campaign configs and
location notes re-parse → `LocationIndex` (flatbush) updates → open map views repaint.
Invalid frontmatter gets a warning, never a silent drop.

---

## 4. Coordinate systems and units

Three spaces; conversions live in `controller/units.ts` and `map/fictionalCRS.ts`:

1. **Display space** — MapLibre lng/lat. Fictional campaigns use *fake* coordinates in
   a bounded box kept near the equator (lat ≈ ±10°) so Mercator distortion is
   negligible; `scaleMetersPerUnit` maps one fake degree to campaign meters (scale bar,
   distances). Real campaigns use real WGS84 over a PMTiles basemap.
2. **Generation space** — flat meters. All of `src/gen/**` works here. The host
   converts sketch geometry units→meters before generating and meters→units before
   painting.
3. **Tile grid** — `gen/cache/tileGrid.ts`: fixed 600 m tiles at `GENERATION_ZOOM = 0`,
   `tileKey = seed:x:y:zoom:generatorId`. Two request tiers share the grid: *world*
   (regions/settlements/routes, per-tile) and *city* (region-scoped, see §5).

**Zoom-LOD ruling (locked, Jonah, reaffirmed twice):** zoom affects **location-name
visibility only** (three depth-of-field buckets: wide/mid/close, computed relative to
the campaign's overview zoom — `model/locationNote.ts`). Sketched and generated fabric
render at **every** zoom; density problems are solved by theme paint (opacity ramps),
never by minzoom gates. Never bake absolute zoom thresholds anywhere — fictional
overviews sit around z4.5, so a z14 gate is simply unreachable.

---

## 5. Determinism (the sacred contract)

Same durable inputs ⇒ same map, forever, on the same machine. The whole cache design
depends on it. The discipline is codified as **D1–D6** (`docs/procgen-design.md`,
restated in module headers throughout `src/gen/`):

- **D1 — decisions live on integer lattices.** Street-growth topology on a 1 cm integer
  lattice (`citynet/graph.ts`), A* cost field on a world-anchored 10 m lattice,
  interior-distance scans on a 10 m lattice. Exact integer predicates, no FP equality.
- **D2 — no order dependence.** Every tie-break is a total order over position-derived
  ids (`hashSeed`), never insertion/iteration order. Feature lists are canonically
  sorted (first coordinate, then id) before emission.
- **D3 — budgets, not convergence.** Hard caps (`maxSegments`, A* expansion caps,
  recursion depth) with deterministic degraded fallbacks; nothing loops "until done".
- **D4 — trig only shapes, never decides.** FP trig may position geometry; no topology
  gate compares trig output for equality.
- **D5 — mm quantization at every emission.** All emitted coordinates are quantized to
  the millimeter; region rings are mm-quantized at ingest.
- **D6 — generators read only their arguments.** No host-side data (timestamps, view
  state) ever crosses into generation. Seeds are durable data (persisted in the procgen
  block), *never* derived from floats at run time.

Seeds: `mulberry32` PRNG + `hashSeed(...parts)` FNV-style combiner (`gen/rng.ts`).
Region seed = `hashSeed(campaignSeed, featureId)` persisted at creation; re-roll
replaces it with `hashSeed(seed, "reroll")` and logs it.

**Self-invalidation:** every region cache record carries a `fingerprint` — a canonical
hash of the durable inputs that produced it (seed + params + quantized ring/spine + the
raw sketch constraints + sorted upstream-region fingerprints; `gen/cache/fingerprint.ts`).
Replay treats a key hit with a stale fingerprint as a miss. This is what catches an
external `Fabric.geojson` edit (vault sync, another device) that no in-app commit saw.

**Caveats that matter:** determinism is **per-machine** (V8 transcendentals aren't
bit-identical across architectures — fine, because the cache never syncs). And the
world-tier heightmap (`gen/world/heightmap.ts`, cubic value noise) is byte-frozen: a
single reassociated addition there re-rolls every existing campaign. The newer
analytic-derivative quintic noise (`gen/fields/elevation.ts`) is a deliberately
*separate* function consumed only by new features.

---

## 6. The procgen engine (src/gen/ — pure, headless, host-agnostic)

### 6.1 Registry: sketch kind → algorithm

`gen/procgen/registry.ts` is the single binding point. Each `ProcgenAlgorithm` declares:
`id`, `appliesTo` (fabric kinds), `stage` + `produces`/`consumes` (cascade wiring, §6.2),
`paramsSchema` (zod — malformed persisted params fail loudly at the boundary),
`presets` (named param bundles; **params are the whole truth**, presets are display
sugar), `defaultPresetId(themeId)`, `tileGeneratorIds` (the feature buckets it emits —
cache keys and paint layers key on these; *an emitted gid missing from this list is
silently dropped at clip time*, a twice-hit bug), an optional
`corridorMaxOffset(params)` for line kinds, and the pure
`generate(seed, region, params, constraints)`.

Host lifecycle code consults the registry only — never `if (kind === "district")`.
Adding an algorithm = registry entry + params schema + pure generator + theme layers;
zero new host lifecycle code.

Registered algorithms and their stages:

| algorithm | kind | stage | produces → consumes | generator |
|---|---|---|---|---|
| mountain | polygon | 0 elevation | elevation ← ∅ | `gen/mountain.ts` (massif, hachures, peaks, contours over the elevation field) |
| river | line | 1 hydrology | water ← elevation | `gen/river.ts` (meanders/braiding/width growth, banks, islands, confluences, estuary, oxbows) |
| forest | polygon | 2 vegetation | vegetation ← water | `gen/forest.ts` (Thomas-cluster trees, marching-squares cloud canopy with clearing holes) |
| park | polygon | 2 vegetation | vegetation ← water | `gen/park.ts` (variety-driven layouts incl. japanese-garden; paths, pond, court, rocks) |
| farmland | polygon | 2 (grouped) | ∅ ← elevation | `gen/farmland.ts` (strips/patchwork/grid/orchard/paddy-terraces) |
| city | polygon | 3 settlement | settlement ← water, vegetation | `gen/citynet/**` (§6.3) |
| wall | line | 4 detail | detail ← settlement | `gen/wall.ts` (curtain/palisade/bastioned; towers, gates, moat) |

### 6.2 Regions, spines, and the cross-layer cascade

`gen/region.ts` — **ProcgenRegion**, the geometric container built once per run from
the sketched polygon (mm-quantized, CCW-normalized): `centroid`, `area`,
`effectiveRadius = √(area/π)` (replaces the old disc radius in all size-scaled params),
`interiorT` (0 deep inside → 1 at boundary, via a deterministic 10 m lattice — robust
for concave rings), `insetRing` (miter-clamped — the wall/ring-road path),
`boundaryPointFrom` (gate/arterial azimuths). Line kinds (river, wall) get a **spine**
corridor instead: containment = "within `corridorMaxOffset(params)` of the polyline";
identity-preserving keying hashes each *segment's* quantized endpoints so a one-vertex
edit never re-rolls the whole line. Region area is clamped to [π·150², π·2500²] m² at
ingest (reject with a Notice, never crash).

`gen/procgen/dag.ts` — the **stage DAG** that makes the suite feel like one world:
edge `A → B` iff `stage(A) < stage(B)` ∧ `produces(A) ∩ consumes(B) ≠ ∅` ∧ bboxes
(grown by a margin) overlap. Cycle-free by construction; same-stage regions never see
each other's output (only each other's sketch). Replay and cascade both walk the one
deterministic order: `(stage, regionId)` lexicographic. Turning a river's windiness
knob regenerates the downstream city around the new channel; the recompute set is the
downstream closure. Upstream generated output crosses to consumers **as data**
(GeoJSON lists, `gen/upstream.ts`) because field closures don't survive
`structuredClone` into the worker; both sides rebuild identical SDF closures from it.

Constraints (`gen/types.ts`, `gen/fabricConstraints.ts`): every generator run receives
`worldBounds`, canon location features, the **whole** sketched fabric collection (never
pre-clipped, or adjacent tiles would derive different fields), naming genre/cultures,
and optionally `upstream`. Sketched water/rivers block streets, roads steer the street
tensor, walls stop growth, farmland suppresses outskirts.

### 6.3 The city pipeline (gen/citynet/ — the flagship)

`generateCityNetwork(seed, region, profile, constraints, center?, overrides?)` computes
the **whole city once per region** (never per tile); tiles then clip the same bytes, so
seams are impossible by construction. Stages, in fixed order:

1. **Cost field** (`costField.ts`) — world-anchored 10 m lattice: cheap open ground,
   expensive river crossings (bridges concentrate), impassable lakes, avoids canon pins.
2. **Skeleton** (`skeleton.ts`, Stage A) — radial arterials A*-routed from the
   generation center (centroid, or interior pole for concave rings; GM-draggable
   `params.center` override) to boundary points; bridges at river crossings; quays;
   central plaza + landmark footprints; profile-gated **wall** tracing `insetRing` with
   gates where arterials cross.
3. **Growth** (`growth.ts`, Stage B) — Parish & Müller priority-queue street growth on
   the 1 cm integer lattice (`graph.ts`), with snap-to-node / cut-to-T-junction local
   rules, modulated by the **cityness** field (`cityness.ts`: interiorT falloff × noise
   + bumps around GM pins — "the city grows around the GM's pins").
4. **Axial / ring operators** (`axial.ts`, `rings.ts`) — post-growth, pre-faces:
   haussmann breakthrough boulevards, baroque tridents, concentric canal rings /
   radial-star ring roads, spliced into the planar graph so downstream stages compute
   once (no reflow pass).
5. **Faces** (`faces.ts`, Stage C1) — planar-graph face extraction by smallest-left-turn
   half-edge traversal ⇒ city blocks; eixample chamfer operator; degenerate faces
   skipped and counted, never thrown ("anti-Watabou salvage").
6. **Parcels** (`parcels.ts`, C2) — recursive OBB slicing to lot size, one footprint per
   street-fronting lot, inset toward and aligned with its frontage.
7. **Wards** (`wards.ts`) — coarse Voronoi over skeleton sites, tagged
   market/craft/temple/slum; themes tint subtly.
8. **Outskirts** (`outskirts.ts`) — outside the growth extent but inside the region:
   houses ribbon along arterials, fields beyond, nothing at the rim.

Emission: mm-quantized, canonically sorted, every ring containment-guarded against the
region (nothing spills past the GM's line). Buckets: `city-street` (with an explicit
form-based `width` in meters), `city-block`, `city-parcel`, `city-footprint`,
`city-landmark`, `city-district`. `profiles.ts` is a pure data table of 12 profiles
(euro-medieval … radial-star). `metrics.ts` turns the screenshot test numeric —
intersection density, street linear density, land share, width histogram — calibrated
against Salat's figure-ground research. `domain.ts` is the retired v3 disc, kept only
for the one-way migration (disc → 32-gon district polygon, same seed).

### 6.4 Fields, world tier, and the rest of src/gen/

- `gen/fields/` — reusable point-evaluable scalar fields (`f(x,y)` from durable inputs
  only — the property that makes tiles seam-free): SDFs (`sdf.ts` — the bit-exact
  source of truth that `region.ts` and `fabricConstraints.ts` import back),
  combinators, metaballs, **marching squares** (shared iso-line machinery: mountain
  contours, forest canopy), smoothing, analytic-derivative fBm elevation
  (`elevation.ts`), mountain height field, and DEM lattice/terrarium packing
  (`dem.ts` — numeric half only; PNG encoding is host-side and is *not* a determinism
  surface).
- `gen/world/` — the world tier: per-tile `(seed, bbox, constraints) => Feature[]`
  generators for coarse regions/biomes (frozen cubic noise heightmap), settlements
  (naming only — settlements are never auto-placed as Locations), routes.
- `gen/city/` — the *legacy* tensor-field street module (plan 014 road-corridor
  elaboration); `fabricConstraints.ts` still uses its angle sampler for sketched-road
  alignment.
- `gen/naming/` — phoneme-table naming cultures per genre (fantasy/modern/neon),
  campaign-restrictable; feeds quick-add suggestions and populate-area.
- `gen/sigil/` — seeded SVG sigils (mid tier of location art: vault image → sigil →
  theme template icon).
- `gen/clip.ts` — Liang-Barsky / Sutherland-Hodgman; two tiles clipping the same
  geometry against a shared edge produce bit-identical boundary points (the 2×2 seam
  guarantee). `gen/spatialHash.ts`, `gen/voronoiCells.ts` — shared primitives.

---

## 7. Host architecture (the Obsidian/MapLibre side)

- **`main.ts`** — plugin entry: command registration, ribbon icons, campaign/location
  rescan on vault events, per-campaign "Open map" commands, the shared
  `GenerationWorkerClient`, and the **test API** surface
  (`app.plugins.plugins['campaign-map']` → `map`, `index`, `log`, `generated`,
  `generatorRunCount`, `rescanTimeMs`, …) that all CLI gates drive.
- **`controller/MapController.ts`** — the host-agnostic **lifecycle brain** (plan 021
  extraction): owns generation/regen/clear/undo/replay/migration/region-procgen/
  sketch-commit orchestration and the state they touch (render store, manifest, fabric
  collection, gate counters). Talks to the world only through eight narrow interfaces —
  `VaultGateway`, `GenGateway`, `CanonGateway`, `NoteOps`, `NoticeSink`, `ConfirmSink`,
  `RenderSink`, `Viewport` — so it has zero DOM/MapLibre/Obsidian imports and runs headless against
  `controller/FakeHost.ts` (in-memory vault) in unit tests. **MapView is wiring + paint;
  the controller is behavior.** `controller/units.ts` owns unit↔meter conversion.
- **`view/MapView.ts`** — the `ItemView`: MapLibre map construction, style
  build/rebuild, toolbar (Add / Sketch / Search / Theme / Settings), place cards +
  dropped-pin quick-add (the Google-Maps interaction grammar), focus/depth-of-field
  control, terrain toggle, loading indicator, session paths, replay, exports, and
  headless test-API twins for every modal flow (modals hang CLI automation —
  `createRegionForTest`, `moveVertex`, `setRegionParams`, `rerollRegion`, …, each
  running the FULL commit path).
- **`view/SketchController.ts`** — draw + select tools: draft rendering, vertex/
  midpoint/center handles, min-vertex floors; reports whole-feature geometry edits back
  to the host, which turns them into `sketch-edit` log entries + persist + regen.
- **`view/*Modal.ts`** — QuickAdd, RegionProcgenModal (schema-driven params form from
  the registry entry; preset dropdown, kept flat at 10+ presets per OQ#2),
  CampaignControl (generate/export/canonize moved off the toolbar), CreateCampaign,
  LocationSearch, ThemeSwitcher, PopulateArea, ImportFile.
- **`map/generation/generationService.ts`** — cache-or-generate glue: world-tier
  `generateTile` and region-scoped `generateRegionTile` (network computed once, cached
  under `region:<id>:network`, clipped per tile under `region:<id>:<x>:<y>:<gid>`).
  Cache hits never re-check constraints (freshness is the fingerprint's job).
- **`map/generation/workerClient.ts` + `gen/worker/generationWorker.ts`** — the worker
  boundary. The worker bundle is loaded via a Blob URL (Electron CSP workaround). Jobs:
  per-tile world generators and whole-region procgen (`{ algorithmId, seed, ring,
  params, constraints }` — the worker rebuilds the region and consults the same
  registry). Main-thread fallback preserved everywhere.
- **`vault/*.ts`** — the App-typed IO for fabric/manifest/locations/imports
  (`fabricStore`, `generatedManifestStore`, `locationOps`, `campaignOps`, `importOps`).
- **`model/*.ts`** — zod schemas + pure helpers (fabric ops, tile cache, mutation log,
  manifest, location taxonomy + visibility buckets, connections, session paths,
  GeoJSON/Azgaar/Watabou import parsing, DEM cache). `model/tileCache.ts` serializes
  all appends through a per-file promise chain — **never bypass `appendCachedTile`**
  (two racing writers on a freshly deleted file used to clobber records).

Connections (point-crawl lines) are canon-native: a `connections:` wikilink list in a
location note's frontmatter resolves at reconcile time into line features — they
survive renames and vanish with a deleted endpoint.

**The interaction grammar is Google Maps'** (locked decision) — zero learning curve:

- **Click a pin → place card.** Anchored popup: name, type icon, note preview rendered
  by Obsidian's own markdown renderer (embeds/wikilinks/theme CSS just work). Actions:
  Open note (adjacent pane) · Edit · Center. Click elsewhere dismisses.
- **Click empty map → dropped pin** + one primary action **"+ Add location here"** →
  quick-add modal (name + type) → note created, pin becomes real. This IS the ≤5 s
  yes-and flow. Esc/click-away dismisses.
- **Right-click → native Obsidian `Menu`**: Add location here · Generate surroundings ·
  Measure · Copy coordinates; on a sketch feature: Edit shape / region settings.
- **Hover pin → name tooltip**; hover targets ≥24 px regardless of icon size.
- **Search modal → flyTo** with eased camera; the selected feature pulses on arrival.

Host risks and their standing answers: plugin-API churn (pin `minAppVersion`; keep
generators + MapLibre behind the gateway seam), frontmatter mass-edits by other
plugins (zod-validate every reconcile — invalid notes get a warning badge, never a
silent drop), multiple map tabs = multiple WebGL contexts (one view per campaign;
second open focuses the first), vault-sync conflicts on cache (immune by design:
deterministic + regenerable + sync-excluded), PMTiles sync size limits (basemaps
documented local/re-downloadable), mobile (Vault/DataAdapter APIs only, never `fs`).

---

## 8. Rendering

- **Themes are MapLibre style JSONs.** Same feature schema everywhere; **themes own ALL
  paint; generators emit typed features only, never styles.** Five themes:
  `obsidian-native` (default — style generated at runtime from Obsidian CSS variables,
  rebuilt on `css-change`; labels always render in Inter because live glyph-PBF
  generation for arbitrary fonts isn't a thing) plus four handcrafted genre themes:
  `parchment` (cream, serif, atlas edge treatments — fantasy), `ink-soot` (dark
  desaturated, harsh contrast, hatch fills, gaslamp POI glow — Dishonored-esque),
  `modern-clean` (Google-Maps-like, pairs with Protomaps basemaps), `neon-sprawl`
  (Cyberpunk-inspired original palette: near-black base, neon light-trail arterials
  via wide low-opacity casings, acid-yellow selection accent, holographic district
  labels). Inspired-by aesthetics only — never copied game assets/trade dress.
- **`map/themes/tokens.ts`** — `ThemeTokens`: ≤8 semantic colors per theme plus
  per-fabric-kind colors. Pinned values (agents may tune ±10 % L/C in OKLCH, logged in
  DECISIONS, never hue). Sketched and generated fabric of the same kind share tokens —
  provenance must be invisible (quality-bar F2).
- **`map/themes/layerOrder.ts`** — the z-order invariant, asserted at style-build time
  and unit-tested: `background < basemap < hillshade < generated < fabric <
  connections < session-path < location dots < labels`. A layer id no group claims
  throws.
- **Layer builders** (`map/themes/*.ts`, `map/themes/generated/*.ts`) — per-source
  layer recipes: canon pins/labels, basemap, fabric (sketch), generated (per-algorithm
  paint under `generated/{city,river,forest,park,wall,farm,mountain,world}.ts`),
  connections, session paths, hillshade.
- **Glyphs & icons** — font PBFs ship in plugin assets, served through a fake
  `campaignmap-glyphs://` scheme resolved in `transformRequest` (`map/glyphs.ts`).
  Tree/park/river prop icons are **runtime-rasterized SDF glyphs** (`map/treeGlyphs.ts`
  and friends): a pure inside/outside predicate → supersampled coverage → Felzenszwalb
  EDT → tiny-sdf-encoded RGBA, so MapLibre tints/halos them per theme; no canvas,
  headless-testable by pixel hash.
- **Custom protocols** — `pmtiles://`-style vault protocol for real-city basemaps
  (`map/pmtilesVaultProtocol.ts`: whole-file read into memory + slice — DataAdapter has
  no pread) and `campaigndem://` (`map/campaignDemProtocol.ts`) serving generated
  raster-DEM tiles for hillshade/3D terrain: the durable record is the quantized int
  lattice in `.mapcache/`; terrarium PNG bytes are re-encoded at serve time and never
  byte-compared. DEM tiles fetch on pan/zoom *by design* — that's field evaluation, not
  procgen; `generatorRunCount` never moves.
- **Exports** — `map/posterExport.ts` (offscreen high-res tiled render) and
  `map/atlasExport.ts` (PDF: maps + the location notes as gazetteer).

---

## 9. Testing & dev workflow (what an agent actually runs)

Tiers (docs/05 — binding cadence, Jonah 2026-07-13):

| tier | when | what |
|---|---|---|
| **T0** | every edit | `npm test` (fast Vitest, <45 s) + `tsc --noEmit` |
| **T1** | per-phase commit | T0 + `npm run build` + that phase's own live gate standalone (+ `npm run test:fuzz` iff generator behavior changed) |
| **T2** | diagnostic | `npm run gates:changed` (diff-scoped gate selection via `scripts/gates/coverage.json`) |
| **T3** | **once per plan**, at its final phase | `npm run board` — full board in one Obsidian process with renderer-health probes and auto-relaunch (`scripts/board.ts`) |

Hard rules: the full board is never run per phase or to chase flakes — a gate that
fails in-board but passes standalone is an environment flake (long-lived-renderer
degradation): log it, count it green. Fuzz/stress tests live in `*.fuzz.test.ts`
(separate Vitest config). Live gates are `scripts/gates/*.ts`, driven through the
official Obsidian CLI against `dev-vault/` (**never** Jonah's real vault; note
`dev-vault/Campaigns/Vespergate` holds his real campaign data — fixtures must be
name-tagged, self-cleaning, and leave those files byte-intact).

**Generator work starts in the playground** (`npm run playground` →
http://localhost:8734; `playground/`): a standalone browser harness that imports
`src/gen` directly — live zod-derived param knobs, seed scrubbing, a preset grid, and
region/spine shape variants, with no build/reload cycle. It judges geometry and
composition only (its paint is a per-gid shim until plan 030-D); theme paint and host
integration still go through the Obsidian loop.

The live inner loop (host/theme/integration): `npm run build` → `obsidian
plugin:reload id=campaign-map` (never `plugin:enable` — silent no-op) → drive via
`eval`/`command` → `obsidian dev:errors` must be clean → `obsidian dev:screenshot` and
**actually view the png** (the docs/04 screenshot test: no label collisions, no seams,
no voids, no default fonts, genre identifiable in 3 s). Full pitfall list: docs/05
§Hard-won pitfalls.

State files for multi-session/autonomous work: `PROGRESS.md` (log), `DECISIONS.md`
(rulings + rationale), `HEARTBEAT.md` (current wave checklist), `plans/NNN-*.md`
(numbered feature plans, each with a cold-start §0), `review/` (Tier-B items),
`GOAL.md`, docs/06 (autonomous protocol), docs/07 (LLM note-emission contract), docs/08
(loop-run pattern).

---

## 10. Portability map — for the possible Godot / WebGPU / Three.js refactor

The codebase is already partitioned along exactly the seams a re-platforming would cut.
Dependency direction is strictly one-way:

```
src/gen/**  ──►  nothing outside itself (+ zod-only model/fabric.ts)     PURE CORE
src/model/** ──► zod (+ Obsidian App ONLY in the IO functions)           MOSTLY PURE
src/controller/** ──► model + gen (host behind 7 interfaces)             PURE BRAIN
src/map/**  ──► MapLibre + Obsidian App                                  RENDERER-COUPLED
src/view/** + main.ts ──► Obsidian + MapLibre + controller               HOST SHELL
src/vault/** ──► Obsidian App                                            HOST IO
```

**What ports unchanged (the asset):** all of `src/gen/` (~half the codebase — citynet,
rivers, forests, parks, walls, farmland, mountains, fields, world tier, naming, sigils,
clip/rng/spatialHash), the zod data model, and `MapController` + `FakeHost`. These have
zero DOM/MapLibre/Obsidian imports, are plain TS, and carry the entire determinism
contract. Any new host reimplements the seven gateway interfaces and keeps the brain.

**The renderer contract** (what a Three.js/WebGL or Godot map must re-provide):
GeoJSON feature sources (`canon`, `generated`, `fabric`, `connections`,
`session-path`) + the per-theme paint derived from `ThemeTokens` + the
`layerOrder.ts` z-invariant + label collision/priority handling (currently free from
MapLibre's symbol placement — the single biggest thing to replace) + the fictional-CRS
trick (which only exists *because* MapLibre assumes Mercator; a bespoke renderer can
use gen-space meters directly and delete `fictionalCRS.ts`). PMTiles basemaps and
glyph-PBF fonts are MapLibre-ecosystem artifacts and would be replaced wholesale.

**WebGPU-for-procgen caution:** the determinism contract (§5) is built on exact integer
lattice arithmetic, total-order tie-breaks, and canonical sorting — sequential-CPU
properties. GPU parallel float reduction is order-nondeterministic by default, so a
naive port breaks byte-stable caching. Viable split: keep *topology* decisions
(growth, faces, A*) on CPU integer lattices, move *embarrassingly parallel field
evaluation* (elevation/DEM lattices, cost fields, SDF sampling, marching-squares
lattice sampling — everything in `gen/fields/`) to GPU, treating GPU output as a
regenerable view (like the DEM PNG path already does: durable = quantized int lattice,
encoded bytes = never compared). If topology must move to GPU, that's a declared
determinism-baseline break: re-golden everything, one-way cache migration.

**What would be discarded per target:** Godot — all of `src/map/` + `src/view/` +
Obsidian integration (but then the vault-as-source-of-truth story, wikilinks, and the
note-rendering place cards go too; that's the product's spine, so a Godot move implies
a companion-app model, not a port). Three.js/WebGL inside Obsidian — only `src/map/`
(protocols, themes-as-MapLibre-style, glyphs) and the MapLibre halves of MapView;
everything else survives.

**Elevation/3D-aware work** (the stated motivation): the clean substrate is already in
place — point-evaluable elevation fields (`gen/fields/elevation.ts`,
`mountainField.ts`), the DEM lattice pipeline (`fields/dem.ts` numeric /
`campaignDemProtocol.ts` serving), stage-0 `elevation` as a first-class constraint
currency in the DAG, and consumers wired (river slope-straightening, paddy terraces,
contours, hillshade, MapLibre 3D terrain). Any richer 3D renderer should keep
*fields as the source of truth* and treat meshes/rasters as regenerable derivations.

---

## 11. Performance model

Budget target is a Surface Pro at 60 fps inside Obsidian; the dev machine (Mac Neo) is
several times faster, so **perf claims need CPU-throttled numbers, never feel**.
Current known-unmeasured hotspots: always-visible footprints/parcels (~12k fills;
always-visible is a locked product decision — the fix space is paint, not gating) and
whole-collection `setData` on regen. Generation runs in the worker so the map thread
never stutters; region networks are computed once and clipped, so cost scales with
region count, not tile count. The renderer degrades over very long sessions (known,
mitigated by the board's health probes; root-cause work tracked in plan 021).

---

## 12. Invariants checklist (the things that must not regress)

This is the **single home** for system invariants. Each entry names what enforces it —
a test, an assert, or (marked *policy*) a review-time rule with no mechanical guard.

1. Vault = source of truth; map = view. The plugin never writes below a note's
   frontmatter fence. — *enforced:* `vault/locationOps.test.ts` (frontmatter-only
   writes); reconcile round-trip gates.
2. Three-layer z-order: procgen < sketch < locations. — *enforced:*
   `map/themes/layerOrder.ts` throws at style build; `layerOrder.test.ts`.
3. Fabric never becomes a note; no canonize/promote path exists. — *enforced:* no such
   code path (*policy*; grep for "canonize" stays empty).
4. Generation is explicit-only; `generatorRunCount` stays flat under any pan/zoom. —
   *enforced:* pan/zoom assertions in `MapController.test.ts` and the live gates
   (procgen41 (g) et al.).
5. The request is durable (procgen block / manifest); the output is regenerable.
   Deleting `.mapcache/` is harmless for every region at its algorithm's
   `currentVersion` — byte-identical regeneration, per machine. Carve-out: regions
   pinned to OLDER versions need explicit adoption before they can re-render; the map
   shows a needs-adoption badge and never silently substitutes different bytes. —
   *enforced:* cache-delete regen tests in `MapController.test.ts`; the adoption
   family there + `scripts/gates/version29.ts`.
6. **Determinism is versioned**: same `(seed, params, algorithm version)` ⇒ same
   bytes, forever, per machine (D1–D6 binding within a version). A change that alters
   output bytes for the same inputs bumps the algorithm's `currentVersion` and
   re-goldens (`npm run goldens:accept -- <algorithm>`); prefer an additive param when
   absence naturally reproduces old behavior (preference, not law). Regions pin their
   version at creation; only explicit GM adoption raises the pin; no per-version code
   forks, ever. — *enforced:* `gen/procgen/versioning.test.ts`,
   `gen/cache/fingerprint.test.ts` (version flips the fingerprint), per-algorithm
   byte-goldens (one each), `expectDeterministic` in every generator suite.
7. Seeds are persisted data; never derived from floats at run time. Vertex edits keep
   the seed; only re-roll replaces it. — *enforced:* seed-stability tests in
   `MapController.test.ts` (procgen41 family).
8. All generated output stays inside the sketched ring / spine corridor. — *enforced:*
   `expectGeneratorInvariants` (gen/testkit/invariants.ts) in every generator suite;
   containment reports in live gates.
9. Generators are pure `(seed, region|bbox, params, constraints) => Feature[]`; no
   DOM/map/Obsidian imports in `src/gen/` (worker entry excepted); they emit typed
   features, never styles. — *enforced:* headless Vitest runs (an Obsidian import
   would fail to resolve); *policy* on the no-styles half until the 030-D contract
   test lands.
10. Params are the whole truth; presets/`presetId` are display sugar a generator never
    reads. — *enforced:* `gen/procgen/registry.test.ts` preset/params contract.
11. Every emitted generator-id must be in the algorithm's `tileGeneratorIds` (an
    uncached gid is silently dropped at the tile clip). — *enforced:* per-generator
    emitted-gid tests; becomes derived-from-contract + unit-asserted in 030-D.
12. Zoom LOD affects location-name visibility only; no absolute zoom thresholds
    anywhere. — *enforced:* no-minzoom assertions (procgen41 (i)); fabric layers carry
    no `minzoom` (*policy* beyond that).
13. Zod at every IO boundary; bad data → visible warning, never a silent drop, never a
    crash (degenerate geometry skipped and counted). — *enforced:* model schema tests;
    import-parser tests; reconcile gates.
14. Vault/DataAdapter APIs only; never Node `fs`. — *enforced:* mobile-emulation smoke
    (docs/05); *policy* in review.
15. All map-originated writes append to the mutation log and are undoable. —
    *enforced:* undo round-trip tests in `MapController.test.ts` + mutationLog tests.
16. Never bypass `appendCachedTile`; cache appends serialize through the per-file
    promise chain. — *enforced:* `model/tileCache.test.ts` racing-writers test;
    *policy* at call sites.
17. `world/heightmap.ts` noise is byte-frozen (world tier has no version pin yet; see
    plan 029 §7). — *enforced:* world snapshot tests.
18. Locked decisions live in CLAUDE.md and DECISIONS.md — don't relitigate without
    Jonah. — *policy.*
19. New presets of an existing algorithm are params + existing operators — data tables
    keyed by profile/variety are data; preset-conditional branches inside generator
    stages are not allowed. Operators move to a shared home only on their second
    consumer. — *policy* (the 030-C convention), checked at review.

## 13. Where to read more

- `docs/01` (research) · `docs/03` (roadmap, historical) · `docs/04` (quality bar) ·
  `docs/05` (dev workflow + test tiers) · `docs/06`–`08` (autonomous protocol, LLM
  note contract, loop pattern) · `docs/procgen-design.md` (D1–D6 determinism doctrine
  + the city-pipeline design rationale, merged from the old procgen design docs).
- `plans/README.md` + `plans/NNN-*.md` — the plan ledger; 020 defined the current
  architecture; 029/030 the versioned-determinism + rearchitecture arc.
- `PROGRESS.md`, `DECISIONS.md` — live state; read before resuming autonomous work.
