# Campaign Map

Campaign Map is an Obsidian plugin that adds a Google-Maps-style map tab for your
tabletop campaign. You pan and zoom it like any web map, but everything on it comes
from your vault: each pin is a note, each shape is something you drew or asked for,
and whole cities, forests, and mountain ranges can be generated on demand inside
boundaries you sketch.

It's built for the solo GM running "yes-and": a player asks about a tavern that
didn't exist ten seconds ago, and in under five seconds it's a real note in your
vault and a searchable pin on the map.

One engine covers two kinds of campaign: fictional worlds (any genre, any scale — a
fantasy realm, a noir port city, a neon sprawl) and real cities (offline street maps
of actual places). Genre comes from themes, so the same map can look like a
parchment atlas or a gaslamp case file.

---

## The three layers

The map is three layers, stacked:

1. **Locations** (top) — plain markdown notes with a few lines of frontmatter. The
   note is the source of truth and the map is a live view of it: rename the note and
   the pin renames, delete the note and the pin vanishes. You can link, tag, and
   search them like any other note.
2. **Sketch** (middle) — shapes you draw by hand: roads, walls, rivers, lakes,
   districts, parks, forests, farmland, mountains, terrain. They behave like shapes
   in PowerPoint: click one to select it, drag its corners, edit its properties, at
   any time.
3. **Generated fabric** (bottom) — background detail the generator paints only when
   you ask. It never runs on its own, and it can always be regenerated identically,
   so it's stored in a throwaway cache rather than in your synced files.

What ties them together is that a sketched shape can itself be a generation
request. Draw a district polygon and the city generator fills exactly that polygon
with streets, blocks, buildings, and a wall tracing your boundary. Drag a corner of
the polygon and the city adapts to the new shape while staying recognizably the
same city. Delete the shape and the city is gone. The same applies to rivers
(meanders, banks, islands), forests (canopy and trees), parks, farmland, walls, and
mountains.

Generated content always defers to what you made yourself: generated streets stop
at rivers you drew, align to roads you drew, and never touch your location notes.

---

## Getting started

### Install

Campaign Map isn't in the community plugin gallery yet. To install it manually:

1. Download (or build) the plugin folder containing `main.js`, `manifest.json`,
   and `styles.css`.
2. Copy it to `<your vault>/.obsidian/plugins/campaign-map/`.
3. In Obsidian: **Settings → Community plugins → turn off Restricted mode**, then
   enable **Campaign Map**.

Desktop first; it needs WebGL (any modern machine is fine).

### Create a campaign

Run the **Create campaign** command (or use the ribbon icon). A campaign is just a
note — `Campaigns/Ashfall/Ashfall.map.md` — whose frontmatter configures the map:

```yaml
---
map-campaign: true
crs: fictional          # or "real" for an actual-city basemap
theme: obsidian-native  # visual style (see Themes)
seed: 4181              # same seed, same generated world
scaleMetersPerUnit: 50  # how big the fictional world is
bounds: [-8, -6, 8, 6]  # the fictional world's extent
---
```

- **Fictional** campaigns get a bounded blank canvas; you set its scale.
- **Real** campaigns render an offline street basemap from a
  [Protomaps](https://protomaps.com) `.pmtiles` file you place in the vault
  (`basemap: Campaigns/London/basemap.pmtiles`). Real streets, fully offline.

Open the map with the ribbon icon or the **Open map** command.

### Add your first location

Click any empty spot on the map. A pin drops with one button: **+ Add location
here**. Give it a name and a type, and it's now a note in
`Campaigns/Ashfall/Locations/` plus a pin on the map. That's the entire loop.

A location note looks like this. The body below the frontmatter is entirely yours;
the plugin never touches it.

```yaml
---
map: ashfall
geometry: [0.42, -1.13]
type: tavern
visibility: close
---
Sells eel pie. The barkeep owes Vess money.
```

---

## Focus levels and visibility

The map has three focus levels, like a camera pulling in: **Wide** (the whole
realm), **Mid** (a district), **Close** (a street). The **＋/−** buttons snap
between them; the scroll wheel still zooms freely in between.

A location's dot renders at every zoom, so nothing ever vanishes. What reveals as
you focus in is its name, controlled by one explicit field:

| `visibility` | Name appears at | Good for |
|---|---|---|
| **wide** | all three levels | nations, capitals, great rivers |
| **mid** *(default)* | Mid + Close | towns, districts, landmarks |
| **close** | Close only | shops, taverns, minor residences |

You pick it in the Add-location dialog and can change it any time from the pin's
right-click menu. There's no frontmatter to edit and nothing to memorize about
which *type* shows at which zoom (`type` is purely descriptive).

Sketched and generated shapes are always visible at every zoom: a coastline you
drew never blinks out because you zoomed away from it.

### Interacting with the map

- **Hover a pin** → its name.
- **Click a location's name** → opens its note in a split beside the map.
- **Click empty ground** → dropped pin → **+ Add location here**.
- **Right-click a pin** → menu: Open note · Center · Connect to… · Visibility.
- **Right-click anywhere** → Add location here · Copy coordinates · generation
  actions.
- **Drag a pin** → moves the location (its note's geometry updates).
- Bad frontmatter is never silently dropped: the map shows a warning badge and
  leaves the note alone.

---

## The toolbar

Top-left of the map:

| Button | Does |
|---|---|
| ➕ Add location at center | Quick-add a location at the current view center |
| ✏️ Sketch fabric | Enter sketch mode (draw shapes — see below) |
| 🔍 Search locations | Type-ahead jump to any location |
| 🎨 Switch map theme | Cycle the visual style |
| ⛰ Toggle terrain | Hillshade relief + 3D terrain (fictional campaigns) |
| ⚙️ Campaign settings | Theme, naming, base terrain — plus generate & export |

Heavier, occasional actions (generate world fabric, export poster/atlas) live one
click deeper in ⚙️ settings so they don't crowd the map. Everything is also in the
command palette (search "Campaign Map").

---

## Sketching, and how sketches become cities

Click the ✏️ pencil to enter sketch mode. Pick a kind, then click to drop vertices;
double-click or **Enter** finishes, **Esc** cancels.

Kinds you can draw: road · wall · river · water · district · park · forest ·
farmland · mountain · relief · landform. Lines vs. polygons are chosen for you per
kind.

Every sketched shape does two jobs. It renders (a road you draw is a road on the
map, in every theme), and it constrains generation (generated streets align to your
roads, stop at your water, and respect your walls, automatically).

For most kinds there's a third job: the shape can carry a generator. When you
finish a district, river, forest, park, farmland, wall, or mountain shape, the map
offers to generate inside it:

| You sketch a… | The generator fills it with… |
|---|---|
| district | a whole city: streets, blocks, building footprints, plazas, walls with gates — in 12 street-pattern presets from medieval warren to Barcelona-style chamfered grid |
| river | a natural channel: meanders, braiding, banks, islands, confluences, deltas |
| forest | canopy with clearings and individually placed, varied trees |
| park | designed grounds: paths, lawns, ponds — formal, wild, or Japanese-garden |
| farmland | field patterns: strips, patchwork, orchards, rice terraces that follow the terrain |
| wall | fortifications: curtain walls, palisades, bastions, towers, gates, moats |
| mountain / relief / landform | actual elevation — peaks, ridges, plateaus, basins, coastlines that shape the 3D terrain, carve river valleys, and bend everything else around them |

Generation only happens when you ask for it. Nothing generates from panning or
zooming, ever; sketching the shape is the request.

### Editing what you generated

Use the **Select** tool in the sketch bar to click any shape:

- **Drag vertices** — the generated content adapts live (terrain contours follow
  the drag in real time; the full result lands when you release). The city keeps
  its identity — same seed — so edits refine rather than reshuffle.
- **Edit properties** — every generator has a panel of parameters, with a preset
  dropdown and tooltips on every option: density, windiness, tree variety, wall
  style, terrace spacing, and so on.
- **Drag the ◆ center handle** (cities) — put the plaza where you want it.
- **Grips** on terrain shapes drag height and width directly on the map.
- **Re-roll** — a new random result inside the same boundary. This is the only
  action that re-rolls; ordinary edits never do.
- **Delete the shape** — its generated content goes with it (your notes and other
  sketches are untouched). Deleting a river also un-carves its valley.

Plugin updates never silently change your generated content. If an update improves
a generator, affected shapes show an "update available" badge and keep their old
look until you explicitly adopt the new version, per shape or all at once.

### Terrain and 3D

Mountain, relief, and landform shapes build a real elevation model. Toggle ⛰ to
see hillshading, and tilt the map for 3D terrain. Contour lines trace the composed
terrain everywhere it has relief; rivers carve valleys through it; farmland
terraces follow it. Campaign-wide base terrain (overall ruggedness, sea level)
lives in ⚙️ settings. You can also draw a coastline and make the *outside* the
sea, which gives you islands in one stroke.

### Tracing a real map

If you're recreating an existing map (a game world, a hand-drawn region), ⚙️
settings lets you place a reference image underlay beneath the map with adjustable
opacity. Trace your coastlines and roads over it, then turn it off.

---

## World-tier generation

Besides the sketch-driven generators, **Generate fabric here** (in ⚙️ settings or
the right-click menu) paints coarse world-scale fabric — regions, settlements,
routes — around the current view. It's recorded in a small `Generated.json` so the
area repaints on every open, and **Regenerate/Clear fabric here** revise or remove
it. The same rules apply: explicit-only, deterministic, and it adapts to your
sketches and locations.

---

## Connections (point-crawls)

You can draw the links between places, not just the places. Right-click a pin →
**Connect to…** creates a connection, stored as frontmatter in the location note:

```yaml
connections:
  - to: "[[Riverwatch]]"
    type: road
    label: "2 days"
```

It renders as a themed line between the pins, survives renames, and disappears if
either endpoint is deleted, since it's just note data like everything else. Lines
are straight and undirected for now; `type` and `label` are stored in the note but
not yet drawn (curved paths, arrowheads, and travel-time labels are planned).

---

## Themes

Themes are complete visual identities — colors, typography, how every feature
paints:

- **obsidian-native** *(default)* — derived live from your Obsidian theme's CSS, so
  the map matches your setup and follows when you switch themes.
- **parchment** — hand-drawn fantasy atlas.
- **ink-soot** — high-contrast gaslamp noir.
- **modern-clean** — Google-Maps-ish; pairs well with real-city basemaps.
- **neon-sprawl** — cyberpunk glow.

Switch per campaign with 🎨. Your data never stores colors or styles, so any
campaign looks right in every theme, and a hand-drawn road and a generated street
of the same kind are deliberately indistinguishable.

---

## Exports and replay

- **Poster export** — a high-resolution PNG of the current framing, suitable for
  printing.
- **Atlas export (PDF)** — map renders composed with your location notes as the
  gazetteer, so nothing is written twice.
- **Campaign replay** — every map edit is logged, so you can replay the map growing
  session by session.
- **Session travel paths** — draw one session's route over the map.
- **Import** — bring in Azgaar / Watabou / GeoJSON exports as notes + geometry.

---

## Where your data lives (and what's safe to delete)

Everything is plain files in your vault — no database, nothing hidden:

```
Campaigns/
  Ashfall/
    Ashfall.map.md      # campaign config (a normal note)
    Locations/*.md      # one note per place — yours
    Fabric.geojson      # everything you sketched, one file
    Generated.json      # which world areas you asked to generate (tiny)
    .mapcache/          # generated output + edit log — REGENERABLE
```

A few properties worth knowing:

- **Deleting `.mapcache/` is always safe.** Generation is deterministic, so the
  same campaign regenerates identically from your sketches and seed. (Shapes still
  pinned to an older generator version show their update badge and re-render once
  adopted, rather than silently changing.)
- **`.mapcache/` should be excluded from sync** — it's per-machine and disposable.
  Everything durable (notes, sketches, config) syncs like any other vault file and
  never conflicts with the cache.
- **The plugin never writes below a note's frontmatter.** The body is yours.
- **Fully offline.** No accounts, no network calls; real-city basemaps are local
  files.

---

## Tips & limits

- **Undo** (in sketch mode) reverses the last map edit; multi-step undo is still on
  the roadmap.
- All pins currently render as uniform dots; per-type icons are planned.
- Very long Obsidian sessions can slow the renderer. Restarting Obsidian clears it
  (reopening just the window doesn't).
- The plugin is desktop-first; it's written to keep mobile possible but isn't
  tested there.

---

## For developers and coding agents

The product docs stop here. If you're working *on* the plugin:

| File | What |
|---|---|
| [CLAUDE.md](CLAUDE.md) | The standards doc: locked decisions, conventions, performance/testing bars, documentation rules — **read first** |
| [ARCHITECTURE.md](ARCHITECTURE.md) | The system map: data model, procgen engine, host, rendering, invariants, the GM-action → event cascade |
| [docs/procgen-design.md](docs/procgen-design.md) | Determinism doctrine (D1–D6), seam safety, city-pipeline rationale |
| [docs/quality-bar.md](docs/quality-bar.md) | Failure modes, acceptance criteria, pinned aesthetic defaults |
| [docs/dev-workflow.md](docs/dev-workflow.md) | The playground + Obsidian CLI dev loops, test tiers, known pitfalls |
| [docs/note-contract.md](docs/note-contract.md) | The frontmatter contract external agents can emit notes against |
| [plans/README.md](plans/README.md) | The plan ledger — every feature plan and its status |

```bash
npm run dev         # esbuild watch → dev vault
npm run playground  # procgen inner loop (localhost:8734, no Obsidian)
npm test            # fast Vitest tier (generators + model)
npm run build       # typecheck + bundle
npm run board       # the 5-gate live smoke board (needs a running Obsidian)
```
