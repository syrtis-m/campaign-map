# Plan 025 — Street-pattern presets & benchmark-driven city quality (Salat research)

**Status:** research/design done 2026-07-12, approved direction from Jonah ("use
this pdf containing research on street patterns to define other templates/styles
for city procgen — and use it to consider how city procgen might be improved").
Source: Serge Salat, *Integrated Guidelines for Sustainable Neighbourhood
Design*, ch. 2.4 "Connect People Movement and Street Patterns", Urban
Morphology & Complex Systems Institute / UNEP, 2021. Builds on plan 020
(regions) and plan 022 §1 (the preset pattern — this plan's presets ride that
mechanism); independent of plans 023/024 except where marked.

## 0. Context for a cold-start implementer (read even if you skip everything else)

**The product in one line:** an Obsidian plugin giving a solo GM a
Google-Maps-style tab for tabletop campaigns; locations invented mid-session
become notes + pins in ≤5 s, and background world detail is procedurally
generated *only on explicit GM request*, deterministically, forever.

**Read before writing code:** `CLAUDE.md` (locked decisions — binding),
`plans/020-sketch-driven-procgen-regions.md` (regions architecture),
`plans/022-procgen-suite-rivers-forests-parks-walls.md` §0–§1 (the full
cold-start context — invariants, infra pitfalls, protocol — plus the preset
pattern this plan extends; everything there applies here verbatim),
`procgen_v3_design.md` §4 (determinism rules D1–D6), and the city pipeline
itself: `src/gen/citynet/` (profiles → skeleton → growth → faces → parcels →
wards → outskirts).

**Key inherited facts:** a sketched district polygon with a `procgen` block is
the city request; `generateCityNetwork(citySeed, region, profileId, constraints)`
computes the whole network which tiles clip (seam story); profiles are data
objects in `src/gen/citynet/profiles.ts` (segment lengths, branch probabilities,
snap behavior, grid azimuths, wall chance, parcel/footprint params); the four
existing profiles (euro-medieval, euro-continental, na-grid, na-suburb) become
presets of the `city` algorithm under plan 022 §1. Identity property: vertex
edits and version upgrades must not re-roll existing cities (022 §1
additive-params rule). All emitted features are typed; themes own paint.

## 1. Research digest (what the source actually establishes)

### 1.1 The three macro pattern types
1. **Lattice/grid** (regular or irregular) — the basis of all cities for ~5000
   years (Greek/Roman/Chinese gridded cities; medieval irregular lattices are
   still lattices).
2. **Tree / cul-de-sac** — invented 20th c. for the car; dead-end hierarchies,
   low connectivity (our `na-suburb` is deliberately this).
3. **Superblock** — modernist (Le Corbusier lineage): blocks 400–800 m, roads
   70–100 m, traffic on the edges, short dead-end internal streets.

### 1.2 Benchmarks (the numbers worth encoding)
- **Intersection density** (per ~square mile in the source's comparison):
  Manhattan ≈120, Washington ≈48, Washington suburbs ≈36, Brasília ≈41,
  Beijing South superblocks 13–16, Shanghai Pudong 17. Chongqing walkable
  commercial core >90/km² vs. new superblock districts ~10/km². Optimal
  connectivity guidance: 60–100 m grid spacing ⇒ ~100–150 intersections/km².
- **Economic signal** (why it matters in-world): superblock districts show
  ~16× lower economic density and up to 11× higher street-infrastructure cost
  per unit of GDP than fine-grain walkable fabric. (For US: a legible
  narrative hook — superblock fabric should *read* emptier at street level.)
- **Urban grain** (block size): 50 m in Tokyo/Kyoto; ~120 m in historic
  European centres, Hong Kong, Melbourne; guidance favors short blocks
  60–120 m with many intersections; grid spacing 50 m (Japanese cities) to
  70 m (Roman Empire grid — still legible after 2000 years) where pedestrian
  activity is intense, 80–100 m generally; Manhattan blocks 60 m wide ×
  160–260 m long, intersection tempo ~80 m.
- **Named figure-ground reference values** (intersections/km², from the
  source's one-square-mile figure-ground studies — use these as preset
  calibration anchors AND as visual acceptance references for screenshots):
  Venice 688 · Toledo 420 · Florence 255 · Amsterdam 17th-c. 195 · Turin 191 ·
  London Mayfair 165 · Paris Étoile 133 · Barcelona Cerdà 103 · HK Central 459 ·
  Tokyo Nihonbashi 386 · Seoul 313 · Amsterdam core 314 · Paris Louvre 242 ·
  Lower Manhattan ~192 · Midtown ~112 · San Francisco ~114 · Chongqing
  superblocks ~49–66. Street linear density: **≥18 km of street per km²** is
  the guideline floor (Amsterdam 30.7, Tokyo 30.2, Paris 27.9, Manhattan 22.7,
  Chongqing superblocks 12–14).
- **Land share**: 25–30% of neighbourhood land in streets (Paris intra-muros:
  27%, 17.2 km of street per km², average width 15 m; Opéra district: 20 km/km²,
  117 intersections/km²).
- **Width distribution** (Opéra district): 23% of streets <10 m, 57% 10–20 m,
  20% >20 m — *the highest proportion of streets should be narrow*, with a
  form-based hierarchy rather than a traffic-flow hierarchy. Typical facade-to-
  facade 10–18 m; aspect ratio (building height : street width) ~4 in hot-dry
  medinas/Bologna, ~0.7 on Haussmann boulevards (equilibrium), ~2 in narrow
  Paris streets.
- **Manhattan specifics**: constant 60 m block widths, varying lengths;
  30 m avenues; 18 m standard / 30 m major cross streets; intersection tempo
  ~80 m — differentiation of avenues vs streets is what gives the grid
  legibility and directionality.

### 1.3 Composition devices (the qualitative gold)
- **Tartan grids** (Seoul, Tokyo Marunouchi): a coarse regular grid of large
  streets with a fine, often irregular alley web *inside* the cells — high
  permeability at two scales at once.
- **Ward grids** (Savannah 1833): modular grid cells, each centred on a square
  or park; directional asymmetry (24–26 m E-W mains, 10 m N-S standards,
  10–18 m ward-internal).
- **Eixample** (Barcelona, Cerdà 1860): uniform square blocks with chamfered
  corners (octagonal intersections — the signature), grid rotated to cardinal
  points for sun/breeze; avenues connect the territory, streets the locality.
- **Baroque axial compositions** (Roma Trident, Turin Via Po): long straight
  corsi (1.6 km) cut/composed through irregular fabric; a trident fanning from
  a gate piazza; sequences that expand/contract (220–700–680 m rhythms);
  monumental endpoints as points of view.
- **Haussmann breakthroughs** (Paris): wide perspective boulevards CUT through
  the retained medieval parcel fabric, aimed at monuments (Opéra, Place
  Vendôme); slight elbows acceptable ("convex effect"); the old fabric
  survives BETWEEN the cuts — the palimpsest is the look.
- **Growth rings** (Paris Châtelet study): successive walls; streets parallel
  inside the wall, radials sprouting outside the gates; each ring's fabric
  datable. (Our euro-medieval already grows radially from gates — one wall.)
- **Concentric grids** (Scotland 2010 typology diagrams; Amsterdam canal
  rings; Paris Étoile): arc streets concentric on a centre (canal, plaza,
  transport node) crossed by radials — a first-class pattern family distinct
  from both grid and organic, explicitly recommended "to promote access to
  local centres".
- **Perimeter blocks + curve/straight balance**: buildings front the street;
  short curved/irregular streets add place-character but excessive curvature
  is an anti-pattern; combine both.
- **Water linkages** (Kyoto Philosopher's Path, Venice Strada Nova): canal- or
  spine-following pedestrian paths with perpendicular laterals — pairs with
  plan 022 rivers (a `towpath` river option is a cheap, high-charm follow-up).

## 2. New city presets (ride plan 022 §1's preset mechanism)

Each is a `city`-algorithm preset = a `profiles.ts` data object + at most one
new pipeline operator (§3). Default theme pairings in parentheses.

1. **`haussmann`** (parchment/modern-clean) — euro-medieval-like organic base
   PLUS the §3.2 axial-breakthrough operator: 2–4 boulevards (emitted width
   ~30 m, roadClass `boulevard`) aimed at the plaza/landmarks/gates, slight
   elbow permitted; medieval fabric retained between cuts; width distribution
   re-checked post-cut (§3.1). Star intersections where boulevards meet.
2. **`tartan-grid`** (any) — coarse arterial grid (~250 m spacing, wide) with
   fine irregular alley webs grown INSIDE each cell (highest intersection
   density of any preset; grain ~40 m — the Seoul/Tokyo look).
3. **`ward-grid`** (parchment/modern-clean) — Savannah: modular cells around
   generated squares/parks (ties into `city-landmark` plaza emitters);
   directional width asymmetry (wide one axis, narrow the other).
4. **`eixample`** (modern-clean) — uniform square blocks, **chamfered corners**
   (the octagonal intersection is the visual signature — a block-corner
   post-pass in faces/parcels), single cardinal orientation, avenue/street
   two-level hierarchy.
5. **`baroque-axial`** (parchment/ink-soot) — organic base + a trident fanning
   from one gate piazza + 1–2 long straight corsi; monumental landmark at each
   axis endpoint (points of view).
6. **`superblock`** (neon-sprawl default) — the research's anti-pattern AS A
   GENRE AESTHETIC: 400–800 m megablocks, 70–100 m arterial canyons, internal
   dead-ends, towers-in-plot footprints, intersection density deliberately
   ~10–15/km². The quality bar here is genre fidelity (Dishonored/dystopia
   reads), not urbanism virtue — document that inversion in the preset so a
   future agent doesn't "fix" it.
7. **`canal-rings`** (parchment/ink-soot — Vespergate-friendly) — Amsterdam
   17th c.: concentric canal ARCS around the generation center crossed by
   radials; the canals emit as water features (they feed the constraint
   system: bridges where radials cross, quays along banks — the citynet
   machinery for this already exists); elongated blocks between rings;
   calibration anchor ≈195 intersections/km². Highest-charm preset for
   harbor/canal cities.
8. **`radial-star`** (parchment/modern-clean) — Paris Étoile / baroque star:
   avenues radiating from a rond-point (the region center or a landmark),
   concentric connector rings, wedge blocks subdividing toward the rim;
   calibration anchor ≈133 intersections/km². Distinct from `baroque-axial`
   (which composes a few axes through organic fabric; this IS the fabric).
9. **`na-grid` upgrade — seam boulevards** (San Francisco / Lower Manhattan
   reading): the existing per-quadrant azimuth collisions currently just jog;
   promote the collision seam into a wide diagonal boulevard (Market Street) —
   the seam becomes a feature instead of an artifact. Additive param
   (`seamBoulevard`, default off).
10. **`euro-medieval` upgrade — growth rings** (param `rings: 1|2`, default 1 =
   today's behavior per the additive-params rule): a second, older inner wall;
   inner fabric denser/finer grain; radial streets sprouting outside the inner
   gates toward the outer ring (the Paris Châtelet reading).

## 3. Pipeline improvements (the "consider how city procgen might be improved" half)

### 3.1 Metrics module + benchmark gates — the big one
New pure `src/gen/citynet/metrics.ts`:
`computeNetworkMetrics(features, region) → { intersectionsPerKm2, streetKmPerKm2,
streetLandShare, widthHistogram (<10 / 10–20 / >20 m), blockGrainP50,
avenueShare, deadEndShare, permeability (link/node ratio) }`.
- **Per-preset benchmark ranges become unit gates** (from §1.2): euro-medieval
  grain 40–120 m + intersections high + widths mostly narrow; superblock
  intersections ~10–15/km² + deadEndShare high (asserting the anti-pattern IS
  produced); tartan-grid highest intersection density; land share 20–30% for
  all walkable presets. This converts a chunk of the docs/04 screenshot test
  from vibes into numbers — the single highest-leverage improvement in this
  plan, and it hardens every FUTURE preset too.
- Also exposed on the debug/test API for gates and the explainer.

### 3.2 Axial-breakthrough operator (shared by haussmann + baroque-axial)
A deterministic post-pass on the grown network: choose target pairs
(gate↔plaza, plaza↔landmark — position-keyed choice), cut a straight (or
one-elbow) corridor of width W, splice the boulevard into the planar graph,
re-close the faces it crosses (blocks re-derive; parcels along the cut re-split
with frontage flipped to the boulevard). Determinism: the cut happens INSIDE
`generateCityNetwork` before faces/parcels (stage order fixed), so blocks/
parcels/footprints are computed once against the final graph — no reflow pass.

### 3.3 Form-based width system
Emit an explicit `width` (meters) property on every street feature (today:
`roadClass` only); profiles carry a width table + target distribution
(narrow-majority per §1.2). Themes map width→px with a shared ramp
(generatedLayers already ramps on roadClass; widen to width-driven). Avenue
differentiation (Manhattan §1.2) = width + straightness + length together, not
just paint. **Additive-params rule applies:** existing profiles' emitted
geometry must not change — width property defaults derive from current
roadClass mapping so bytes only gain a property (cache version note: adding a
property CHANGES cached bytes — this ships as a regenerate-on-upgrade minor
version with a DECISIONS entry, same precedent as the v3→v4 migration).

### 3.4 Smaller, cheap wins
- **Chamfer operator** (eixample): clip block corners at plaza-facing angles in
  faces.ts output — pure geometry, reusable as a "corner treatment" param.
- **Curve/straight balance knob**: `curviness` param on grid presets (short
  curved connectors as place-character, bounded per §1.3's anti-pattern
  warning).
- **Permeability floor**: growth accepts alley candidates that RAISE the
  link/node ratio in low-permeability pockets (metrics-guided, still
  budget-bounded — D3).
- **Perimeter-block assertion**: % of block perimeter fronted by parcels
  (frontage discipline already exists; make it a measured gate).
- **`towpath` river option** (with plan 022 rivers): canal-side pedestrian
  path + perpendicular laterals (Kyoto/Venice §1.3) — one param, big charm.

## 3.5 The preset gallery map (Jonah 2026-07-12 — required deliverable)

A dedicated dev-vault campaign (`Campaigns/Preset Gallery/`, fictional CRS,
default theme) whose ONLY content is one sketched district per city preset,
laid out on a spaced grid so every city renders in isolation:

- All districts are the SAME shape and size (a regular polygon, effective
  radius ~700 m) so styles compare apples-to-apples — differences on screen
  are the preset, never the boundary. Name each district feature after its
  preset (`gallery: haussmann`, …).
- A gate script (`scripts/gates/presetGallery.ts`) regenerates the whole
  gallery, then produces per-preset screenshots at a FIXED zoom + one overview
  contact-sheet screenshot of the full gallery grid, all into `review/gallery/`
  (overwrite in place — the folder is the living style catalog).
- The same gate runs the §3.1 metrics per preset and prints a comparison table
  against the §1.2 calibration anchors — the numeric and visual reviews come
  from one artifact.
- Every phase in §4 that adds or changes a preset MUST re-run the gallery gate
  and include the refreshed contact sheet in its review notes; Jonah calibrates
  taste from `review/gallery/`, and diffs of the gallery become the visual
  regression story for city procgen (determinism means an unchanged preset's
  gallery city must not change AT ALL between runs — assert byte-stability for
  untouched presets).
- The gallery campaign is a committed fixture: its `Fabric.geojson` (district
  shapes + procgen blocks) is durable repo content; its `.mapcache/` is not.

## 4. Sequencing (after plan 022 phase 1 lands the preset mechanism)
1. **Metrics module + benchmark gates for the four EXISTING profiles** (pure,
   no visual change, immediately hardens everything else) **+ the §3.5 preset
   gallery campaign and gate, seeded with the four existing presets** — the
   gallery exists BEFORE any new preset so each addition lands with a
   before/after contact sheet.
2. Width system (3.3) + superblock preset (data-only, no new operator).
3. Tartan-grid + ward-grid + eixample (+ chamfer operator).
4. Axial-breakthrough operator → haussmann + baroque-axial presets.
5. euro-medieval growth rings; curve knob; permeability floor; towpath.

Each phase: unit gates (determinism, seams, containment, metrics benchmarks,
preset fuzz) + live gate + screenshots per docs/06. The §0 protocol of plan 022
applies verbatim — including the board cadence (Jonah 2026-07-13): per-phase
commits gate on T1 (fast suite + tsc + build + the phase's own live gate
standalone); this plan's ONE full board runs at 25-E with the refreshed
gallery contact sheet. Never run `board`/`board --changed` per phase.

## 5. Open questions
1. Should benchmark gates HARD-fail or warn? Proposal: hard-fail for the
   invariant-ish ones (containment, determinism), warn-and-screenshot for
   distribution ranges (they encode taste; Jonah calibrates from review/).
2. Preset count vs. modal dropdown ergonomics — 10+ city presets wants grouped
   options or preview thumbnails in RegionProcgenModal (UX ruling for Jonah
   when the list grows past ~8).
3. Superblock + cascade: its arterial canyons should probably suppress
   plan-022 farmland/forest inside the region — same raw-sketch mechanism,
   decide when both exist.
