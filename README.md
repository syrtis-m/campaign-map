# Campaign Map — an Obsidian map builder for tabletop campaigns

A Google-Maps-style map tab that lives inside Obsidian. One engine renders three
genres: fictional fantasy worlds, real modern cities, and stylized
Dishonored-esque cities. It's built for the solo GM running "yes-and": you invent
a location mid-session and it becomes a vault note **and** a searchable map pin in
under five seconds.

**The one idea that explains everything else:** *canon is your notes.* A location
is a plain markdown note with a bit of `map:` frontmatter. The vault is the source
of truth; the map is a live view of it. Rename the note, the pin renames. Delete
the note, the pin vanishes. Everything the map generates on top (streets, coastlines,
districts) is disposable scaffolding until you "canonize" it — at which point it,
too, becomes a note.

---

## The core loop (what it feels like to use)

1. Open a campaign's map (ribbon icon, or **Open map** command).
2. Click empty ground → a dropped pin appears → **+ Add location here** → name it,
   pick a type, done. It's now a note in your vault and a pin on the map.
3. Need the surrounding city to *look* like a city? **Generate fabric here** paints
   procedural streets/districts/coastline around your canon — deterministically, so
   it's the same every time and safe to delete.
4. Want a specific road or river *exactly there*? **Sketch** it by hand.
5. Anything generated or sketched that becomes real → **Canonize** / **Promote** it
   into a note.

That's the whole builder: **canon locations** (hand-placed truth) → **procedural
fabric** (cheap texture) → **sketched fabric** (hand-drawn texture) → promote the
keepers up into canon.

---

## Concepts

### Campaigns
A campaign is a `*.map.md` note with frontmatter that configures the whole map:

```yaml
---
map-campaign: true
crs: fictional          # or "real" for a real-city basemap
theme: obsidian-native  # visual style (see Themes)
seed: 4181              # determinism anchor — same seed = same generated world, forever
scaleMetersPerUnit: 50  # how big the fictional world is
bounds: [-8, -6, 8, 6]  # fictional-world extent (fictional CRS)
# basemap: Campaigns/London/basemap.pmtiles   # real CRS only: a Protomaps file in the vault
---
```

- **Fictional** campaigns use a made-up coordinate box; you set its scale.
- **Real** campaigns render an offline [Protomaps](https://protomaps.com) `.pmtiles`
  basemap stored *in the vault* — real streets, fully offline.

### Locations
A location note carries minimal frontmatter; the body is yours to write freely.

```yaml
---
map: ashfall            # which campaign this belongs to
geometry: [0, 0]        # a point [lng, lat]; complex shapes go in a sidecar .geojson
type: city              # sets importance + depth-of-field bucket (see below)
---
The capital. Everything below the frontmatter is your normal note.
```

The **type** does the cartographic discipline for you — you never hand-tune label
sizes or zoom numbers. There are just **three focus levels** (Wide / Mid / Close,
see below), and a type's job is to say at how many of them the location's *name* is
legible. That's its **depth of field**:

| Depth of field | Name shows at | Types |
|---|---|---|
| **Deep** | all three levels | nation/region, city, water-feature |
| **Medium** | Mid + Close | town, village, route, district, landmark, custom |
| **Shallow** | Close only | street(named), shop/tavern/venue, residence/minor |

The **dot is always drawn at every zoom** — locations never vanish; only their names
reveal as you focus in (a river is named from the Wide view, a corner tavern only
once you're at street level). Override a single note's bucket with `focus: deep`
(or `medium`/`shallow`) in its frontmatter. Bad frontmatter never silently
disappears — you get a warning badge and the note is left untouched.

### Focus levels
The map has three fixed **focus levels** — think of a camera's focal distances:
**Wide** (the whole map / overview), **Mid** (a district), **Close** (a street). The
**＋ / −** buttons (bottom-right) *snap* between them, with a three-dot readout of
where you are; the mouse wheel / trackpad still zooms continuously for anything in
between. The three levels are computed *per campaign* from its natural overview zoom,
so a sprawling fictional world and a real city both get the same three-step feel —
you never memorize zoom numbers. Depth of field (above) decides which names are
legible at each level.

### Themes
Themes are complete visual styles (colors, fonts, how every feature paints):

- **obsidian-native** (default) — generated live from your Obsidian CSS variables,
  so the map matches your current Obsidian theme and follows it when you switch.
- **parchment** — hand-drawn fantasy-atlas look.
- **ink-soot** — high-contrast noir.
- **modern-clean** — Google-Maps-ish, good for real cities.
- **neon-sprawl** — cyberpunk glow.

Switch per-campaign with the palette button. Themes own *all* the styling; your
data never carries color or style, so any map looks right in every theme.

---

## The map toolbar

Top-left of the map, in order:

| Button | Does |
|---|---|
| ➕ **Add location at center** | Quick-add a canon location at the current center. |
| 🪄 **Generate fabric here** | Paints procedural fabric around here. Picks *world* (regions/settlements/routes) or *city* (streets/districts) automatically from your zoom. |
| 🔖 **Canonize nearest generated** | Turns the nearest generated feature into a real canon note. |
| ✏️ **Sketch fabric** | Enters sketch mode to hand-draw roads, walls, rivers, water, districts, parks (see Sketching). |
| 🔍 **Search locations** | Quick-switcher-style jump-to-location. |
| 🎨 **Switch map theme** | Cycle the visual style. |
| 🖼️ **Export map poster** | High-res PNG of the current view. |
| 📖 **Export campaign atlas (PDF)** | Map renders + your location notes as a gazetteer. |
| ⚙️ **Campaign settings** | Theme, naming culture, basemap. |

Everything here is also in the command palette (search "Campaign Map").

### Interaction grammar (borrowed wholesale from Google Maps)
- **Click a pin** → place card with a note preview + Open / Center / Connect to…
- **Click empty ground** → dropped pin → **+ Add location here**.
- **Right-click** → native menu (Add location here / Copy coordinates).
- **Drag a pin** → moves the location; the note's geometry is rewritten to match.
- **Hover a pin** → name tooltip.

---

## Building the world, three ways

### 1. Canon locations — hand-placed truth
The pins you add. These are the notes. Everything else is scaffolding around them.

### 2. Procedural fabric — cheap deterministic texture
**Generate fabric here** grows a plausible world/city around your canon using the
campaign seed. It's a pure function of `(seed, position, zoom)` — the same input
always produces the same output, so it never drifts, and deleting the `.mapcache/`
folder regenerates it identically. Generated streets avoid your canon locations
(they're never overwritten). Canonize the pieces you want to keep.

### 3. Sketched fabric — hand-drawn texture
When you want a specific road, wall, river, coastline, or district *exactly* where
you draw it. Click the pencil to enter **sketch mode**, then a sub-bar appears:

- **Pick a kind:** road · wall · river · water · district · park. (Lines vs.
  polygons chosen automatically per kind.)
- **Draw:** click to drop vertices, double-click or **Enter** to finish, **Esc** to
  cancel, **Del** to delete a selected feature.
- **feed: on / off** — with feed **on**, a road you draw becomes *input to the
  procedural generator* instead of a literal line. This is the "Sims landscaping"
  idea: sketch a rough arterial, hit **build**, and it grows a whole branching
  street network aligned to your stroke. With feed **off**, what you draw is what
  you get.
- **build** — elaborates your generate-mode road corridors into street networks.

Sketched fabric lives in **one file** per campaign (`Fabric.geojson`) and, like
generated fabric, respects level-of-detail: a dense street web drawn at close zoom
cleanly drops out when you zoom way out instead of tangling into noise. Any sketched
feature can be **promoted** to a full location note (**Promote sketched fabric**
command).

---

## Point-crawl connections

For hex/point-crawl games: draw the *links between* locations, not just the
locations. A connection is declared in a location note's frontmatter:

```yaml
connections:
  - to: "[[Riverwatch]]"
    type: road
    label: "2 days"
```

It renders as a themed line between the two pins, in every map style. Because it's
canon (just note frontmatter), it survives renames and disappears when either
endpoint is deleted. Create them from the map: click a pin → **Connect to…**.
Straight undirected lines today; curved/waypointed paths, arrowheads, and
travel-time labels are scoped follow-ups.

---

## Export & replay

- **Poster** — high-res PNG of the current framing, canon + generated + connections
  baked in.
- **Atlas (PDF)** — composes map renders with your location notes as the gazetteer
  (the notes *are* the gazetteer — no double entry).
- **Session travel path** — draw one session's route over the map.
- **Replay campaign** — animate the map's edit history from the mutation log.
- **Import** — bring in Azgaar / Watabou / GeoJSON exports as notes + geometry.

---

## Where things live (the data model)

Everything is files in your vault — nothing hidden in a database.

```
Campaigns/
  Ashfall/
    Ashfall.map.md          # campaign config
    Locations/*.md          # canon location notes (one per place)
    Fabric.geojson          # all your sketched fabric, one promotable file
    .mapcache/              # regenerable — safe to delete, sync-excluded
      log.jsonl             # append-only edit history (undo / replay)
```

Design guarantees worth knowing:
- **Deleting `.mapcache/` is always harmless** — it regenerates identically. If it
  ever *doesn't*, determinism broke, and that's a release-blocker bug.
- **Never edited by Node `fs`** — only Obsidian's vault APIs, so mobile stays
  possible.
- **Every map-originated write is logged** to `log.jsonl` for undo and campaign
  replay.

---

## Current state — what actually works today

Phases 0–5 of the roadmap are shipped and live-verified, plus point-crawl
connections and the sketch/landscaping tools (Phase 6, plans 013–014). Concretely,
these work in the live app right now:

- Canon locations: add / rename / move / delete → map updates instantly.
- Five themes, live theme-following for obsidian-native, real-city PMTiles basemaps.
- Procedural world + city generation (deterministic, seam-tested), canonize.
- Sketch mode: draw/delete/promote road·wall·river·water·district·park.
- Sketch→procedural: draw a road corridor, generate a street network from it.
- Point-crawl connections, poster PNG, atlas PDF, session path, replay, import.

### Known rough edges (honest list — also a work queue)

These are real and shipped-around, not hidden:

- **Per-type location icons are not in** — a prototype (plan 006) caused a
  style-load stall (`map.addImage` at runtime left the style stuck loading, no
  console error) and was reverted. All pins are currently uniform dots. Rollout
  needs the sprite-sheet approach in `plans/006-NOTES.md`.
- **Poster PNG output** — the render path is wired and unit-tested but the actual
  image hasn't been eyeballed for quality yet.
- **Right-click menu** — implemented with the standard Obsidian `Menu` API but
  unverifiable under CLI automation (an OS focus/trust gate); works for a human,
  untested by gates.
- **Renderer degrades over very long sessions** — p95 pan FPS drops after many
  generate/eval cycles; only a full Obsidian restart clears it (`plugin:reload`
  doesn't). Under investigation.
- **Sketch v1 is draw/delete/promote only** — no vertex re-editing, snapping, or
  freehand brush yet.
- **Sketch→procedural covers roads→streets only** — district/river/wall/park
  elaboration are unbuilt follow-ups (see `plans/014`).

---

## Future vision (NOT yet built — do not treat as shipped)

> Everything in this section is direction, not current behavior. If you're an agent
> fixing a bug, nothing here exists to be fixed.

- **Empty-state onboarding** on a fresh canvas (right now a new campaign opens bare).
- **In-app basemap acquisition** for real cities (today you cut the `.pmtiles`
  yourself).
- **Generated fabric as a browsable, legended layer** you can toggle.
- **Batch canonization** (promote many features at once).
- **LLM populate-notes** — "populate this district with 5 shops" → an in-vault agent
  writes valid location notes (a `populate-area` command + generator exist; the LLM
  hook is the unbuilt part).
- **Detail band z16+** — building/POI-level fabric.
- **Multi-step undo/redo** — today undo reverses only the single last edit.
- **Obsidian Bases integration** — locations as a Bases view (API-gated spike).
- **Sketch polish** — vertex editing, snapping, curve smoothing, freehand.
- **Richer connections** — curves, waypoints, arrowheads, travel-time labels.

---

## For agents working on this codebase

Read `CLAUDE.md` first — the locked decisions there are not yours to relitigate.
Then, the traps and invariants that bite hardest:

- **The MapLibre zoom-expression trap (read this before touching any style/layer).**
  `zoom` MUST be the top-level expression of a paint property, and is FORBIDDEN
  inside a layer `filter`. Violating either **silently invalidates the entire
  style**: the map loads blank, with *no console error*, and `npm test` stays
  green. This has shipped twice. It is invisible without the live loop below. Put
  per-zoom LOD floors on a layer's `minzoom` property, never in a filter. See
  `src/map/themes/fabricLayers.ts` and `generatedLayers.ts` for the correct shape.
- **A green `npm test` does NOT prove the map renders.** Unit tests can't catch an
  invalid MapLibre style. You must drive the live app: `plugin:reload
  id=campaign-map` → `dev:errors` clean → check `map.isStyleLoaded() === true` →
  `dev:screenshot` and *actually look at it*. (See docs/05 for the loop.) A gate
  hardening task is adding `isStyleLoaded()` assertions + a `validateStyleMin` unit
  test to close this gap.
- **Renderer degradation is real** — after many gate/eval runs in one Obsidian
  process, styles stop loading and `idle` stops firing. Only a full process restart
  clears it (window reload and `plugin:reload` do not). When "the fix broke it,"
  suspect this before assuming your change is wrong; A/B across restarts.
- **Generators are pure** — `(seed, bbox, constraints) => Feature[]` in `src/gen/`,
  no DOM/map/Obsidian imports. Determinism is sacred; **2×2 adjacent-tile seam
  snapshot tests are mandatory** for anything touching `gen/`.
- **Canon is never overwritten by generators.** Canon geometry feeds generators as
  constraints (streets repel pins); it's an input, never an output.
- **Themes own all paint; generators emit typed features only, never styles.**
- Run everything against `dev-vault/`, never a real vault. The test API is exposed
  at `app.plugins.plugins['campaign-map']`.

Full detail: `docs/05-dev-workflow.md`, `docs/06-autonomous-build.md`, `PROGRESS.md`
(resume state), `DECISIONS.md` (why things are the way they are), `plans/README.md`
(plan-by-plan status + the roadmap gap register).

---

## Go deeper

| File | What |
|---|---|
| [docs/01-sota-research.md](docs/01-sota-research.md) | Prior art: procedural generation, web mapping, offline stack, Obsidian plugin landscape |
| [docs/02-architecture.md](docs/02-architecture.md) | Vault data model, theming, procedural-LOD + canon design |
| [docs/03-roadmap.md](docs/03-roadmap.md) | The five build phases + exit tests |
| [docs/04-quality-bar.md](docs/04-quality-bar.md) | Failure modes + acceptance criteria (the screenshot test) |
| [docs/05-dev-workflow.md](docs/05-dev-workflow.md) | Build & test loop via the official Obsidian CLI |
| [docs/06-autonomous-build.md](docs/06-autonomous-build.md) | Unattended-build protocol: preflight, gates, pinned defaults |
| [CLAUDE.md](CLAUDE.md) | Conventions and locked decisions for coding agents |
| [plans/README.md](plans/README.md) | Every implementation plan, status, and the roadmap gap register |

## Develop

```
npm run dev     # esbuild watch → dev vault
npm test        # Vitest — generators + model
npm run build   # typecheck + bundle
```
