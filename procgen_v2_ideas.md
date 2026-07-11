# Procgen v2: from street *texture* to street *network*

*Ideas for the next generation of city procgen, July 2026. Grounded in the
current implementation (see `procgen_explainer.md`), Martin Evans's
[Procedural Generation For Dummies](https://martindevans.me/game-development/2015/12/11/Procedural-Generation-For-Dummies/)
series, Watabou's MFCG (esp. the
[0.10.0-alpha explainer](https://www.patreon.com/watawatabou/posts/medieval-fantasy-87882877)),
and the papers both build on (Parish & Müller 2001; Chen/Wonka 2008;
Vanegas/Aliaga parcel subdivision 2012). Everything here respects the locked
decisions: pure `(seed, bbox, constraints) → Feature[]`, position-keyed
determinism, order-free seam safety, explicit-only generation, fabric never
promotes, themes own paint.*

*Structure: §1 diagnosis → §2 v2 ideas (field-based) → §5 a harsh critique of
v2 against the bar "could this pass for a European/North American town?"
(answer: no) → §6–7 the v3 plan that clears it. Read §5 before investing in
§2.1/2.4.*

---

## 1. Diagnosis: why the current output reads as fur, not city

Look at the Vespergate screenshot. The three failures are structural, not
tuning problems:

**F1 — Streets never connect.** Each streamline is an independent trace:
seeded every 60 m, ≤96 m per side, terminated only by step count or barriers.
There are no junctions, no T-intersections, no loops — by design, because the
classic dsep/collision termination (Chen 2008, Evans's implementation) is
*order-dependent* and would break seams. The result is thousands of parallel
combed hairs. A road network's defining property is that it is a **connected
planar graph**; ours is a **line texture**. This is the single biggest gap.

**F2 — Blocks and streets don't know about each other.** Districts are a
Voronoi over their own seed grid; blocks are axis-aligned bisections of
district polygons; footprints are axis-aligned rectangles. Streets flow *over*
this, unrelated. In every convincing generator — growth-based (Parish&Müller),
field-based (Wonka), or block-centric (Watabou) — **blocks are the space
between streets and buildings face the street**. Ours are three unrelated
tilings stacked in z-order.

**F3 — The city has no shape.** Uniform seed density means uniform fur to the
tile edge: no dense core, no thinning outskirts, no edge where city becomes
countryside. Watabou spends real effort on exactly this ("outskirts filtering
to make city outskirts look less urbanized", walls because they "make a pile
of polygons look like a city").

The literature offers two families of fixes, and both are usable — but each
has to be re-derived in order-free form:

- **Growth systems** (Parish & Müller; Evans's roads post): priority queue of
  candidate segments, local constraints snap ends into T-junctions and
  cross-junctions. Beautiful connectivity, **globally sequential** — rejected
  as-is, but the *snapping idea* survives (idea 2.4).
- **Block-centric** (Watabou): don't grow roads at all; partition space into
  patches/wards, and the streets *are* the patch boundaries. Connectivity is
  free — the edges of a planar partition are inherently a connected graph.
  This maps almost perfectly onto machinery we already have (idea 2.2).
- Plus one family neither source uses, which fits our constraints better than
  either: **streets as level sets of a scalar field** (idea 2.1).

---

## 2. The ideas

### 2.1 ⭐ Iso-line streets: trace level sets, not streamlines

Replace independent streamline traces with **contours of two scalar potential
fields**. Define `u(x,y)` and `v(x,y)` — pure functions of world coordinates —
whose gradients follow the tensor field's minor/major eigenvectors, and emit
streets as the level sets `u = k·spacing` and `v = k·spacing` for integer `k`.

Why this is the headline idea:

- **Connectivity for free.** A level set is a continuous curve by definition —
  no 96 m fragments. The u-family and v-family *cross each other*, producing
  real four-way junctions everywhere, the woven grid look of Wonka's results.
- **Even spacing for free.** Contours at `k·spacing` can't bunch or gap — this
  is the density control that dsep termination provides in the sequential
  algorithms, recovered without any ordering.
- **Seam safety is trivial.** Extract contours by marching squares over a
  sample grid **anchored to the world origin** (same trick as
  `spatialHash.ts`): every tile evaluates the identical pure function on the
  identical global lattice, so contour vertices on a shared edge match to the
  bit. Halo = one sample cell.
- **Determinism is structural.** No seeds at all for the base network — the
  entire street net is a function of `(campaignSeed → field params, position)`.

Construction of `u,v`: our field is already a closed-form sum of one grid
basis + 2–3 radial singularities, and each basis has a closed-form potential —
grid: `u = x·cosθ + y·sinθ`, `v = −x·sinθ + y·cosθ`; radial at c: `u = log‖p−c‖`
(concentric rings), `v = atan2` azimuth (spokes, with the usual branch-cut
handled by contouring `sin/cos` of it). Blend potentials with the same
distance-decay weights the tensor sum uses today. The blend's gradients only
*approximate* the blended tensor field — accept that; the payoff (connected,
evenly spaced, seam-safe) dwarfs the fidelity loss, and around each
singularity you get exactly Watabou's plaza-with-radiating-streets look.
Cheaper fallback if potentials feel heavy: **domain-warped grid** — streets
are the grid lines of a coordinate system warped by a seeded noise field
(warp is a pure function of position; contour `frac(u') − 0.5`). Less faithful
to the tensor field, same connectivity/seam properties.

Existing constraint wiring ports cleanly: rivers/water/walls still truncate
contour polylines (`truncateAtBarriers` unchanged); sketched roads blend into
the potentials the same way the corridor basis blends into the tensor field.

*Replaces:* `streamlines.ts` tracing for the base net (RK4 machinery stays for
corridor elaboration). *Keeps:* `tensorField.ts` params, all of
`fabricConstraints.ts`, clip, cache.

### 2.2 ⭐ Blocks are the space between streets (Watabou's move, our Voronoi)

Watabou's generator is block-centric: patches are cut into city blocks and
**the cuts become the streets**. His 0.10.0-alpha diagnosis of its weakness
reads like a review of our districts layer: "this original cells are clearly
visible on the map. There are no long roads running through a whole district,
every street is contained within its patch." His fix — merge patches and
build streets district-wide with **twisted bisection**, recursive cuts that
propagate the *outer shape's* edge orientation inward — makes "cells almost
invisible and often there is an illusion of streets following some kind of
underlying landscape. There is no underlying landscape of course." Our version
of the same insight, in two steps:

1. **Street-aligned subdivision.** Stop bisecting blocks along the world axes.
   `subdivide()` already hashes the split ratio to the recursion path; make the
   split *line* follow `sampleFieldAngle(field, centroid)` (and its
   perpendicular) instead of the bbox axes. This is twisted bisection with a
   better twist source: Watabou propagates the parent polygon's shape inward
   and admits his implementation "for complex concave shapes often produces
   far from perfect results… collapsed or intersecting edges can easily break
   it completely" (hangs, empty wards). Sampling a smooth global field at the
   centroid buys the same landscape-following look with none of the concave
   fragility — and unlike his, we *do* have an underlying landscape (the
   field, the corridor blends, the sketched roads), so the illusion is honest.
   Still a pure function of the polygon's own vertices + seed — the no-halo
   argument in `blocks.ts` survives untouched. (His instability postmortem is
   also a warning worth keeping: the refactor to district-wide state is what
   destabilized his generator; our per-tile purity + seeded snapshot tests are
   exactly the guardrails that failure mode calls for.)
2. **Blocks from the street graph.** With 2.1's iso-lines, the plane is
   *already* partitioned: a block is the cell between adjacent u-contours and
   adjacent v-contours, i.e. the region `⌊u/s⌋ = i, ⌊v/s⌋ = j`. Blocks get an
   identity `(i,j)` — position-keyed, seam-safe, no Voronoi needed at block
   scale — and are guaranteed to sit *between* streets, never straddling one.
   District Voronoi survives at its own scale as the **ward layer** (see 2.6),
   not as the block parent.

Then upgrade footprints per Evans's
[lot subdivision](https://martindevans.me/game-development/2015/12/27/Procedural-Generation-For-Dummies-Lots/):
**OBB parcelling** — fit the oriented bounding box, slice across the short
axis, recurse with seeded ratios, stop on his four rules (min area, max aspect
ratio, frontage, access-to-street) each with a hashed violation chance.
Footprints become inset *parcels of the actual block polygon* (row-houses
shoulder to shoulder along the frontage, courtyard gaps behind) instead of one
floating axis-aligned rectangle per block. All recursion-path-keyed, zero new
seam surface.

### 2.3 ⭐ A cityness field: density, hierarchy, and an edge

One new pure scalar field, `cityness(x,y) ∈ [0,1]`, built like `heightAt`:
distance-decay from the field's radial singularities **plus a contribution
from the GM's own Locations** (see 2.5), times low-frequency noise. Everything
downstream modulates on it:

- **Street spacing** widens as cityness falls (iso-line spacing `s/cityness`,
  or simply drop contour lines whose per-segment midpoint hashes above the
  local density — dangling ends at the city edge are *desirable* there).
- **Hierarchy:** emit `roadClass` by construction — every Nth contour of the
  coarse spacing is an `avenue`, the rest are `street`, sub-spacing lines in
  high-cityness cores are `alley` (Watabou 0.9.0's alleys). Themes already own
  paint, so this is one enum property; line-width interpolation does the LOD.
- **Block grain:** subdivision depth and parcel min-area scale with cityness —
  tight medieval warren downtown, loose plots at the fringe.
- **The edge:** Watabou's outskirts rule, verbatim from the 0.10.0 post: "the
  generator decreases the density of *streets* there, while keeping the
  density of *buildings along those streets* relatively high." So: below a
  cityness threshold, drop most contour lines but keep footprints hugging the
  surviving roads (ribbon development — historically right and visually
  unmistakable), then farmhouses and Watabou-style **field/farm polygons**
  (jittered quads aligned to the nearest road contour) so the city visibly
  *ends* — the screenshot's "fur to the horizon" becomes town, outskirts,
  countryside.

This directly answers quality-bar F3 ("no blank voids" has a mirror failure:
no *undifferentiated* fill either) and makes "genre identifiable in 3 s"
easier — density shape is most of what makes a city map read as a city.

### 2.4 Junction snapping on a shared lattice (the order-free T-junction)

Where street ends *do* exist (contour lines truncated by rivers/walls, corridor
traces, dropped-density fringes), recover Parish & Müller's local-constraint
polish without ordering: quantize every dangling endpoint to a **world-anchored
junction lattice** (cell ≈ 12 m); if two polylines' endpoints hash to the same
junction cell, both snap to the cell's jittered canonical point. Each snap is a
pure function of `(campaignSeed, cellX, cellY)` — two tiles computing the same
endpoint snap it identically. This turns "two streets almost meeting" (Evans's
explicit local-constraint case) into a T-junction with zero sequential state.

### 2.5 The city grows around the GM's pins

Today `canonFeatures` only *repel* (seeds too close to a Location are
dropped). Invert the relationship: Locations are **attractors**. Locations
inside the constraint set contribute radial bases to the tensor/potential
field and bumps to the cityness field — hashed by their *position*, so the
result is still a pure function of inputs (constraints are inputs; same seed +
same constraints = same output, exactly the existing contract, and the
existing sketch-triggered auto-regen already re-runs affected tiles when canon
changes). Result: generate fabric near Vespergate Keep and the streets
*converge on the Keep*, the docks get a dense waterfront grain, and the map
narrates what the GM already authored. This is the most "yes-and" idea in the
list — the generator amplifies the GM's hand instead of texturing around it.
Keep a small clear radius so geometry still never overlaps the pin.

### 2.6 Wards, walls, gates, plazas (the Watabou dressing)

- **Wards:** keep the district Voronoi but make it *mean* something: tag each
  kept cell with a ward type (market/craft/temple/gate/slum…) hashed from its
  site + biased by cityness and waterfront adjacency — Watabou's insight that
  labels are flavor mixtures, not zoning. Feeds naming (`naming/` already
  exists) and lets themes tint wards subtly. Districts stop being invisible
  geometry and start being *content*.
- **Plazas:** at each radial singularity above a cityness threshold, emit a
  plaza polygon (the innermost contour ring of 2.1 is literally already a
  ring around it) — unnamed fabric, never a Location; naming stays the GM's.
- **Walls + gates:** optional flag on the generate request: wall = a chosen
  **iso-contour of the cityness field** (level sets are seam-safe by 2.1's
  argument, and a contour of a smooth field gives Watabou's "smoothed wall"
  look for free), gates = points where `avenue`-class contours cross it, gate
  wards just inside. Sketched walls already truncate streets; generated walls
  reuse the same fabric type so themes and constraints treat them uniformly.
- **Bridges:** where an `avenue` contour is truncated by a sketched river,
  check the opposite bank within a hashed distance; if the same contour
  continues, emit a bridge segment joining them — pure function of the
  contour + river geometry, both already tile-independent inputs.

### 2.7 Make the LOD story explicit (Evans's L-system framing)

Evans structures his whole generator as an L-system: City → roads/blocks →
lots → buildings → floors, each stage only refining the last. We have the
same shape hiding in `city-street → city-district → city-block →
city-footprint` but the stages don't consume each other's output. V2 should
make the chain real *and cheap*: streets (2.1) define blocks (2.2) define
parcels define footprints, each stage keyed to the parent's position-derived
identity (`(i,j)` block ids, recursion paths). Because every stage is pure and
position-keyed, per-stage caching keeps working (`generatorId` per stage,
exactly as today), and a future `city-interior` stage (floorplans for a
tavern the party barges into — Evans's rooms level) slots onto the end
without touching anything upstream.

---

## 3. Suggested build order *(superseded — see the critique in §5 and the revised plan in §6–7)*

| Phase | What ships | Kills |
|---|---|---|
| v2.0 | 2.1 iso-line streets (+ port barrier truncation) | F1 — the fur |
| v2.1 | 2.2 blocks-between-streets + oriented OBB parcels | F2 — misaligned blocks |
| v2.2 | 2.3 cityness field: spacing, roadClass, grain, edge | F3 — shapeless city |
| v2.3 | 2.5 Location attractors + 2.4 junction snapping | "generator ignores my campaign" |
| v2.4 | 2.6 wards/walls/gates/plazas/bridges | flavor gap vs Watabou |
| later | 2.7 interiors stage | — |

Each phase is independently shippable and independently testable; nothing
requires schema changes to the manifest, cache, or fabric model (2.6's wall
flag adds one optional field to the generate request).

## 4. New tests the ideas demand

- **Contour seam gate:** 2×2 tiles, assert u/v contour vertices on shared
  edges are bit-identical (extends the existing seam test; marching-squares
  lattice must be world-anchored — this is the one new way to break seams).
- **Connectivity metric:** graph-ify a tile's streets; assert
  `dangling endpoints / total endpoints` under a threshold in high-cityness
  areas (the fur would score ~1.0; a network should score < 0.15) — a
  *quantified* screenshot test.
- **Alignment metric:** mean angular deviation between parcel long-axis and
  nearest street tangent — asserts 2.2 actually took.
- **Attractor determinism:** same seed, same Locations → identical output;
  moved Location → changed output *only* within its influence radius.
- Snapshot fixtures per phase as today; determinism release-blocker unchanged
  (delete `.mapcache/`, regenerate, byte-diff).

## 5. Harsh critique: would v2 pass for a European or North American city? **No.**

Hold the §2 ideas against the actual bar — "could this be mistaken for a real
town?" — and most of them flatter the current system more than they fix it.

**5.1 Iso-line streets are graph paper, warped.** Two contour families
crossing each other produce a network where *every* junction is a 4-way
crossing and *every* block is a quadrilateral of near-uniform size. Real
street networks are nothing like this. Empirically, European towns are
dominated by **T-junctions** (organic growth: a new street ends *on* an
existing one; it almost never punches through), block shapes are wildly
irregular (triangles, wedges, 5–7-gons), and block size varies by an order of
magnitude within a district. A two-family level-set system **cannot produce a
T-junction** except by accident at a truncation. It can only produce Wonka's
demo look — which reads as "planned modern downtown" at best, i.e. a fraction
of NA and almost nothing of Europe. v2.0 kills the fur and replaces it with
a curvilinear Manhattan, everywhere, in every genre.

**5.2 The blended potentials are mathematically worse than admitted.** §2.1
hand-waves "the blend's gradients only approximate the field". The real
problems: level sets of a *sum* of potentials develop *saddle points* and
**closed loops around local extrema** — ring streets encircling nothing, in
the middle of a district; `log r` contours are exponentially spaced (dense
rings at the center, absurd gaps outside); the azimuth branch cut needs
special-casing. Each is patchable; together they mean the "for free" claims
are not free.

**5.3 Junction snapping (2.4) mostly won't fire.** Snap requires two
endpoints to land in the *same* 12 m lattice cell. Endpoints land where
truncation/density decisions put them — uncorrelated with each other — so
most dangling ends stay dangling; and a "T-junction" needs an endpoint to meet
a street *interior*, which a point-lattice snap can't do at all. It's a
polish pass sold as a topology fix.

**5.4 Nothing generates the macro-skeleton of a real town.** What makes a
town instantly legible as European: arterials **radiating from the center to
the neighboring towns** (they exist because of where they go, not because of
a field), a **ring** on the old wall line, streets running **parallel to the
river with bridges continuing across**, the church/market square where
radials meet. v2 has no concept of "roads to somewhere": rivers only *cut*
streets (waterfront grain should *align*, and v2 only aligns to sketched
roads), avenues are "every Nth contour" (a planned-city concept), rings and
radials emerge only near singularities and in the artificial concentric form
of 5.2. And NA is not just grids: the postwar suburb — curving collectors,
loops, **cul-de-sacs** — is half of North America and is *pure growth
topology*; no field/contour method produces it.

**5.5 Blocks-between-contours inherits every street failure.** The `(i,j)`
block identity is elegant exactly where the street net is a clean warped grid
— i.e. exactly where it looks fake. Wherever streets are truncated, dropped
by density, or snapped, the contour cells stop matching the visible streets
and the blocks are wrong again (F2 reborn).

**The root cause, stated plainly:** *organic street topology is a sequential
phenomenon.* Every generator that achieves it — Parish & Müller, Evans,
Watabou — grows the network, each street reacting to the streets that already
exist. The per-tile order-free constraint doesn't just make this hard, it
**forbids the class of algorithms that produce the look**. v2 tries to fake
sequential results with parallel math; the fakes are detectable at a glance.
Order-free field methods remain the right answer for *texture* (density,
grain, orientation) — they are the wrong answer for *topology*.

---

## 6. v3: city-scoped deterministic growth (the plan that clears the bar)

The fix is architectural, and it does not break a single locked decision:
**change the unit of generation from the tile to the city.** Determinism was
never about locality — it's `same inputs = same output`. Tile-locality was a
*means* to seam safety. A bounded city domain achieves seam safety a
different way: every tile that overlaps a city computes (or reads from cache)
**the identical whole-city network** — a pure function of seed + city params +
constraints — and clips its own bbox out of it. This is the existing halo
trick taken to its limit: the explainer already sizes halos so "any feature
that can poke into the tile is fully computed by it"; for a city, the halo
*is* the city. `hash(seed, tileX, tileY, zoom, generatorId)` cache keys,
JSONL cache, manifest replay, worker execution — all unchanged. Inside the
bounded domain, sequential algorithms become legal again, because the whole
sequence is deterministic and every consumer runs all of it.

### 6.0 City domains

A **city domain** = `{center, radius ≤ ~1.5 km, citySeed, genre profile}`.
Center comes from the GM's generate request (and/or a settlement-type
Location — idea 2.5 survives verbatim); `citySeed = hashSeed(campaignSeed,
centerCellX, centerCellY)` — position-keyed, like everything else. The domain
is recorded in the `Generated.json` manifest entry (it's part of the GM's
*request*, exactly where plan 019 says durable intent belongs). Tiles outside
any domain get countryside (fields, hamlet ribbons along routes); the
world-tier `world-route` generator supplies the *destinations* that arterials
grow toward.

### 6.1 Stage A — the skeleton (why the town is shaped like a town)

Deterministic, mostly non-sequential, and the part v2 never had:

1. **Radial arterials:** for each of 3–6 hashed destinations (nearest
   world-routes/map-edge bearings/neighbor settlements), path from center to
   destination through a cost field = terrain slope + water penalty + bridge
   cost (A* on a world-anchored lattice with deterministic tie-breaking — a
   pure function of endpoints + fields). Rivers get crossed at genuinely
   good crossing points, and the road *continues* on the far side: bridges
   for free, where a real town would put them.
2. **Waterfront alignment:** promote river/coast offsets (quay street at
   15–40 m, second street behind) into the street set directly — the
   Watabou-reference look of grain following the bank.
3. **Ring(s):** where genre says so, an offset contour of *network distance
   to center* (not Euclidean — it bulges along arterials, like real rings),
   snapped to arterial crossings; doubles as the wall line (gates = arterial
   crossings, §2.6 survives).
4. **Center:** plaza/market square polygon where arterials converge; the
   church/temple/civic footprint faces it (Watabou's "local churches",
   Evans's special-lots).

### 6.2 Stage B — sequential infill (the European texture, done honestly)

Now run the real thing — Parish & Müller / Evans's growth loop — *inside the
domain*, seeded by `citySeed`, budgeted (fixed max iterations), with the
classic local constraints at last permitted: candidate segments branch off
existing streets biased by the tensor field + cityness; **snap into
T-junctions** when an end lands near an existing street's interior; join
near-miss intersections; reject too-acute angles; prune isolated stubs.
Priority queue ordered by `(priority, candidateId)` with hashed tie-breaking —
bit-reproducible. This single stage is what produces the actual signature of
organic towns: T-junction dominance, irregular block polygons, dead-end
courts, streets that *end on* other streets. Genre profiles are just
parameter bundles on this loop:

| profile | branch angle | curvature | block target | signature |
|---|---|---|---|---|
| `euro-medieval` | loose (±25°) | high | 1–3 k m², irregular | warren + radials + wall |
| `euro-continental` | moderate | low | 3–8 k m² | boulevards, closed blocks |
| `na-grid` | ~90° | ~0 | uniform rect + alleys | jogged grid, numbered streets |
| `na-suburb` | loops | high | superblocks | collectors, **cul-de-sacs** |

(Cul-de-sacs are literally free in a growth system — they're the *unsnapped*
ends — which is why no field method ever has them and every growth method
does.)

### 6.3 Stage C — blocks as graph faces, parcels, buildings

With a real planar graph, blocks stop being guesses: **planarize (all
intersections became nodes in Stage B), extract faces** via half-edge
traversal (Evans's
[half-edge geometry post](https://martindevans.me/game-development/2016/03/30/Procedural-Generation-For-Dummies-Half-Edge-Geometry/)
is the map). Every face is a block that exactly fits its streets — F2 dies
permanently, no `(i,j)` approximation. Then §2.2's parcel plan applies
unchanged (OBB parcelling, frontage/aspect/area rules, straight-skeleton for
long thin edge blocks), buildings inherit street-facing orientation, and the
outskirts ribbon rule (§2.3, Watabou) applies along the Stage A arterials
outside the growth extent.

### 6.4 What survives from v2

Cityness field (density/grain modulation — 2.3), Location attractors (2.5),
wards/walls/gates/plazas (2.6), OBB parcels (2.2 step 2), the L-system stage
framing (2.7), outskirts ribbons. Iso-lines (2.1) survive *only* as the
optional `na-grid` downtown fast path and countryside field-boundaries;
junction lattice snapping (2.4) is subsumed by real snapping in Stage B.

### 6.5 Costs, risks, honesty

- **Perf:** Evans reports 5–10 s per city; Watabou generates whole cities in
  ~a second. Budget: ≤1.5 km radius, capped iterations, worker thread, and
  the result is *computed once and cached* — every later tile in the domain
  clips the cached network. Add a per-domain cache record
  (`generatorId: "city-network"`, keyed to the domain, same JSONL) so tiles
  share it; on miss, any tile can rebuild it deterministically. Cache stays
  disposable; delete-and-regenerate still byte-matches.
- **Stability:** Watabou's 0.10.0 postmortem is the cautionary tale —
  district-wide geometry surfaced collapsing-edge bugs that hang his
  generator. Mitigations: planarization + face extraction are the only
  numerically dangerous parts (use exact-ish predicates, epsilon-free
  orientation tests); fixed iteration budgets mean no unbounded loops;
  seeded snapshot tests per profile; a degenerate face falls back to "no
  block here", never a crash (per-entry salvage philosophy, applied to
  geometry).
- **The invariant audit:** pure headless functions ✓ (A* lattice, PRNG queue
  — no IO, no DOM); explicit-only ✓ (domains exist only via generate
  requests); determinism ✓ (same seed + same constraints + same domain =
  same city, bit-for-bit — the release-blocker test is unchanged); seam
  safety ✓ (adjacent tiles clip the same cached/recomputed network; 2×2 test
  extended with a domain straddling the corner); sketches/locations never
  overwritten ✓ (they enter Stage A/B as constraints: sketched roads become
  pre-existing network edges that growth connects to — *stronger*
  integration than v2's field blend); no promotion ✓; themes own paint ✓
  (`roadClass` now honestly derived: arterial/ring/street/alley/court).
- **What it costs conceptually:** the "any tile alone, in any order" purity
  narrows to "any tile alone *given its domain's params*" — one recorded,
  synced, human-readable input away. That's the entire price of getting the
  real algorithms back, and it's the same trade the manifest already made
  for requests.

## 7. Revised build order

| Phase | What ships | Bar it clears |
|---|---|---|
| v3.0 | City domains + Stage A skeleton (arterials, bridges, waterfront, plaza) | town is *shaped* like a town |
| v3.1 | Stage B growth loop, `euro-medieval` profile first | T-junctions, irregular blocks — the European look |
| v3.2 | Stage C faces → OBB parcels → oriented buildings | blocks/buildings faithful to streets |
| v3.3 | Cityness modulation + outskirts ribbons + walls/gates/wards | edges, hierarchy, flavor |
| v3.4 | `na-grid`, `na-suburb`, `euro-continental` profiles | North America, incl. suburbs |
| later | interiors stage (2.7) | — |

Tests from §4 carry over, plus: **junction-type histogram** (assert
T-junction share > 4-way share for `euro-*` profiles — the single most
diagnostic number for "does it look European"), **block-shape entropy**
(reject all-quads), **arterial reachability** (every arterial reaches its
destination or the domain edge), and the domain-straddling 2×2 seam gate.

## Sources

- [Procedural Generation For Dummies (series index)](https://martindevans.me/game-development/2015/12/11/Procedural-Generation-For-Dummies/) · [Road Generation](https://martindevans.me/game-development/2015/12/11/Procedural-Generation-For-Dummies-Roads/) · [Lot Subdivision](https://martindevans.me/game-development/2015/12/27/Procedural-Generation-For-Dummies-Lots/) · [Half Edge Geometry](https://martindevans.me/game-development/2016/03/30/Procedural-Generation-For-Dummies-Half-Edge-Geometry/) — Martin Evans
- [MFCG 0.10.0-alpha explainer](https://www.patreon.com/watawatabou/posts/medieval-fantasy-87882877) · [0.9.0 alleys & buildings](https://watabou.itch.io/medieval-fantasy-city-generator/devlog/334289/090-new-alleys-and-buildings) · [Some answers and comments](https://watabou.itch.io/medieval-fantasy-city-generator/devlog/1579/some-answers-and-comments) · [Procgen Arcana: City](https://watabou.github.io/city.html) — Oleg Dolya (Watabou)
- [Procedural Modeling of Cities](https://graphics.ethz.ch/Downloads/Publications/Papers/2001/p_Par01.pdf) — Parish & Müller 2001
- [Interactive Procedural Street Modeling](http://www.sci.utah.edu/~chengu/street_sig08/street_project.htm) — Chen, Esch, Wonka, Müller, Zhang 2008
- [Procedural Generation of Parcels in Urban Modeling](https://www.cs.purdue.edu/cgvlab/papers/aliaga/eg2012.pdf) — Vanegas et al. 2012
