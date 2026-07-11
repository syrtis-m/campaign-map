# How the procedural generation works (and why)

*A guided tour of the procgen system as of plan 019 (July 2026). This explains
what each piece does, the reasoning behind the design, and how everything
clicks together — from the moment you click "Generate fabric here" to the
pixels on the map.*

---

## The one-paragraph version

Generation is a set of **pure functions** `(seed, bbox, constraints) →
Feature[]` that carve the world into fixed 600 m tiles and are only ever run
when the GM explicitly asks. Every random-looking decision is a hash of *where
it is* plus the campaign seed — never of generation order — so any tile
computes the same result forever, on any machine, in any sequence. Output is
disposable cache; what persists is the GM's *request* (a tiny manifest) and
the GM's own hand (locations and sketches), which feed back into every run as
constraints. Delete the cache and the map regenerates identically. That single
property — **determinism anchored to position** — is what everything else is
built around.

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
- **Every decision is keyed to position, not order.** A street's identity is
  `hashSeed(campaignSeed, cellX, cellY, "street", partIndex)`. A block's split
  ratio is `hashSeed(campaignSeed, recursionPath, "block-split")`. Nothing
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
are tuned in meters (street spacing ~60 m, district cells ~220 m, block
min-area 400 m²), so fictional campaigns convert their fake units through
`scaleMetersPerUnit` at the MapView boundary — generators never know about
display units.

There are two **tiers** of generator, selected by the zoom you're looking at
when you ask (`bandForZoom`, split at z8):

- **world**: `world-region` (Voronoi cells classified into biomes from
  noise-based height/moisture fields — this is where coastlines come from) and
  `world-route` (settlement-to-settlement paths).
- **city**: `city-street` (tensor-field streamlines), `city-district`
  (Voronoi), `city-block` (recursive subdivision of districts, plus building
  footprints).

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

The enforcement is the mandatory **2×2 adjacent-tile seam test** (CLAUDE.md):
generate four tiles around a shared corner and assert the edge-touching
geometry matches — including, since plan 019, with sketched water and roads
deliberately crossing the seams.

## 5. The generators themselves, briefly

- **Streets** (`city/index.ts` → `streamlines.ts` + `tensorField.ts`): a
  tensor field (one global grid basis + seeded radial singularities — the
  classic Wonka 2008 look of grids that curve into squares) is traced with RK4
  streamlines from hashed grid seeds. Angles are mod-π "line field" tensors,
  summed as `{cos 2θ, sin 2θ}` so direction has no polarity discontinuity.
- **Districts** (`districts.ts` → `voronoiCells.ts`): d3-delaunay Voronoi over
  hashed sites, halo-stabilized, clipped per tile.
- **Blocks** (`blocks.ts`): each district ring is recursively bisected
  (split ratio hashed to the recursion path) down to ~400 m² blocks, each with
  an inset building footprint. No halo needed — it never looks past the
  district boundary it was handed, and that boundary already matches across
  tiles.
- **World regions** (`world/regions.ts`): Voronoi cells tagged with a biome
  from `heightAt` (fractal noise + radial falloff toward the campaign center,
  so a campaign defaults to an island/landmass — Azgaar lineage) and
  `moistureAt`. Ocean-vs-land is what draws the coastline.
- **Corridor elaboration** (`city/corridor.ts`): kept from plan 014 — blends a
  drawn polyline into the tensor field as an alignment basis with exponential
  falloff. Plan 019 generalized this blend to *every* sketched road (§7) and
  retired the separate build-from-corridor flow.

## 6. Explicit-only generation and the manifest (plan 019)

Nothing generates on pan or zoom. Ever. There used to be a debounced viewport
dispatcher that generated tiles as you moved; it's gone, and a test-API
counter (`generatorRunCount`) exists specifically so gates can pan aggressively
and assert the count stays at zero. Generation happens only through **Generate
fabric here** (right-click menu, control modal, command palette), which:

1. picks the tier from your current zoom,
2. runs that tier's generators for the tile under the point — through the
   cache, in a Web Worker when available,
3. paints the result, and
4. records the *request* in `<campaign>/Generated.json`:
   `{ id: "city:0:0", tier, tileX, tileY, createdAt }`.

That manifest is the durable artifact. It's tiny, human-readable, synced, and
merge-friendly — because it stores what the GM *asked for*, not the thousands
of features that fell out. On every map open the manifest **replays**: each
entry is satisfied from cache, or regenerated deterministically on a miss.
This is the resolution of an apparent conflict between two requirements —
"generated content must persist across sessions" and "deleting `.mapcache/`
must be harmless." The request persists; the output is always reconstructible.

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
| **water** (polygon) / **river** (line, 15 m half-width) | street seeds inside are dropped; traced streets are cut where they enter; district sites inside are dropped; blocks centered in water are dropped |
| **road** | the street field blends a nearest-road alignment basis (strength 3, 60 m falloff — the plan-014 corridor math, now applied to every road), so generated streets connect to and align with your arterial |
| **wall** | streets are cut where a segment would cross it |
| **district** (polygon) | generated district sites inside are dropped — you've claimed that ground |
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
influence radius (~200 m: alignment falloff + streamline travel). "Sketch a
river across your city, streets re-adapt to the shoreline" is one gesture.
Crucially, this only ever *re*-generates tiles in the manifest — sketching
never triggers first-time generation, so the explicit-only rule survives.

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
  └─ for each generator in tier:
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
  └─ paint into the "generated" source (below sketches, below Locations)
  └─ upsert Generated.json entry + log "generate-area"

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

*Code map: `src/gen/` (pure generators, constraints, tiles, worker) ·
`src/map/generation/` (cache glue + worker client) · `src/model/`
(tileCache, generatedManifest, fabric, mutationLog schemas) · `src/vault/`
(stores) · `src/view/MapView.ts` (triggers, replay, auto-regen, painting) ·
`src/map/themes/` (paint + z-order invariant). Deeper background: docs/02
§5, docs/04 (quality bar), plans/019.*
