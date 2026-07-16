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
*Deleting `.mapcache/` is harmless for every region at its algorithm's current
version — byte-identical regeneration, per machine; if it isn't, determinism broke
and that's a release blocker. Regions pinned to older versions need explicit adoption
before they can re-render (§5) — visible badge, never silently different bytes.*

`FabricFeature` (`model/fabric.ts`): `{ id, geometry: LineString|Polygon, properties:
{ kind, name?, procgen? } }`. The optional **procgen block** is what turns a shape into
a generation request:

```ts
procgen: {
  algorithm: string,   // registry id: "city" | "river" | "forest" | "park" | "wall" | "farmland" | "mountain"
  seed: number,        // hashSeed(campaignSeed, featureId) — persisted AT CREATION, never re-derived
  version: number,     // pinned generator contract version (see §5 — adoption raises it)
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

## 5. Determinism (versioned — the consent contract)

**Within an algorithm version**: same `(seed, params, region, constraints)` ⇒ same
bytes, forever, on the same machine — the whole cache design depends on it.
**Between versions**: generator authors are free. A change that alters output bytes
for the same inputs bumps the algorithm's `currentVersion` (registry) and re-goldens
(`npm run goldens:accept -- <algorithm>`); prefer an additive param when its absence
naturally reproduces old behavior (a preference, not a law). Regions pin
`procgen.version` at creation; a pinned-old region renders its cached bytes untouched,
and **only explicit GM adoption raises the pin** (edit prompt / panel Adopt / the
adopt-all command). A pinned-old region with no cache renders nothing plus a
needs-adoption badge — never silently different bytes. No per-version generator code
forks, ever: old bytes survive via cache + consent (`MapController`'s adoption
section; `scripts/gates/version29.ts`).

The within-version discipline is codified as **D1–D6** (`docs/procgen-design.md`,
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
| mountain | polygon | 0 elevation | elevation ← ∅ | `gen/mountain.ts` (massif, hachures, peaks). Contours are NOT a mountain feature — iso-lines trace the campaign-wide composed terrain field as a global viewport-keyed surface (`gen/fields/terrainContours.ts` → the `terrain-contour` paint role), rendering everywhere the field has relief (Jonah 2026-07-15) |
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
  combinators, metaballs, **marching squares** (shared iso-line machinery: global
  terrain contours, forest canopy), smoothing, analytic-derivative fBm elevation
  (`elevation.ts`), mountain height field, viewport-keyed global contour leaves of
  the composed terrain field (`terrainContours.ts`), and DEM lattice/terrarium packing
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
  per-tile world generators, whole-region procgen (`{ algorithmId, seed, ring,
  params, constraints }` — the worker rebuilds the region and consults the same
  registry), and per-tile terrain SAMPLING (`dem-tile` lattice fill + `contour-leaf`
  extraction, carrying plain-data terrain inputs — the worker rebuilds the same
  composed `terrainAt` field, so a cold DEM/contour fill never stalls the renderer;
  Jonah 2026-07-15). Main-thread fallback preserved everywhere (byte-identical).
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

- **Left-click a pin → nothing** (amended, Jonah 2026-07-15 — "it pops up a little menu …
  annoying as hell"). The place card is retired from left-click; a bare left-click on a
  location pin is a deliberate no-op (the hover tooltip already shows the name). Every
  action it used to offer now lives on the **right-click** Menu — that is the one place
  location UI opens. The note *preview* was display-only, not an action, and is dropped.
- **Click empty map → dropped pin** + one primary action **"+ Add location here"** →
  quick-add modal (name + type) → note created, pin becomes real. This IS the ≤5 s
  yes-and flow. Esc/click-away dismisses.
- **Right-click → native Obsidian `Menu`**: on a location pin: Open note (adjacent pane) ·
  Center · Connect to… · Visibility (wide/mid/close); then Add location here · Copy
  coordinates · Generate surroundings; on a sketch feature: Edit shape / region settings.
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
- **Generated paint is contract-driven.** Each algorithm declares a
  `styleContract: BucketStyle[]` (`gen/procgen/styleContract.ts` — pure, next to the
  registry): `{ gid, mark: fill|line|point|fill+outline, role: SemanticRole,
  widthFromProp?, dashed?, z }`. The 14-role vocabulary (water, water-body,
  water-edge, ground, vegetation, vegetation-deep, cultivated, built, built-accent,
  route, boundary, path-casing, relief, accent) maps per-theme to concrete values in
  `map/themes/roleColors.ts`; ONE generic builder (`map/themes/generatedBuilder.ts`)
  turns contract × role-map into MapLibre layers in contract z-order. One manifest,
  three consumers: `tileGeneratorIds` derives from the contract, paint derives from
  it, and a unit test asserts every gid a generator can emit appears in it (the
  silent-drop trap is structurally dead). Adding a bucket = one contract entry; zero
  per-theme work. `map/themes/styleGolden.test.ts` byte-pins every theme's built
  style.
- **Other layer builders** (`map/themes/*.ts`) — canon pins/labels, basemap, fabric
  (sketch), connections, session paths, hillshade.
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
| **T1** | per-phase commit | T0 + `npm run build` + `npm run perceptual` + that phase's own live gate standalone (+ `npm run test:fuzz` iff generator behavior changed) |
| **T2** | diagnostic | `npm run gates:changed` (diff-scoped gate selection via `scripts/gates/coverage.json`) |
| **T3** | **once per plan**, at its final phase | `npm run board` — prologue (unit/fuzz/tsc/build) + the **5-gate smoke set** (smokeBoot · phase1 · smokeProcgen · version29 · phase5) in one Obsidian process with health probes (~5 min; `scripts/board.ts`) |

Hard rules: the board is never run per phase or to chase flakes — a gate that fails
in-board but passes standalone is an environment flake: log it, count it green.
Fuzz/stress tests live in `*.fuzz.test.ts` (separate Vitest config). Live gates are
`scripts/gates/*.ts`, driven through the official Obsidian CLI against `dev-vault/`
(**never** Jonah's real vault; note `dev-vault/Campaigns/Vespergate` holds his real
campaign data — fixtures must be name-tagged, self-cleaning, and leave those files
byte-intact). Every RETIRED live gate has a prove-by-breaking record in
`review/030B-break-proofs.md`; its coverage lives headless (generator suites +
`gen/testkit/invariants.ts` + metric bands + perceptual goldens + styleGolden).

**Headless nets:** `npm run perceptual` renders 8 pinned (algorithm, preset, seed,
region) tuples through a pure-TS rasterizer and pixel-diffs against approved goldens
in `shots/perceptual/` (re-accept with `--accept` + an eyeball, alongside a version
bump). `src/map/themes/styleGolden.test.ts` byte-pins each theme's built style JSON.

**Generator work starts in the playground** (`npm run playground` →
http://localhost:8734; `playground/`): a standalone browser harness that imports
`src/gen` directly — live zod-derived param knobs, seed scrubbing, a preset grid, and
region/spine shape variants, with no build/reload cycle. It renders the style
contract's roles with flat colors — geometry/composition judgment only; theme paint
and host integration still go through the Obsidian loop.

The live inner loop (host/theme/integration): `npm run build` → `obsidian
plugin:reload id=campaign-map` (never `plugin:enable` — silent no-op) → drive via
`eval`/`command` → `obsidian dev:errors` must be clean → `obsidian dev:screenshot` and
**actually view the png** (the docs/04 screenshot test: no label collisions, no seams,
no voids, no default fonts, genre identifiable in 3 s). Full pitfall list: docs/05
§Hard-won pitfalls.

State files for multi-session/autonomous work: `PROGRESS.md` (log), `DECISIONS.md`
(rulings + rationale), `plans/NNN-*.md`
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
src/controller/** ──► model + gen (host behind 8 interfaces)             PURE BRAIN
src/map/**  ──► MapLibre + Obsidian App                                  RENDERER-COUPLED
src/view/** + main.ts ──► Obsidian + MapLibre + controller               HOST SHELL
src/vault/** ──► Obsidian App                                            HOST IO
```

**What ports unchanged (the asset):** all of `src/gen/` (~half the codebase — citynet,
rivers, forests, parks, walls, farmland, mountains, fields, world tier, naming, sigils,
clip/rng/spatialHash), the zod data model, and `MapController` + `FakeHost`. These have
zero DOM/MapLibre/Obsidian imports, are plain TS, and carry the entire determinism
contract. Any new host reimplements the eight gateway interfaces and keeps the brain.

**The renderer contract** (what a Three.js/WebGL or Godot map must re-provide):
GeoJSON feature sources (`canon`, `generated`, `fabric`, `connections`,
`session-path`) + generated paint interpreted from the **style contract** (the pure
`gen/procgen/styleContract.ts` manifest ports with the generators; a new renderer
re-implements only the role→value maps and one contract interpreter — the playground's
canvas interpreter is a working ~100-line existence proof) + the `layerOrder.ts`
z-invariant + label collision/priority handling (currently free from MapLibre's
symbol placement — the single biggest thing to replace) + the fictional-CRS trick
(which only exists *because* MapLibre assumes Mercator; a bespoke renderer can use
gen-space meters directly and delete `fictionalCRS.ts`). PMTiles basemaps and
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
mitigated by the board's health probes; root-cause work tracked in plan 021) — the
2026-07-15 terrain sessions found one concrete cause and fixed it (the `dem.jsonl`
whole-file re-parse per tile request; §13 hazard H1).

**For the per-GM-action event cascade — what each thing a GM does triggers, in what
order, on which thread, and the hazards each path has hit — see §13.** That section is
the authoritative reference for anyone doing performance work; this section is the
one-paragraph model.

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
   features, never styles — paint comes only from the style contract × theme role
   maps. — *enforced:* headless Vitest runs (an Obsidian import would fail to
   resolve); `styleContract.test.ts` + `generatedBuilder.test.ts`.
10. Params are the whole truth; presets/`presetId` are display sugar a generator never
    reads. — *enforced:* `gen/procgen/registry.test.ts` preset/params contract.
11. Every emitted generator-id must be in the algorithm's style contract —
    `tileGeneratorIds` derives from it, so an uncached/unpainted gid is structurally
    impossible. — *enforced:* `styleContract.test.ts` (emitted gids ⊆ contract across
    every preset of every algorithm).
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

## 13. GM action → event cascade (the performance reference)

This is the authoritative map of **what each GM action triggers**: its debounces, its
synchronous main-thread work, the worker jobs it posts (and at what priority), the
caches it reads and writes, the staged repaints it emits, the derived-surface refreshes
it fans out to (DEM digest, contour leaves, region labels, underlay), and the
hazards/races each path has actually hit (fixed ones cite their commit). Written for the
agent tuning performance — read it before touching any of the terrain, worker, cache, or
repaint paths. Where behaviour and this section disagree, the code wins; file:line
anchors name the owner.

**The moving parts, once.** Four independent debounce timers live on the *view*
(`MapView`), armed via the controller's render sink so the pure controller owns no
`window`: **preview** 250 ms (`sketchPreviewTimer`, MapView:1907), **sketch-regen flush**
400 ms (`armSketchRegen`, MapView:2293), **external-fabric reload** 500 ms
(`armFabricReload`, MapView:2304), plus MapLibre's own `moveend` → contour refresh
(MapView:852). One **generation worker** (single-threaded, `maxInFlight = 1`) serves a
**priority queue** (`workerClient.ts`): `procgen-region` = 0 (a GM edit — preempts the
backlog) > `dem-tile` / world-tile = 1 > `contour-leaf` = 2, FIFO within a priority. One
**persistent cache view** per campaign open (`sessionCache`, read from disk once, mutated
through `.set`/`.delete` — MapController:450) backs the vector `generated.jsonl`; a
**separate** `dem.jsonl` view (WeakMap-per-`App`, `demCache.ts`) backs the DEM lattice.
Repaints **coalesce per touched stage** inside `withRepaintBatch` (MapController:429),
upstream stage first. Every terrain-affecting mutation converges on **one** DEM+contour
refresh via the digest chokepoint (`terrainRefresh.ts`, wired into both `repaintGenerated`
and `repaintFabric`, MapView:328/334). The composed-elevation **digest** (`elevationDigest`,
MapController:3044) is the single "did the surface move?" signal — a pure fold over every
terrain-affecting input, id-sorted; it excludes generator-version pins (the field is
version-independent) so a pure city repaint or a version-only adopt is a no-op.

Two `stage` numbers exist for a region and must not be confused: the **static**
`algorithm.stage` (registry) and the **params-aware** `dagRoleFor(algorithm, params).stage`
(e.g. an `urban-park` re-homes 2→4). Repaint/unpaint must always target the params-aware
stage the region was *actually painted at* (`regionPaintedStage`), or a staged `updateData`
diff drops the wrong stage and fabric ghosts (fixed `4705e84`/`0579d4c`; MapController:418,
1936).

### 13.1 Open a campaign / switch campaigns
`setCampaign` (MapView:391) → `beginCampaign` (drops prior render store/manifest/fabric on
a genuine switch) → `terrainRefresh.seedBaseline()` (baseline the digest so the *first*
real mutation triggers, not the initial consistent paint) → `loadFabric` (one disk read,
zod-validated; invalid features → badge, never dropped) → on switch, `terrainToggle.reset()`
+ `terrainContourManager.reset()` (terrain is per-session, never carried) → `setStyle` on
first-apply / theme / underlay change → `replayGeneratedManifest`.

- **Replay pass** (`replayGeneratedManifest`, MapController:2180; once per campaign id):
  world-tier entries hydrate from cache or deterministically regenerate; region tier runs
  through the **one** `runForwardPass` shared with every live trigger. One fingerprint pass
  classifies each region against its cached network record: **fresh / pinned-old** → hydrate
  (cache-hit clip or pinned-old serve-or-badge, **zero** generator runs), **record missing**
  → protected root (always regenerates — deleting `.mapcache/` must stay harmless),
  **fp-stale with cache** → *deferrable* root (no GM edit behind it, so the **cost cap** may
  hold it: serve stale bytes + outdated badge instead of a recompute storm). Replay is
  `quiet` (no cascade toast) and `hydrateDeferred` (paints held regions from stale cache).
- **DEM provider registration** happens inside `buildStyle` for fictional campaigns
  (`registerDemProviderFor`, MapView:663/679) — the provider closes over
  `campaignElevationSnapshot`, re-read live per tile request, so no tile is stale after a
  later edit. Registration also builds the `TerrainContourManager`.
- **Cost cap**: Σ `costClass` over the billed (fp-stale, non-root) set; budget **24** (city
  = 4 expensive; river/park/wall/farmland = 2 medium; mountain/forest = 1 cheap). Over
  budget → roots only regenerate, the rest defer to `pendingPass` + "Apply pending cascade".
- **Cold tile fill**: no generation on open beyond replay; the map's first paint requests
  DEM + contour tiles on the initial camera, which stream in through the worker queue
  (§13.2). `generatorRunCount` never moves for tile fills — they are field evaluation.
- **Hazards**: campaign-switched-mid-load / mid-replay is guarded everywhere by an
  `if (this.campaign?.id !== campaign.id) return` re-check after every await. `manifestReplayedFor`
  makes replay idempotent per campaign.

### 13.2 Pan / zoom (2D, and with 3D on)
Pure viewport motion. **No procgen, ever** (invariant #4 — `generatorRunCount` stays flat).

- **Tile requests**: MapLibre requests `campaigndem://…/{z}/{x}/{y}` for the hillshade
  raster-DEM source (and the 3D mesh reads the same tiles) as the camera enters new tiles.
  Each request → `resolveTilePng` (`campaignDemProtocol.ts`): per-tile **digest** check
  against the `dem.jsonl` view (in-memory, O(1)); a hit with a matching digest+res+K serves
  the cached int lattice; a **PNG-byte LRU** (512 entries, keyed `campaign:key:digest`)
  makes a revisit a pure serve (no lattice recompute, no re-encode). A miss → in-flight
  **dedupe** map → worker `dem-tile` job (priority 1) with an 8 s timeout → main-thread
  `demTileLattice` fallback (byte-identical). The RGBA fill + PNG encode run behind a
  **concurrency semaphore** (`MAX_CONCURRENT_ENCODES = 3`) so a cold burst spreads across
  event-loop turns instead of starving one frame. Abort: a camera move rejects the handler
  with `AbortError` (MapLibre unloads the tile *retryable*), while the shared compute lives
  on to warm the cache.
- **Contour leaf recompute on settle**: `moveend` → `refreshTerrainContours` →
  `TerrainContourManager.update` (MapView:852, terrainContourManager.ts). It picks a
  world-aligned tile-span LOD (`TILES_ACROSS = 6`), traces only newly-seen leaves
  **lazily** in the worker (`contour-leaf`, priority 2) with an LRU (256 leaves) and a
  main-thread fallback, and `setData`s the union (capped `MAX_TILES_PER_UPDATE = 96`). The
  interval keys on the campaign's relief **range** (memoized per digest, never the
  viewport) so a pan never re-intervals; a stale `runId` drops a superseded paint.
- **Retention caches**: 512 decoded DEM tiles + the PNG LRU keep "once 3D, stays 3D" —
  revisits don't rebuild the mesh (`9f09160`).
- **3D on** adds nothing to the *request* path — the mesh consumes the same DEM tiles; a
  cold camera move that must fill 9 tiles went ≈4.4 s → ≈1 s after the 3D package
  (worker fill + retention + res 128).
- **Hazards**: a non-abort rejection used to *permanently* error a tile ("doesn't
  reappear") — fixed by always-retryable tiles + timeout fallback (`f5a942d`). Per-tile
  digests (not the campaign-wide digest) keep a pan from re-deriving untouched tiles
  (`a246459`).

### 13.3 Toggle 3D / relief
`TerrainToggle.setEnabled` (`terrainToggle.ts`) — **visibility + mesh only, never
generation**. Enable: re-point the provider (idempotent), then bust the retained DEM tiles
**only if** the elevation digest moved while terrain was off (`demTilesDigest` compare) —
otherwise reuse the decoded tiles + PNG memo (a plain on/off/on is a pure re-show). Relief
is **pitch-adaptive**: top-down → 2D hillshade, pitched → 3D mesh (never both — maplibre
4.7.1 smears a draped hillshade over an active mesh). `setMesh` may throw when the DEM
source isn't loaded yet → a bounded one-shot source-ready retry (≤5), so terrain reliably
"comes back".

- **Hazards fixed**: the unconditional `setTiles` on every enable (full viewport
  refetch+decode+mesh-rebuild) was the "massive hit"; the swallowed-throw-never-retry was
  the "sometimes doesn't come back". `markDemTilesFresh` keeps the toggle's retained-tile
  digest in lockstep with the render-chokepoint bust so the two never double-bust.

### 13.4 Draw a new shape → procgen offer → attach
`addSketchedFeature` (MapController:2475): stash → `repaintFabric` → fire-and-forget
`persistFabric("sketch-add")` (**self-write #1** to `Fabric.geojson`) →
`queueConstraintRegen` (arms the 400 ms flush). If the GM accepts the procgen offer,
`attachProcgenAndGenerate` → `setRegionProcgen` (MapController:1859): attach the block →
`saveFabric` (**self-write #2**) → `repaintFabric` → log `sketch-procgen-set` → **one**
`runForwardPass` with the region as root.

- **The self-write vs. reconcile-watcher race** (`73853a0`): both persists fire the vault
  `modify` event, which arms the 500 ms external-fabric reload (§13.8). That reload's disk
  read can be *in flight* across the second self-write, so it reads an **older** snapshot
  (before the procgen block was attached). Adopting it would revert the just-attached block
  — the region falls back to a plain sketch, its freshly generated tiles orphan
  (bucketed to `WORLD_STAGE`, dropped from the staged repaint), and it never paints. The
  guard: a **compare-and-swap** in `reloadFabricFromDisk` (MapController:2353) — if the
  in-memory `fabricCollection !== baseline` snapshot taken before the read, bail and re-arm
  (the self-write already armed a follow-up reload that reconciles against consistent
  bytes). Plus the normalize-through-schema self-write guard (MapController:2370) that
  byte-compares the reparsed disk collection against the in-memory one so an ordinary
  self-write is a no-op reload.
- **Worker jobs**: the region job runs at priority 0, preempting any DEM/contour backlog at
  the next job boundary (`e43e7b2` — "after drawing a river I can't see it" was the river
  waiting FIFO behind a cold tile backlog).
- **Terrain stamps** (relief/landform/mountain): the attach's `repaintFabric`/`repaintGenerated`
  moves the elevation digest → the chokepoint busts DEM + refreshes contours automatically
  (§13.10), no per-kind wiring.

### 13.5 Edit params via panel / preset change
`setRegionParams` (MapController:2735) / `setRegionPreset` (2755) → **consent gate**
(a pinned-old region needs adoption first; decline cancels the edit) → zod-validate params
→ `setRegionProcgen` → `saveFabric` + log → **one** `runForwardPass` rooted at the region
(root recomputes unconditionally; transitive downstream regenerates in one `(stage, id)`
walk, fp-inert dependents skip). Staged repaints coalesce per touched stage. A property-only
change (name) short-circuits with no regen (MapController:2704).

### 13.6 Drag: vertex / extrude-height / band / depth / center handles
The per-frame vs. on-release split is the whole performance story of dragging.

- **Vertex / midpoint drag** → `onGeometryPreview` (MapView:1902): a **250 ms trailing**
  debounce paints **only the root region** via `previewRegionGeometry` (MapController:2512)
  — ephemeral render state, **no cache append, no fingerprint, no downstream, no log**. On
  **release** → `onGeometryEdit` cancels the preview timer and runs `commitGeometryEdit`
  with `{ debounce: true }` → the 400 ms flush → **one** full `runForwardPass` (root +
  transitive downstream). A pinned-old region previews nothing (consent belongs to the
  commit path).
- **Extrude-height grip** (relief/landform): a **screen-space DOM overlay** grip
  (`9c40c9e` — vertical at any pitch). Per frame → `onHeightDrag` shows only a ±m readout
  (**no regen**). Release → `onHeightCommit` (MapView:1872) maps the signed value to params
  and runs the normal `setRegionParams` path (validate/log/cascade, one commit —
  undo/cascade-free during the drag).
- **Band grips** (halfWidth/apron/band) → per frame `onBandDrag` re-offsets the ghost
  outline in the controller + readout (no regen); release → `onBandCommit` → `setRegionParams`.
- **Depth grips** (per river-spine vertex) → per frame `onDepthDrag` readout; release →
  `onDepthCommit` merges the monotone-clamped depths array → `setRegionParams`. (Downhill is
  structural: cumulative-min bed source→mouth.)
- **Center handle** → `onCenterEdit` → `setRegionCenter` (MapController:3079): validated
  inside the ring (else "using automatic center"), then the `setRegionProcgen` commit path.
- **Rule**: every grip does **readout-only per frame** and **one validated commit on
  release**. Only vertex drag paints a live preview (root-only, throwaway bytes).

### 13.7 Delete / clear-generated / re-roll / undo
All converge on the same drop + forward-pass chokepoints.

- **Delete a shape** (`deleteFabricFeature`, MapController:2484): drop from collection →
  `selectionInvalidated` → `repaintFabric` → `dropRegionCacheAndUnpaint` (drops the network
  record + every per-tile clip key + render-store tiles, repaints the region's **params-aware**
  stage, `4705e84`) → `persistFabric("sketch-remove")` → `queueConstraintRegen` (the
  removed feature still dirties its footprint downstream). A terrain stamp delete moves the
  digest → the chokepoint flips the 3D area back to 2D immediately (`21a46d2` — the "takes a
  long time to go back to 2D" fix; previously delete didn't route through
  `refreshTerrainIfEnabled`).
- **Clear-generated** (`stripRegionProcgen` / `removeGeneratedCityHere`): `dropRegionCacheAndUnpaint`
  then strip the block — the shape stays, the fabric is gone.
- **Re-roll** (`rerollRegion`, MapController:2769): consent gate → new seed
  (`hashSeed(seed,"reroll")`) → `setRegionProcgen` → forward pass. Vertex edits keep the
  seed; only re-roll replaces it (invariant #7).
- **Undo** (`undoLastEdit`/`undoInSketchMode`): reverses the last log entry; a procgen
  region touched by the undo goes through `dropRegionCacheAndUnpaint` before re-running the
  pass. Because delete/create/undo/adopt all land on `repaintFabric`/`repaintGenerated`, the
  terrain chokepoint covers them with no per-path enumeration.
- **Stage-migration double-repaint**: when a region's params-aware stage changed since its
  last paint, `repaintRegionStage` repaints **both** the old and new stage so the old
  stage's diff drops the migrated ids (`0579d4c`).

### 13.8 External `Fabric.geojson` edit (sync / script / hand-edit)
`noteExternalFabricChange` → `armFabricReload` (500 ms coalescing — longer than the
sketch-regen timer so a multi-file sync settles) → `reloadFabricFromDisk`
(MapController:2329). Re-read at the zod boundary; **self-write guard** normalizes both
sides through `FabricCollectionSchema` and byte-compares (a self-write or byte-identical
external write ⇒ no reload); **compare-and-swap** guards the create-path race (§13.4);
**malformed** (bad JSON / all features invalid) → badge + **retain** the last good fabric
(never blank on a truncated mid-sync file). Otherwise diff before/after: deleted regions
drop-and-unpaint + ride along as sources; changed/new regions become forward-pass roots;
raw sketch changes become sources → **one** `runForwardPass`. The terrain chokepoint picks
up any stamp change off the repaint signal (`5de4c69`). Note: this exists *because*
`loadFabric` early-returns for an already-loaded campaign (Cradle learning — external edits
were invisible until campaign switch/reload).

### 13.9 Adopt / apply-pending-cascade / cost-cap decline
- **Adopt a pinned-old region** (`adoptRegion` / `adoptAllRegions`, MapController:1798/1816):
  raises the version pin to `currentVersion` and regenerates at the new contract — the
  *only* thing that raises a pin (a plugin update never silently changes an existing
  region). Adoption is version-only; it does **not** move the elevation digest (which
  excludes version pins), so it never busts DEM/contours.
- **Apply-pending-cascade** (`applyPendingCascade`, MapController:1496): re-runs the exact
  deferred pass (same roots + sketch edits) **uncapped** — deterministic, so byte-identical
  to an undeferred pass. Clears the outdated badges.
- **Cost-cap decline**: the pass regenerated only the protected roots, deferred the billed
  set to `pendingPass`, marked them `outdatedRegions` (badge), and toasted. Deferred records
  stay fp-stale and serve-with-badge until Apply.

### 13.10 Base-terrain Apply / underlay / theme switch
- **Base-terrain Apply** (036-D campAmp/seaDatum/grade): flows through `setCampaign` with a
  `terrainBaseChanged` diff (MapView:399); no `setStyle` rebuild for a terrain-only change,
  so `refreshTerrainIfEnabled` → `terrainRefresh.refreshNow()` explicitly re-registers the
  provider + busts the DEM tile cache + refreshes contours. Moving campAmp>0 adds ~5-octave
  base fBm to every DEM tile (~300 ms/tile one-time, dev machine).
- **Underlay change** (plan 041 reference image: attach / move corners / opacity /
  visibility) → spliced into the style at build time → rides the same `setStyle` rebuild as
  a theme/basemap change (rare, explicit; reuses the asserted `layerOrder` z-stack).
- **Theme switch / css-change** → `setStyle` **wipes every source** and rebuilds paint from
  the theme's role map. After `styledata`: re-register glyphs, `refreshSource` +
  `refreshGeneratedSource` (re-push the render store into the empty baked sources),
  `applyFocusReveal`, re-apply the terrain toggle (setStyle rebuilds hillshade default-hidden
  and drops the mesh), repopulate the emptied `terrain-contour` source. `setStyle` is the
  heaviest single host op — a full style rebuild + every source re-`setData` — reserved for
  genuine theme/basemap/underlay/css changes, never a routine edit.

### 13.11 Performance ground truth (measured 2026-07-15; **dev-machine numbers — Surface Pro is the budget**)

| quantity | measured | source / commit |
|---|---|---|
| DEM tile, 256² res, river campaign | ≈961 ms; **river carve = 79%** of it | afternoon session; carve reject `6b032e2` |
| River carve, one meander tile | 2065 → **453 ms** after occupancy-grid far-field reject (byte-proven) | `6b032e2` |
| Far-field DEM stall (relief+landform, 4 rivers) | >120 s/tile → ~300 ms after byte-exact bbox reject | `7fa7ea4`, `f215840` |
| `DEM_TILE_RES` 256 → 128 | ~**3.8×** fewer samples/tile (one-line revert if hillshade reads soft) | `0ee8a41` |
| Residual base fBm (campAmp>0), per tile | ~300 ms one-time (5-octave) | afternoon session |
| **`dem.jsonl` whole-file re-parse per request** (the "slow even when nothing generates" smoking gun) | 91 ms → **2+ s** as the append-only log grows; fixed to **1 read/session** (persistent view + compact-on-load) | `d1ddd15` |
| Fingerprint hasher (two-lane 32-bit) | 56 → **975 MB/s** (17.3×) | plan 033, `fp1→fp3` |
| Cold 9-tile camera move (3D) | ≈4.4 s → **≈1 s** | 3D package (`f5a942d`+`a246459`+`9f09160`) |
| PNG-byte LRU / decoded-tile retention | 512 / 512 entries | `campaignDemProtocol.ts`, `9f09160` |
| Encode concurrency semaphore | 3 concurrent | `campaignDemProtocol.ts` |
| Worker DEM timeout → main-thread fallback | 8000 ms | `campaignDemProtocol.ts` |
| Cost-cap budget / weights | 24 / cheap 1, medium 2, expensive 4 (city) | MapController:1220 |
| Cache-cost win (per-region shards) | fixture city 55 tile records → 1 network shard (~721 KB); ~170 MB/17 regions was the clip-record bulk | plan 032 |
| Contour per-settle cap / leaf LRU | `MAX_TILES_PER_UPDATE` 96 / 256 leaves | terrainContourManager.ts |

Disproven-in-passing (don't re-chase): field-rebuild-per-job (~1%), payload clone (~0.1 ms).

### 13.12 Hazard patterns (each with its precedent fix)

- **H1 — async read straddling a write.** An awaited read (disk, worker) can span a
  concurrent mutation and then clobber it. *Precedents*: the DEM whole-file re-parse
  (`d1ddd15` — read once into a session view); the reconcile disk read straddling the
  procgen self-write (`73853a0` — compare-and-swap on the pre-read baseline). *Rule*: snapshot
  the pre-read state and bail-or-merge if it changed; re-check `campaign?.id` after every await.
- **H2 — unconditional cache busts.** Busting a cache when the inputs didn't move pays a
  full refetch/decode/rebuild for nothing. *Precedents*: the 3D toggle's unconditional
  `setTiles` (`terrainToggle.ts` — bust only on a digest move); the terrain-refresh
  chokepoint firing only when `elevationDigest` actually changed (`terrainRefresh.ts`).
  *Rule*: gate every bust behind a digest/fingerprint compare; keep the "what the retained
  tiles reflect" digest in lockstep across all bust paths (`markDemTilesFresh`).
- **H3 — per-frame heavy work during a drag.** Regenerating downstream on every mouse move
  storms the worker and the cache. *Precedent*: preview mode (root-only, ephemeral, 250 ms
  debounce) + all grips readout-only per frame, one commit on release (plan 034-D, MapView
  drag handlers). *Rule*: per frame = cheap render/readout; commit = one debounced pass.
- **H4 — units / frame mismatch.** Sampling one field in gen-space meters and another in
  display units, or reading the static stage where the params-aware stage is meant.
  *Precedents*: contour leaves are traced in meters and converted `meters/scale` to display —
  the exact inverse of `demTileLattice`'s `lng·scale` sampling (terrainContourManager.ts);
  the params-aware-vs-static stage bug that ghosted deleted fabric (`4705e84`). *Rule*:
  name the space at every boundary; the one sanctioned stage read is `dagRoleFor`.
- **H5 — priority inversion on the single worker.** Cheap background jobs (contour leaves,
  a cold DEM backlog) running ahead of the thing the GM is waiting for. *Precedent*: the
  region-0 > tile-1 > contour-2 priority queue with `maxInFlight = 1` (`e43e7b2`,
  workerClient.ts). *Rule*: a direct GM request preempts background fills at the next job
  boundary.
- **H6 — poisoned in-flight / errored-tile entries.** A failed shared compute that never
  clears its in-flight entry, or a rejected handler that marks a MapLibre tile permanently
  `errored` (never re-requested). *Precedents*: the in-flight dedupe map cleared in a
  `finally`; always-retryable tiles + abort-as-unload (`f5a942d`). *Rule*: clear shared
  state in `finally`; a transient failure must leave the tile retryable.

---

## 14. Where to read more

- `docs/01` (research) · `docs/03` (roadmap, historical) · `docs/04` (quality bar) ·
  `docs/05` (dev workflow + test tiers) · `docs/06`–`08` (autonomous protocol, LLM
  note contract, loop pattern) · `docs/procgen-design.md` (D1–D6 determinism doctrine
  + the city-pipeline design rationale, merged from the old procgen design docs).
- `plans/README.md` + `plans/NNN-*.md` — the plan ledger; 020 defined the current
  architecture; 029/030 the versioned-determinism + rearchitecture arc.
- `PROGRESS.md`, `DECISIONS.md` — live state; read before resuming autonomous work.
