# Campaign Map — an Obsidian map builder for tabletop campaigns

A Google-Maps-style map tab that lives inside Obsidian. One engine renders three
genres: fictional fantasy worlds, real modern cities, and stylized
Dishonored-esque cities. It's built for the solo GM running "yes-and": you invent
a location mid-session and it becomes a vault note **and** a searchable map pin in
under five seconds.

**The one idea that explains everything else:** the map has exactly two layers.
**Locations** are plain markdown notes with a bit of `map:` frontmatter — the vault
is the source of truth; the map is a live view of it. Rename the note, the pin
renames. Delete the note, the pin vanishes. **Things on the map** ("fabric" —
roads, walls, rivers, water, districts, parks) are background geometry, the way
shapes in PowerPoint work: sketched by hand or painted by the generator **only
when you ask**. Locations always render above fabric, and fabric never turns into
a Location — the two layers never trade members.

---

## The core loop (what it feels like to use)

1. Open a campaign's map (ribbon icon, or **Open map** command).
2. Click empty ground → a dropped pin appears → **+ Add location here** → name it,
   pick a type, done. It's now a note in your vault and a pin on the map.
3. Need the surrounding city to *look* like a city? **Generate fabric here** paints
   procedural streets/districts/coastline around your locations — **only when
   asked**, never on its own, and reactive to anything you've already drawn.
4. Want a specific road or river *exactly there*, or to steer what generation does
   somewhere? **Sketch** it by hand — the generator treats your strokes as
   constraints and adapts around them.

That's the whole builder: **Locations** (note-backed, linkable places) on top of
**things on the map** (sketched or generated background fabric).

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
type: city              # what it IS — semantic only (naming, future icons)
visibility: wide        # when its NAME appears as you zoom in (see below)
---
The capital. Everything below the frontmatter is your normal note.
```

**Visibility is its own explicit field** — you set it directly, so you never have
to remember which *type* is legible at which zoom. There are three **focus levels**
(Wide / Mid / Close, see below), and `visibility` says at which one the location's
*name* first appears:

| `visibility` | Name shows at | Good for |
|---|---|---|
| **wide** | all three levels | nations, capitals, rivers — the big anchors |
| **mid** | Mid + Close | towns, districts, routes, landmarks *(the default)* |
| **close** | Close only | streets, shops, minor residences — fine grain |

The **dot is always drawn at every zoom** — locations never vanish; only their names
reveal as you focus in (a river named `wide` shows from the Wide view; a corner
tavern set `close` only once you're at street level). A note with no `visibility`
defaults to **mid**. You set it in the **Add location** dialog and can change it
anytime from a location's place card — no frontmatter editing. `type` is purely
semantic now and never controls visibility; changing a note's type alone doesn't
change what's visible. (The old `focus: deep|medium|shallow` key is still accepted
for older notes.) Bad frontmatter never silently disappears — you get a warning
badge and the note is left untouched.

### Focus levels
The map has three fixed **focus levels** — think of a camera's focal distances:
**Wide** (the whole map / overview), **Mid** (a district), **Close** (a street). The
**＋ / −** buttons (bottom-right) *snap* between them, with a three-dot readout of
where you are; the mouse wheel / trackpad still zooms continuously for anything in
between. The three levels are computed *per campaign* from its natural overview zoom,
so a sprawling fictional world and a real city both get the same three-step feel —
you never memorize zoom numbers. A location's `visibility` (above) decides which
names are legible at each level.

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

Top-left of the map, in order — kept deliberately small: only the actions you
reach for constantly mid-session.

| Button | Does |
|---|---|
| ➕ **Add location at center** | Quick-add a canon location at the current center. |
| ✏️ **Sketch fabric** | Enters sketch mode to hand-draw roads, walls, rivers, water, districts, parks (see Sketching). |
| 🔍 **Search locations** | Quick-switcher-style jump-to-location. |
| 🎨 **Switch map theme** | Cycle the visual style. |
| ⚙️ **Campaign settings** | Theme, naming culture, basemap — and the **Generate & export** actions below. |

The occasional/heavy actions live one click deeper, under **Campaign settings →
Generate & export**, so they don't clutter the map:

| Action (in ⚙️ settings) | Does |
|---|---|
| 🪄 **Generate fabric here** | Paints procedural fabric around the map center. Picks *world* (regions/routes) or *city* (streets/districts/blocks) automatically from your zoom. Durable: the area repaints on every open until cleared. |
| 🔁 **Regenerate fabric here** | Re-runs generation at the map center against current constraints (locations + sketched fabric). |
| 🧹 **Clear generated fabric** | Removes generated fabric at the map center, or all of it. Sketches and locations are never touched. |
| 🖼️ **Export map poster** | High-res PNG of the current view. |
| 📖 **Export campaign atlas (PDF)** | Map renders + your location notes as a gazetteer. |

Generate/Regenerate/Clear act on the current map center and zoom — position the
view first. They're also on the right-click menu and in the command palette
(search "Campaign Map").

### Interaction grammar (borrowed wholesale from Google Maps)
- **Click a pin** → place card with a note preview + Open / Center / Connect to…
- **Click empty ground** → dropped pin → **+ Add location here**.
- **Right-click** → native menu (Add location here / Copy coordinates / Generate ·
  Regenerate · Clear fabric here).
- **Drag a pin** → moves the location; the note's geometry is rewritten to match.
- **Hover a pin** → name tooltip.

---

## Building the world, three ways

### 1. Locations — note-backed places
The pins you add. These are the notes: linkable, searchable, always rendered above
everything else. Everything below is background around them.

### 2. Generated fabric — explicit, deterministic, reactive
**Generate fabric here** grows a plausible world/city around your locations using
the campaign seed — **only when you ask** (no generation ever runs from panning or
zooming). It's a pure function of `(seed, position, constraints)`: the same input
always produces the same output, so it never drifts, and deleting the `.mapcache/`
folder regenerates it identically. What's durable is the *request*: each generated
area is recorded in `Generated.json`, and on every open those areas repaint from
cache or regenerate deterministically. Generated streets avoid your locations and
respect your sketches — sketch a river through a generated district and the
streets re-adapt to stop at the shoreline, on their own.

### 3. Sketched fabric — hand-drawn texture
When you want a specific road, wall, river, coastline, or district *exactly* where
you draw it. Click the pencil to enter **sketch mode**, then a sub-bar appears:

- **Pick a kind:** road · wall · river · water · district · park. (Lines vs.
  polygons chosen automatically per kind.)
- **Draw:** click to drop vertices, double-click or **Enter** to finish, **Esc** to
  cancel, **Del** to delete a selected feature.
Every sketched feature is also a **generator constraint** — no toggle, no build
button: roads steer generated street networks to align with them, water and
rivers block streets and districts, walls stop streets, sketched districts keep
generated districts out. If you sketch inside an area you've already generated,
the affected tiles regenerate on their own a moment later ("sketch a river,
streets adapt"). Sketching never *starts* generation — that stays explicit.

Sketched fabric lives in **one file** per campaign (`Fabric.geojson`). It's
**always visible at every zoom** — roads, walls, rivers, water, districts, and
parks never disappear when you zoom out (zoom-based hiding applies only to
location *names*, see Focus levels). Geometry is simplified far out for
performance (fewer vertices), but the feature always draws. Fabric is background:
it never becomes a location note — places worth lore are Locations you add.

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
    Fabric.geojson          # all your sketched fabric ("things on the map"), one file
    Generated.json          # the areas you asked to generate (tiny, synced)
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

- Locations: add / rename / move / delete → map updates instantly.
- Five themes, live theme-following for obsidian-native, real-city PMTiles basemaps.
- Explicit procedural generation (deterministic, seam-tested) with a durable
  per-area manifest (`Generated.json`) + regenerate/clear.
- Sketch mode: draw/delete road·wall·river·water·district·park — every stroke is
  also a generator constraint; generated areas auto-adapt to sketch edits.
- Point-crawl connections, poster PNG, atlas PDF, session path, replay, import.

**Breaking change (plan 019):** generation no longer runs automatically as you
pan/zoom, and there is no canonize/promote — fabric and Locations are permanently
separate layers. Campaigns from before this change will visually lose their
auto-generated sprawl until you explicitly **Generate fabric here** where you want
it (your old `.mapcache/` is still valid and will be reused where the tiles
match). Existing canonized notes are just notes — they keep working untouched.

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
- **Sketch v1 is draw/delete only** — no vertex re-editing, snapping, or
  freehand brush yet.
- **Fabric constraints are city-tier only** — world-tier regions/routes ignore
  sketches (a route can still cross a sketched lake); coastline *snapping* (vs
  avoidance) is likewise a follow-up.

---

## Future vision (NOT yet built — do not treat as shipped)

> Everything in this section is direction, not current behavior. If you're an agent
> fixing a bug, nothing here exists to be fixed.

- **Empty-state onboarding** on a fresh canvas (right now a new campaign opens bare).
- **In-app basemap acquisition** for real cities (today you cut the `.pmtiles`
  yourself).
- **Generated fabric as a browsable, legended layer** you can toggle.
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
  any per-zoom reveal on a layer's `minzoom` property, never in a filter. **LOD is
  for location names only** — the `canon-label-*` layers use `minzoom` (set live
  via `setLayerZoomRange` from the campaign overview); fabric carries no `minzoom`
  and renders at every zoom. Never reintroduce a fabric `minzoom`.
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
