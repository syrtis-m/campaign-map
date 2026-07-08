# SOTA Research: Map Generation for Tabletop Campaigns

*Researched July 2026. Audience: Jonah + coding agents building this project.*

## The one-line conclusion

Nothing on the market combines (a) Google-Maps-style continuous zoom, (b) procedural generation across genres, and (c) "yes-and" live editing during play. The pieces all exist as open source; the product doesn't. That's the gap this project fills.

## 1. Procedural generation: what's state of the art

### World/region scale
- **[Azgaar's Fantasy Map Generator](https://github.com/Azgaar/Fantasy-Map-Generator)** (MIT, actively developed, v1.124+) is the reference implementation for world-scale generation: Voronoi-cell heightmaps → biomes → cultures → states → burgs → routes. Browser-based, vanilla JS migrating to TypeScript. Architecture is cleanly layered (state / generators / editors / renderers) — see the [DeepWiki breakdown](https://deepwiki.com/Azgaar/Fantasy-Map-Generator). **Steal the pipeline design, not the code** (it's D3/SVG-rendered and monolithic).
- Core algorithm stack: Poisson-disc points → Delaunay/Voronoi (`d3-delaunay` is the modern lib) → heightmap templates → moisture/temperature → biome assignment → settlement scoring → route pathfinding (A* over cell graph).

### City/settlement scale
- **[Watabou's Procgen Arcana](https://watabou.github.io/city.html)** (Medieval Fantasy City Generator, Village, One Page Dungeon) sets the bar aesthetically. Closed source (Haxe), but the technique is documented: skeleton road network → Voronoi districts → recursive block subdivision → building footprints. It already integrates with Azgaar (cities generated from Azgaar burg data).
- **Tensor-field street generation** is the SOTA for *realistic* street networks — the [Interactive Procedural Street Modeling](https://peterwonka.net/Publications/pdfs/2007.SG.Esch.InteractiveProceduralStreetModeling.Sketch.pdf) lineage (Chen/Wonka 2008). Grid fields near centers, radial fields around landmarks, trace streamlines along eigenvectors → organic-but-plausible streets. Open web implementations exist: [phiresky/procedural-cities](https://github.com/phiresky/procedural-cities/blob/master/paper.md) (survey + impl), [Jake Lem's WebGL/TypeScript city](https://jakelem.com/code/procedural-city/), and [ProbableTrain/MapGenerator](https://github.com/probabletrain/mapgenerator) (TypeScript, tensor fields per the Wonka paper, exports SVG/PNG/STL, with a written [algorithm overview](https://github.com/ProbableTrain/MapGenerator/blob/master/docs/algorithmoverview.md) — check its license before reusing code; the *technique* is unencumbered). **This is the right technique for the Dishonored-style city**: tensor fields let you art-direct (radial around the clocktower, grid in the industrial quarter) while generating infinite plausible detail.

### District/interior scale
- **Wave Function Collapse (WFC)** remains the go-to for tile-constrained detail (building interiors, dungeon rooms, district texture). Recent work extends it to [3D with non-local constraints](https://diglib.eg.org/bitstream/handle/10.2312/ceig20251107/ceig20251107.pdf) and [growing grids for infinite maps](https://dl.acm.org/doi/10.1145/3402942.3402987). For this project: useful at the deepest zoom levels, not for world/city scale.

### LLM-assisted generation
- The [2024–25 PCG+LLM survey](https://arxiv.org/pdf/2410.15644) covers the emerging pattern: LLM generates *semantic* content (names, descriptions, faction relationships, "what's in this district"), classical PCG generates *geometry*. This division of labor is exactly right for a yes-and tool — Claude can name and describe a district; tensor fields draw its streets. Design the feature schema so an LLM can emit valid features (plain JSON), making "generate 5 shops along this street" a Claude Code / API call later.

## 2. Rendering & the Google-Maps-clone problem

- **[MapLibre GL JS](https://maplibre.org/projects/gl-js/)** (BSD, the open Mapbox fork) is the clear choice: WebGL vector rendering, 60fps pan/zoom, and — critically — the **MapLibre Style Spec** means per-campaign themes are *data, not code*. Same features, three JSON style files: clean-modern, parchment-fantasy, ink-and-soot.
- **Fictional worlds on a real-map engine**: MapLibre assumes Web Mercator. The standard trick (proven by [fantasy Leaflet maps](https://github.com/manianiac/fantasy-leaflet-map) and Leaflet's [CRS.Simple pattern](https://leafletjs.com/examples/crs-simple/crs-simple.html)) is to treat fictional coordinates as fake lng/lat within a bounded region. Works fine as long as you never mix fictional and real data in one map. Distance calc = one scale-factor constant per campaign.
- **maplibre-agent-skills**: MapLibre publishes [agent skills for Claude-style coding agents](https://github.com/maplibre/maplibre-agent-skills) including [PMTiles patterns](https://github.com/maplibre/maplibre-agent-skills/blob/main/skills/maplibre-pmtiles-patterns/SKILL.md). Install these in the repo when building.

## 3. Real-city offline data

- **[Protomaps / PMTiles](https://protomaps.com/)**: single-file tile archives, no server. Extract any city from the daily planet build with `pmtiles extract` ([docs](https://docs.protomaps.com/basemaps/downloads), [OSM by the Slice](https://app.protomaps.com/downloads)). A metro extract is tens of MB. Serves straight from static hosting or local file via the [PMTiles protocol for MapLibre](https://docs.protomaps.com/pmtiles/maplibre).
- **Offline storage**: [makinacorpus/maplibre-offline-pmtiles](https://github.com/makinacorpus/maplibre-offline-pmtiles) stores PMTiles in **OPFS** (Origin Private File System — near-native read performance, no memory blowup). Fonts/sprites/glyphs get cached by the PWA service worker ([pattern](https://docs.protomaps.com/pmtiles/maplibre)).

## 4. Persistence & local-first

*(Rev-2 note: the Obsidian pivot mooted most of this — vault files replace browser storage, and Obsidian Sync replaces the durability story. Kept for context and for the web-app escape hatch.)*

- **SQLite WASM + OPFS** was the 2026-consensus browser-local store ([Smashing Magazine overview](https://www.smashingmagazine.com/2026/05/architecture-local-first-web-development/)); browser eviction (Safari's ~7-day IndexedDB wipe) made export a P0 survival feature. Inside Obsidian neither problem exists: canon is markdown notes, generated cache is regenerable files.
- **CRDTs (Yjs)**: still not needed for solo-GM v1 ([consensus](https://rxdb.info/articles/local-first-future.html): only for real-time collab). Event-shaped mutations (the log) keep the door open.

## 4b. Obsidian plugin landscape (added rev 2 — the platform pivot)

- **[obsidian-leaflet](https://github.com/javalent/obsidian-leaflet)** is the incumbent: Leaflet maps in notes, image maps + real tiles, markers linked to notes. Proves the maps-in-Obsidian concept and the note↔marker pattern — but raster/Leaflet (no vector themes, no WebGL perf, no generation).
- **[Leaflet bases](https://community.obsidian.md/plugins/leaflet-bases)** adds a map view to Obsidian Bases with a `marker` property type — evidence Obsidian's newer Bases/property system can carry geodata natively; watch for integration.
- **No MapLibre/vector-tile/generative plugin exists** (as of July 2026). The niche is open.
- Platform facts that matter: custom [`ItemView`](https://docs.obsidian.md/Plugins/User+interface/Views) tabs; desktop = Electron (WebGL fine, Node available), [mobile = Capacitor](https://docs.obsidian.md/Plugins/Getting+started/Mobile+development) (no Node — use Vault/DataAdapter APIs only); esbuild bundling with dev-vault hot-reload workflows.

## 5. Competitive landscape (why build this)

| Tool | Strength | Why it's not this |
|---|---|---|
| [Azgaar FMG](https://azgaar.github.io/Fantasy-Map-Generator/) | Deepest world gen | Fantasy-only, one scale, generate-then-tweak (not yes-and), SVG perf ceiling |
| Watabou | Best-looking cities | Separate generators, no persistence/campaign layer, closed source |
| [LegendKeeper](https://www.legendkeeper.com/) | Wiki + map atlas, real-time collab; 2026 added region drawing + travel-time | Maps are static uploaded images — no generation, no continuous zoom |
| World Anvil | Feature breadth | Same: image pins, not a map engine; online-only |
| Inkarnate / Wonderdraft / Dungeondraft | Beautiful hand-drawn output | Drawing tools, not generators; fixed canvas; not web/offline |
| Dungeon Alchemist | AI-assisted 3D battlemaps | Battlemap scale only, Steam app |
| Foundry VTT | Session play | Battlemap/scene focus, not world cartography |

**The gap**: every existing tool either generates OR persists a campaign world OR does continuous zoom — none do all three, none are yes-and-first, and none handle fantasy + real-city + stylized-city in one engine.

## 6. Key technical risks (flagged for the build plan)

1. **Continuous world→street zoom for fictional worlds** is the hard novel part. Real maps have data at every zoom; fictional worlds must generate it lazily and *deterministically* (seeded per-tile) with GM edits ("canon") overriding procedural output. This "procedural LOD + canon layer" is the core invention. See architecture doc §4.
2. **MapLibre style-spec expressiveness** for hand-drawn looks is limited (no sketchy strokes). Mitigation: lean on texture fills, dashed lines, font choice; accept "stylized vector," not "Inkarnate."
3. **Generation quality**: tensor-field streets and Voronoi worlds are proven, but tuning them to *look good* is craft time. Budget iteration.

## Sources

- https://github.com/Azgaar/Fantasy-Map-Generator · https://deepwiki.com/Azgaar/Fantasy-Map-Generator
- https://watabou.github.io/city.html
- https://peterwonka.net/Publications/pdfs/2007.SG.Esch.InteractiveProceduralStreetModeling.Sketch.pdf
- https://github.com/phiresky/procedural-cities/blob/master/paper.md · https://jakelem.com/code/procedural-city/
- https://diglib.eg.org/bitstream/handle/10.2312/ceig20251107/ceig20251107.pdf · https://dl.acm.org/doi/10.1145/3402942.3402987
- https://arxiv.org/pdf/2410.15644
- https://maplibre.org/projects/gl-js/ · https://github.com/maplibre/maplibre-agent-skills
- https://leafletjs.com/examples/crs-simple/crs-simple.html · https://github.com/manianiac/fantasy-leaflet-map
- https://protomaps.com/ · https://docs.protomaps.com/basemaps/downloads · https://docs.protomaps.com/pmtiles/maplibre
- https://github.com/makinacorpus/maplibre-offline-pmtiles
- https://www.smashingmagazine.com/2026/05/architecture-local-first-web-development/ · https://rxdb.info/articles/local-first-future.html
- https://www.legendkeeper.com/world-anvil-alternative · https://char-gen.com/alternatives/world-anvil
