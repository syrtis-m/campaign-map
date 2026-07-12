# How the procedural generation works (and why)

*A guided tour of the procgen system as of procgen v3 (July 2026). This
explains what each piece does, the reasoning behind the design, and how
everything clicks together — from the moment you click "Generate fabric here"
to the pixels on the map.*

---

## The one-paragraph version

Generation is **pure functions** run only when the GM explicitly asks, keyed
so that every random-looking decision is a hash of *where it is* plus the
campaign seed — never of generation order — and cached against fixed 600 m
tiles. The world tier still generates per tile: `(seed, bbox, constraints) →
Feature[]`. The city tier (procgen v3) generates per **city domain** — a
bounded disc the GM founds with a click — computing the whole street network
once as `(citySeed, domain, constraints) → Feature[]` and letting every
overlapping tile clip its piece from that single deterministic artifact.
Output is disposable cache either way; what persists is the GM's *request* (a
tiny manifest of tiles and domains) and the GM's own hand (locations and
sketches), which feed back into every run as constraints. Delete the cache and
the map regenerates identically. That single property — **determinism anchored
to position** — is what everything else is built around.

---

## 1. The philosophy: three kinds of truth

The map distinguishes three kinds of content, with strictly different
lifetimes (plan 019's "two-layer model" plus the cache underneath):

| | What it is | Where it lives | Lifetime |
|---|---|---|---|
| **Locations** | Note-backed places (the pins) | `Locations/*.md` frontmatter | Permanent, human-owned |
| **Sketched fabric** | Hand-drawn background (roads, walls, rivers, water, districts, parks) | `Fabric.geojson` | Permanent, human-owned |
| **Generated fabric** | Procedural background (streets, districts, blocks, regions, routes) | `.mapcache/generated.jsonl` | **Disposable** — regenerable from inputs |

The asymmetry is the point. Humans own durable things; the generator owns
nothing durable. A generated street is never "kept" — if you want it to
survive, you don't promote it, you just… let it keep regenerating, because
regeneration is deterministic. If you want something *specific*, you sketch
it, and the generator adapts around your sketch. Generators **never overwrite
locations or sketches**; they only receive them as constraints. Content flows
one way: human → generator, never generator → human.

This replaced an earlier "canonize a generated feature into a note" loop,
which was deleted in plan 019 because it blurred the layers: it turned
background texture into first-class places and made the generator a source of
truth. Now there is nothing to promote and nothing to lose.

## 2. Determinism: the sacred invariant

**Same input = same map, forever** (CLAUDE.md locked decision). Concretely:

- **The PRNG** is mulberry32 (`src/gen/rng.ts`), seeded via `hashSeed(...)` —
  an FNV-1a hash over any mix of numbers/strings. There is no `Math.random()`
  anywhere in a generator.
- **Every decision is keyed to position, not order.** A city's seed is
  `hashSeed(campaignSeed, "domain", anchorCellX, anchorCellY)`. A parcel's
  split ratio is `hashSeed(citySeed, blockId, recursionPath)`. Nothing
  depends on "what was generated before this."
- **Cache keys** are `hash(campaignSeed, tileX, tileY, zoom, generatorId)`
  (`src/gen/cache/tileGrid.ts`) — the identity of a tile's content *is* its
  inputs.
- **Canonical output ordering:** every generator sorts its features by
  first-coordinate before returning, so incidental iteration order upstream
  can never leak into the cached bytes. This is what makes "delete
  `.mapcache/`, regenerate, diff" a legitimate release-blocker test — the
  bytes must match.

Why so strict? Because determinism is what lets the cache be *disposable*,
sync be *conflict-free* (regenerable files can simply be excluded from sync),
and seams be *provable* (see §4). The moment one generator consults global
state or ordering, all three guarantees rot silently.

One honest nuance: constraints are inputs too. If you add a location or sketch
a river and then regenerate, you get a *different* (still deterministic) map —
same seed + same constraints = same output. A cache hit deliberately does
**not** re-check constraints; adapting to new constraints is what explicit
*Regenerate* (and the sketch auto-regen, §7) is for.

## 3. The tile grid and the two tiers

Space is carved into fixed **600 m tiles** anchored at the world origin
(`GENERATION_TILE_SIZE`), independent of the campaign's own bounds. Generators
are tuned in meters (street segments ~40–80 m by profile, parcels a few
hundred m², domains 400–1500 m radius), so fictional campaigns convert their
fake units through `scaleMetersPerUnit` at the MapView boundary — generators
never know about display units.

There are two **tiers** of generator, selected by the zoom you're looking at
when you ask (`bandForZoom`, split at z8):

- **world**: `world-region` (Voronoi cells classified into biomes from
  noise-based height/moisture fields — this is where coastlines come from) and
  `world-route` (settlement-to-settlement paths).
- **city** (procgen v3): domain-scoped. Clicking at city tier founds — or
  extends — a **city domain**: a disc (center snapped to a 30 m lattice,
  radius 400–1500 m, one of four profiles: euro-medieval, euro-continental,
  na-grid, na-suburb) recorded in the manifest. One pipeline
  (`src/gen/citynet/`) computes the whole city for the domain; tiles clip
  per-tile records with generator ids `city-street`, `city-block`,
  `city-parcel`, `city-footprint`, `city-landmark`, and `city-district`
  (wards — deliberately reusing the legacy district id so themes' paint
  carries over unchanged).

`world-settlement` still exists in-tree but is deliberately **not** in the
generate set (plan 019, D2): named places are Locations the GM creates — the
generator has no business inventing pins. Its naming machinery survives
because *populate-area* (which creates real notes) shares it.

Both tiers coexist on screen; LOD is handled by layer paint (line-width
interpolation, per-layer minzoom on footprints), not by evicting one tier when
you zoom — a Jonah ruling: zoom-based hiding applies to location *names* only,
never to fabric.

## 4. Seam safety: the hard problem, and the trick that solves it

Tiles generate independently — possibly years apart — yet a street crossing a
tile edge must connect exactly. The classic algorithms (dsep streamline
seeding, Bridson Poisson-disc, MST route networks) are all **order-dependent**:
what exists depends on what was generated first, so two tiles computing
independently diverge at their shared edge. The whole generator suite is built
from order-free substitutes:

1. **Position-hashed seeding** (`spatialHash.ts`): candidate points come from
   a coarse world grid where each cell independently hashes to zero-or-one
   jittered point — a pure function of `(campaignSeed, cellX, cellY, salt)`.
   Not true blue noise, but stratified enough, and immune to seams by
   construction.
2. **Halo generation**: every tile actually computes over `bbox + halo`, then
   clips to `bbox`. The halo is sized so any feature that can poke into the
   tile is fully computed by it — e.g. `STREET_HALO = stepSize × maxSteps`
   covers the longest possible streamline half-length; Voronoi uses an 8×
   cell-size halo so cell shapes near the edge are decided by real neighbor
   sites, not by the halo's own clip rectangle.
3. **Fields, not neighbors**: the street tensor field, the heightmap, and the
   moisture field are pure functions of world coordinates + the campaign's
   *fixed* `worldBounds` (never the tile bbox). Every tile samples the
   identical field. Streamlines are fixed-step RK4 with no collision
   termination — trading some density control for the guarantee that a trace
   is a pure function of its own seed point.
4. **Bit-identical clipping** (`clip.ts`): Liang-Barsky for lines,
   Sutherland-Hodgman for polygons. Two tiles clipping the same pre-clip
   geometry against their shared edge evaluate the same interpolation formula
   on the same vertex pair → the boundary points match to the bit, not just
   "within epsilon."
5. **Local pairwise rules over global ones**: routes connect each settlement
   to its k-nearest neighbors within a max distance — a purely local rule that
   can't diverge across an edge (an MST would be cleaner but is globally
   coupled, exactly the failure class this design exists to avoid).

**The city tier takes the halo argument to its limit** (procgen v3). Growth-
based street generation is inherently *sequential* — priority-queue expansion,
T-junction snapping — which is exactly the order-dependence the rules above
exist to avoid. The resolution isn't order-free math; it's scope: the whole
network is computed **once per domain** as a pure function of `(citySeed,
domain, constraints)`, and every tile that overlaps the domain clips its bbox
from that one artifact. Tile A and tile B don't need to *agree* — they read
the same bytes. In halo terms: the halo became the whole city. Inside the
pipeline, sequential still can't mean sloppy: all topology lives on a 1 cm
integer lattice (exact orientation/intersection tests, no FP epsilons), the
priority queue is totally ordered (`(priority, candidateId)` with hash
tiebreaks — no tie ever resolved by insertion order), and every stage runs on
budgets, never "until it looks done."

The enforcement is the mandatory **2×2 adjacent-tile seam test** (CLAUDE.md):
generate four tiles around a shared corner and assert the edge-touching
geometry matches — including, since plan 019, with sketched water and roads
deliberately crossing the seams, and, since v3, with a domain straddling the
corner.

## 5. The generators themselves, briefly

**The city pipeline** (`src/gen/citynet/`, procgen v3) runs once per domain,
in stages, each stage feeding the next:

- **Skeleton** (`skeleton.ts` + `costField.ts`): radial arterials A*-routed
  from the center to hashed-bearing (or route-hinted) boundary points over a
  10 m cost lattice — slope from `heightAt`, open water impassable, river
  cells expensive (so crossings concentrate into shared **bridges**), canon
  pins penalized. Plus waterfront quays offset from sketched rivers, a
  jittered plaza with landmark footprints (church/market/temple/keep), and —
  profile-gated — the **wall**: a closed ring road through gate points placed
  on each arterial at ring network-distance, with a wall band and gate
  markers.
- **Growth** (`growth.ts` + `graph.ts`): Parish & Müller priority-queue
  street growth on the integer-lattice planar graph, seeded along the
  skeleton. The classic local constraints: snap to nearby node, cut crossings
  into T-junctions, trim to edge interiors, reject slivers. Cityness (§ below)
  modulates branch priority/probability, snap radius, and the growth extent.
  Sketched roads are pre-seeded into the graph as immutable edges — generated
  streets snap *to* them. Profiles flip the signature: euro-medieval grows a
  T-dominated warren with alleys; na-grid snaps directions to hashed
  per-quadrant azimuth pairs and runs *through* crossings (4-way-dominated,
  jogging where quadrants meet, mid-block alleys); na-suburb curves its
  branches and lowers snap probability so unsnapped ends *are* the
  cul-de-sacs, capped with court bulbs.
- **Faces → parcels → footprints** (`faces.ts`, `parcels.ts`): the graph is
  planar by construction, so its bounded faces (half-edge, smallest-left-turn
  traversal, exact integer shoelace) *are* the blocks. Each block is OBB-sliced
  into lots (recursion keyed `hash(citySeed, blockId, path)`); each lot with
  street frontage gets a footprint inset toward — and aligned to — its
  frontage edge. Interior lots stay open as courtyards. Degenerate faces and
  slices are counted and skipped, never thrown (the anti-Watabou rule).
- **Cityness** (`cityness.ts`): radial falloff × seeded noise + hashed bumps
  around the GM's settlement pins — the scalar field the whole pipeline reads
  for density ("the city grows around your pins").
- **Outskirts + wards** (`outskirts.ts`, `wards.ts`): beyond the growth
  extent, cottages ribbon along the arterials and farm-field quads align to
  the road beyond them, then nothing toward the rim (Watabou's rule). Wards
  are a handful of Voronoi cells over plaza/arterial sites, tagged
  market/gate/craft/temple/slum by adjacency and hash.

**The world tier** is untouched by v3:

- **World regions** (`world/regions.ts`): Voronoi cells tagged with a biome
  from `heightAt` (fractal noise + radial falloff toward the campaign center,
  so a campaign defaults to an island/landmass — Azgaar lineage) and
  `moistureAt`. Ocean-vs-land is what draws the coastline.
- **Corridor elaboration** (`city/corridor.ts`): kept from plan 014 — blends a
  drawn polyline into the tensor field as an alignment basis with exponential
  falloff. Plan 019 generalized this blend to *every* sketched road (§7) and
  retired the separate build-from-corridor flow.

**What v3 deleted, what survived (§5.5 of the v3 design):** the per-tile
streamline street "fur", the tile-Voronoi districts, and the bisection blocks
are gone (`city/districts.ts`, `city/blocks.ts`, `generateCityStreets`).
`tensorField.ts` survives as the growth loop's orientation prior,
`streamlines.ts` survives for corridor elaboration, `corridor.ts`,
`fabricConstraints.ts`, `voronoiCells.ts` (wards use it), and the whole
cache/worker/manifest machinery survive whole.

## 6. Explicit-only generation and the manifest (plan 019)

Nothing generates on pan or zoom. Ever. There used to be a debounced viewport
dispatcher that generated tiles as you moved; it's gone, and a test-API
counter (`generatorRunCount`) exists specifically so gates can pan aggressively
and assert the count stays at zero. Generation happens only through **Generate
fabric here** (right-click menu, control modal, command palette), which:

1. picks the tier from your current zoom,
2. at world tier, runs that tier's generators for the tile under the point;
   at city tier (v3), resolves the domain — clicking inside an existing
   domain generates its remaining tiles, clicking outside founds a new one
   (profile modal, defaulted from the campaign theme) — all through the
   cache, in a Web Worker when available,
3. paints the result, and
4. records the *request* in `<campaign>/Generated.json`: tile entries
   `{ id: "city:0:0", tier, tileX, tileY, domainId?, createdAt }` plus, since
   v3, the `domains` array (`{ id: "dom:<cellX>:<cellY>", cx, cy, radius,
   profile, createdAt }`). Old manifests parse unchanged (zod defaults).

That manifest is the durable artifact. It's tiny, human-readable, synced, and
merge-friendly — because it stores what the GM *asked for*, not the thousands
of features that fell out. On every map open the manifest **replays**: each
entry is satisfied from cache, or regenerated deterministically on a miss.
This is the resolution of an apparent conflict between two requirements —
"generated content must persist across sessions" and "deleting `.mapcache/`
must be harmless." The request persists; the output is always reconstructible.

The cache holds **two kinds of city record** since v3 (same file, same
schema): a **domain network record** (`generatorId: "city-network"`, keyed to
the domain's anchor cell — the whole unclipped network) and the **per-tile
records** that clip from it (exactly the shape the painter always read).
Replay groups entries by `domainId` and computes-or-reads each network *once*,
then clips per entry — never recompute-per-tile, and never more than one read
of the cache file. One migration note: manifest tile entries from *before* v3
(no `domainId`, produced by the deleted per-tile city generators) still render
from their cached records — the cache is honored — but on a cache miss there
is no legacy generator to rerun, so they repaint empty until the GM
regenerates the area as a domain. Deleting `.mapcache/` remains harmless for
everything v3 generates.

*Regenerate here* re-runs a tile's entries against current constraints (same
manifest entry, new output). *Clear here / Clear all* removes manifest entries
**and** their cache records — a true rewrite-without-the-keys, not an
empty-features tombstone, because a tombstone would read back as "cached:
nothing" and silently blank the next generate. Generate and clear both append
to the mutation log (`generate-area` / `clear-area`), so they're undoable and
appear in campaign replay.

One performance note: replay reads the cache file **once** and shares the
parsed map across all entries. `generateTile`'s own per-call cache read is
fine for single tiles but would be O(entries × file size) across a replay.

## 7. Constraints: generation reacts to the GM's hand

Every generator run receives a `GenerationConstraints` object:

- `worldBounds` — the campaign's fixed box (fields derive from this).
- `canonFeatures` — location geometry. Street/corridor seeds too close to a
  location are dropped: settled ground is never paved over.
- `fabricFeatures` — **all** sketched fabric, passed *whole* to every tile
  (never pre-clipped — like the corridor rule, if two tiles saw different
  fragments of the same river they'd derive different fields and break seams).
- naming genre/culture ids for anything that names its output.

The per-kind wiring (`src/gen/fabricConstraints.ts`, pure):

| You sketch… | Generators respond… |
|---|---|
| **water** (polygon) / **river** (line, 15 m half-width) | open water is impassable to arterials (rivers cost enough that crossings concentrate into bridges); growth never builds into water; quays offset from rivers; blocks spanning water are dropped; wall bands segment at water |
| **road** | pre-seeded into the street graph as immutable edges before growth — generated streets snap *to* your sketch and T into it (the strongest form of "the generator adapts around your hand"); the direction field also blends a nearest-road alignment basis (the plan-014 corridor math) |
| **wall** | growth never crosses it (sketched walls have no gates; the *generated* wall has them) |
| **district** (polygon) | claimed ground for the *legacy* tile districts; the v3 ward Voronoi does not yet honor it (open item — wards are subtle tint, not structure) |
| **park** | nothing — streets through a park are fine |

Two implementation subtleties worth knowing:

- **Streamline cutting keeps the longest clear run, not the prefix.** A trace
  grows backward-tail → seed → forward-tail; cutting at the "first" blocked
  point would discard a whole street because its far tail started in a lake.
- **Every predicate is a pure function of world coordinates + the whole fabric
  collection**, so cut points and dropped sites are identical on every tile
  that evaluates them — the seam guarantee extends through constraints.

Finally, the feedback loop is automatic: committing, deleting, or undoing a
sketch queues a debounced regenerate of the already-generated tiles within its
influence radius (~200 m for world-tier output; for a city domain the
influence radius is the whole disc, because growth is globally coupled within
it — touch the river, the whole city re-adapts). "Sketch a river across your
city, streets re-adapt to the shoreline" is one gesture. Crucially, this only
ever *re*-generates what's in the manifest — sketching never triggers
first-time generation, so the explicit-only rule survives.

## 8. The cache and the log

`.mapcache/generated.jsonl` is a log-structured JSONL file: one record per
`(seed, tile, zoom, generatorId)` key, append-to-overwrite, last write wins on
replay. Appending is the only write primitive the hot path needs (regenerate =
append the new record), which keeps writes cheap and the format
corruption-tolerant — a torn last line loses one record, not the file. There
is deliberately **no SQLite**: files sync, diff, and die gracefully; a binary
DB in a synced vault does none of those.

`.mapcache/log.jsonl` is the append-only **mutation log** — every
map-originated write (location create/move, sketch add/remove, generate-area,
clear-area) — powering single-step undo and the "watch your campaign grow"
replay. Both files live under `.mapcache/` precisely because they're safe to
exclude from sync: one is regenerable, the other is a local edit history.

## 9. Host plumbing: worker, coordinate spaces, validation

- **Purity boundary:** everything in `src/gen/` is headless — no DOM, no map,
  no Obsidian imports (the one allowed model import is `model/fabric.ts`,
  itself a zod-only leaf). This is what makes generators unit-testable in
  Vitest without an app, and worker-executable without ceremony.
- **Web Worker:** heavy generation runs off the UI thread
  (`gen/worker/generationWorker.ts`), loaded via a Blob URL because Electron's
  renderer won't let `new Worker(path)` cross origin boundaries. The worker
  and the direct path share the exact same cache entry point (`generateTile`
  takes any `TileGenerator` closure), so caching, determinism, and constraint
  threading are identical either way — and if worker creation fails, the
  system falls back to main-thread generation rather than a broken map.
- **Coordinate spaces:** generation-space is meters; the render store keeps
  meters and converts to display units only when pushing to the MapLibre
  source. Fictional campaigns' `scaleMetersPerUnit` crossing happens in
  exactly one place (MapView's `generationContext` and paint helpers), so
  generators stay unit-agnostic.
- **IO validation:** every boundary file (`Generated.json`, `Fabric.geojson`,
  cache, log) parses through zod with **per-entry salvage** — one malformed
  entry is skipped and *counted* (surfaced as a warning notice), never a
  silent wholesale drop, and never a hard failure that eats the GM's data.

## 10. Rendering: one legend, strict z-order

Generators emit **typed features only** — `generatorId`, `type`, `roadClass`,
`biome` — never colors. Themes own all paint. Two rules keep the result
reading as *a map* rather than layers of software:

- **Provenance invisible (quality bar F2):** generated and sketched fabric of
  the same kind share the same per-kind theme tokens (`fabricRoad`,
  `fabricWater`, `fabricDistrict`…). A generated street and a sketched road
  differ in provenance, not legend.
- **The z-order invariant (`layerOrder.ts`):** background < basemap <
  generated fabric < sketched fabric < connections < session path < location
  dots < location labels. Sketched beats generated (the GM's hand wins where
  they overlap); Locations beat everything. Both style builders run
  `assertLayerOrder` on every build and a unit test checks every theme, so a
  future theme edit that would sink a pin under a fill fails in CI, not in a
  screenshot.

## 11. How it all clicks together

The full life of a generated street:

```
GM right-clicks → "Generate fabric here"            (explicit ask — the ONLY entry)
  └─ tier = bandForZoom(zoom)   tile = tileXYForPoint(point → meters)
  └─ constraints = worldBounds + locations + ALL sketched fabric (→ meters)
  └─ WORLD tier: for each generator in tier:
       key = hash(seed, tileX, tileY, zoom, generatorId)
       cache hit? ──yes──► return cached features (bytes identical, forever)
            │no
            ▼
       worker runs pure generator(seed, tileBBox, constraints)
         · seeds from position-hashed grid over tile+halo
         · traced/built through fields that are functions of position only
         · cut/steered/filtered by sketched water, walls, roads, districts
         · clipped bit-identically to the tile, sorted canonically
       append to .mapcache/generated.jsonl
  └─ CITY tier (v3): resolve-or-found the domain (profile modal on found)
       network record cached? ──no──► worker runs
         generateCityNetwork(citySeed, domain, constraints)
         · skeleton → growth → faces → parcels → outskirts/walls, one artifact
       clipNetworkToTile(network, tileBBox) → per-generatorId tile records
       append all records to .mapcache/generated.jsonl
  └─ paint into the "generated" source (below sketches, below Locations)
  └─ upsert Generated.json entry (+ domain on found) + log "generate-area"

…later, GM sketches a river through the area
  └─ Fabric.geojson updated; debounced auto-regen of affected manifest tiles
     against the new constraints → streets stop at the shoreline

…later still, vault reopens (or .mapcache/ was deleted)
  └─ manifest replay: every requested area repaints — cache hit or
     deterministic regenerate. Same seed + same constraints = same map.
```

The system's shape in one sentence: **humans own the durable layers
(Locations, sketches, and the list of places they asked the generator to
fill); the generator owns a disposable, position-deterministic texture that
always yields to them and can always be reconstructed.**

---

*Code map: `src/gen/citynet/` (the v3 city pipeline: domain, profiles,
costField, skeleton, graph, growth, cityness, faces, parcels, outskirts,
wards) · `src/gen/` (world generators, constraints, tiles, worker; `city/`
holds the §5.5 survivors: corridor, tensorField, streamlines) ·
`src/map/generation/` (cache glue + worker client) · `src/model/`
(tileCache, generatedManifest, fabric, mutationLog schemas) · `src/vault/`
(stores) · `src/view/MapView.ts` (triggers, replay, auto-regen, painting) ·
`src/map/themes/` (paint + z-order invariant). Deeper background: docs/02
§5, docs/04 (quality bar), plans/019, procgen_v3_design.md.*
