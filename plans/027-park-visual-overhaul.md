# Plan 027 — Park visual overhaul: figure-ground, entrances, real skeletons

**Status:** research/design DONE (2026-07-13, Opus research judged by Fable
orchestrator). Fixes plan 022 §3.3's shipped park (commit ab320f4, v4.7).
**Depends on:** 022 complete for phases A–B; **23-C marching squares** for
phase C; **026-C's `treeGlyphs.ts`** for the phase-C stipple upgrade (run 026
first). **Execution slot (recommended):** as a block with 026 between 023 and
024. See §7 for the parallelization ruling.

## 0. Context for a cold-start implementer

**What's broken (diagnosed against `review/v4.7-park-*.png`):** the park reads
as "a green square with graph-paper texture." Root causes:
1. **Ground** = jittered 22 m cell lattice (`src/gen/park.ts`) → antialiasing
   hairline grid over the ENTIRE region (same defect as forest, worse because
   the park is one contiguous field of cells).
2. **No figure-ground.** One green everywhere. From above, a park is legible
   as LAWN vs CANOPY — two greens (Central Park = big lawns against wooded
   blocks; OSM Carto encodes it as park `#c8facc` vs wood `#add19e`). We have
   no canopy masses at all — only invisible 1.8 px tree dots.
3. **Paths connect to nothing.** Real park paths hang off ENTRANCES on the
   boundary (streets/gates), then a perimeter loop + curvilinear diagonals.
   Ours float around an interior pole; at map scale they're hairline
   scratches (3–3.5 m quads with no casing/contrast).
4. **Dressing is illegible:** beds are barely-different rectangles, the pond
   is a flat blob, a bridge is a 1-px stick, rocks/specimen trees invisible.

**Binding constraints:** identical to plan 026 §0 (determinism D1–D6,
edit-locality with the procgen46-style gate, NO zoom gates, pure headless
generators, themes own paint, Surface-Pro 60 fps, Vespergate byte-intact).
The `interiorPole` anchor and the graceful-degradation ladder
(court ≥200 → island ≥130 → pond ≥25) survive this plan.

**Research digest (key findings + sources):**
- **Figure-ground is the #1 fix**: two greens, lawn vs canopy (Central Park
  Conservancy landscape inventory; OSM Carto `landcover.mss` hexes — anchor
  the CONTRAST RELATIONSHIP per theme, not the literal hexes).
- **Entrances + desire lines**: paths are near-shortest routes between
  boundary entrances (Wikipedia desire-path; Helbing's ~20–30% deviation
  threshold); Olmsted's operational principles — curvilinear paths ("what is
  coming is constantly new"; every Central Park path but the Mall curves),
  separation of ways (main loop vs footpaths as distinct classes), unified
  composition (few strong moves, no clutter) (NPS Olmsted design principles).
- **Formal garden signature** = bilateral axial symmetry: dominant axis +
  cross-axis, central basin, mirror-symmetric parterre compartments (broderie
  beds = distinct fill + inset hedge outline), flanking bosquet tree-blocks
  (min. quincunx), optional patte d'oie 3-avenue fan (Wikipedia Parterre /
  French formal garden / Bosquet; Versailles Grande Perspective).
- **Japanese strolling garden** = ONE winding circuit around an irregular
  central pond (symmetry forbidden), miegakure hide-and-reveal curvature,
  islands, a REAL bridge over a pond neck (arched or zigzag yatsuhashi),
  stone lanterns at junctions/water edges, Sakuteiki rock rules (groups of
  three, horizontal-dominant, odd counts, "running-away" stones get "chasing"
  stones), teahouse with stepping-stone roji spur (Sakuteiki; NAJGA stroll
  garden; Ketchell on miegakure).
- **Wild-common / village green** = low structure BY DESIGN: open rough
  grass, sparse edge trees, a duck pond, ONE landmark point (memorial/
  maypole/cricket square), minimal desire-line crossings (Wikipedia village
  green).
- **Sports pitches read instantly** as correctly-proportioned rectangles
  (football 105×68 m, tennis 24×8 m, basketball 29×15 m).
- **Rendering hierarchy** (professional maps draw ONLY what reads): ground
  green, darker canopy, cased paths, water with shore casing, a few icons.
  Individual shrubs/benches never. Path rendering = casing line under +
  lighter fill line over.
- **Flagged by research as unconfirmed/invented:** no garden-specific
  procedural prior art exists (recipes here synthesize design theory);
  patte d'oie numeric proportions unknown (tunable 30–45° fan).
- MapLibre facts (verified in the forest rounds): merged polygons kill
  hairlines; symbol layers cheap with overlap+ignore-placement;
  `viewport-y` z-order; SDF single-tint + halo; canvas rasters via
  `addImage`/`updateImage`; all opacity/size/width paint props
  zoom-interpolable.

**Infra pitfalls:** plan 022 §0's list applies verbatim.

## 1. Layer model (generator emits; themes paint)

| generatorId | geometry | notes |
|---|---|---|
| `park-lawn` | ONE polygon = the region ring | replaces the cell lattice entirely; `meadow: true` for wild-common (rougher tone) |
| `park-canopy` | organic polygons (clumps + perimeter belt) | the second green; phase B uses `harmonicBlobRing` unions, phase C upgrades to marching squares |
| `park-path` | **LineString** per path, `class: "loop"\|"walk"\|"axis"\|"circuit"\|"roji"` | replaces spanQuad chains; theme renders casing+fill line pair, round joins fix the notch problem for free |
| `park-water` | organic polygon (+ island polygons) | shore casing line in theme |
| `park-bridge` | small deck polygon across a pond neck | `style: "arch"\|"zigzag"` for japanese |
| `park-bed` | polygons w/ `bedKind: "broderie"\|"border"` | distinct fill + inset hedge outline line |
| `park-court`/`park-plaza`/`park-pitch` | polygons | pitch carries `sport` + true proportions |
| `park-point` | points, `pointKind: "fountain"\|"bandstand"\|"monument"\|"lantern"\|"teahouse"\|"playground"` | theme icons (symbol layer) |
| `park-rock` | points w/ `sizeN`, grouped odd counts | Sakuteiki placement |
| `park-tree` | points w/ `sizeN`/`rank`/`variant` | same schema as forest trees → shares 026's glyph pipeline |

Old ids `park-lawn`(cells)/`park-bed`(cells) are superseded; regen replaces
caches wholesale (delete-`.mapcache`-harmless rule makes this safe). Keep zod
schema additive where params are concerned (022 §1 rule): `variety`,
`pathDensity`, `pond` keep their meanings.

## 2. Skeletons per variety

- **Entrances (all varieties):** boundary points where sketched road/spine
  fabric passes within a threshold of the ring (constraints already flow into
  generators — `GenerationConstraints`; sketched fabric only, NOT generated
  city streets — that wiring is 024's cascade); fallback = convex corners +
  hashed midpoints, 2–5 total. Entrance positions hash from (seed, boundary
  arc-position) → edit-local.
- **city-park:** perimeter loop inset from the ring (offset polyline of the
  ring, smoothed); curvilinear diagonals between entrance pairs — straight
  baseline warped by low-freq noise (Olmsted curves), skip pairs whose line
  exits the ring; classes: loop = "loop", diagonals = "walk". Pond optional
  (param), 0–2 canopy clumps + perimeter belt segments, pitch/playground
  rectangles when the region affords them (reuse the degradation-ladder
  pattern), bandstand point near the pole.
- **formal-garden:** dominant axis = longest-inertia axis of the ring
  (stable under small edits; hash-tiebreak), cross-axis at the basin node;
  mirror-symmetric recursive subdivision (2–3 levels, cuts snapped to
  symmetric fractions) → broderie compartments near the "entrance" end,
  bosquet blocks in outer cells; central circular basin (`park-water` +
  fountain point); optional patte d'oie fan from the far axis node
  (`pathDensity` scales arm count). Ground note: formal inverts figure-ground
  — lawn polygon carries `formal: true` so themes paint it gravel-buff, beds
  dominate.
- **wild-common:** 1–2 desire-line crossings between entrances, meadow lawn,
  sparse edge trees (026 sampler, low density), duck pond (small, irregular),
  ONE monument/maypole point near the pole. Restraint is the signature.
- **japanese-garden:** keep pond-anchor + ladder; circuit = closed path
  around the pond at varying hashed offset with strong warp (miegakure — the
  pond must not be fully visible from one "side"); bridge deck over the
  narrowest neck the circuit crosses; lanterns at circuit inflections +
  2 water-edge points; rocks in 3/5-count groups, horizontal-dominant
  (`sizeN` wide>tall), placed at circuit viewpoints; teahouse point + roji
  stepping-stone spur (short dashed-class path); karesansui court keeps its
  ≥200 m rung, gains a raked-line texture treatment in themes (phase C).

All geometry keys on (seed, interiorPole, boundary arc-positions, absolute
world position) — no emission-order dependence anywhere.

## 3. Paint
Two-green figure-ground per theme (lawn lighter, canopy = `fabricForest`
family); cased paths (darker casing line under a lighter fill line, widths
zoom-interpolated, `class`-differentiated); water + 1 px shore casing; beds
distinct fill + hedge outline; pitch outline + tinted fill; icons for
`park-point` kinds (SDF, tinted per theme); rocks/trees via 026's glyph
layers (shared `treeGlyphs.ts`). Rank/opacity zoom ramps as in 026 §1.3 —
never zoom gates.

## 4. Phases

### 27-A — Ground + figure-ground + path rendering (no new skeleton yet)
`park.ts`: lawn → single ring polygon; beds keep geometry but gain outlines;
existing paths re-emitted as LineStrings (same centerlines); canopy clumps
added via `harmonicBlobRing` unions around hashed interior points.
`generatedLayers.ts`: two-green + cased path line layers + water shore casing
+ bigger, varied rocks/trees (026-A circle treatment if 026-A already landed;
else minimal size/color bump). Snapshots updated deliberately. Live gate
(procgen48): containment/determinism/edit-locality + paint probes + z4.5 and
close screenshots eyeballed. **Gate: T1.**

### 27-B — Skeleton rewrite (entrances, per-variety structure)
§2 in full. Fuzz: containment under 200 hashed rings × 4 varieties; entrance
edit-locality (moving a far vertex leaves near-side entrances/paths
byte-identical). Headless lifecycle tests on the 21-C harness; live gate
extends procgen48 (entrance-connects assertion: every path endpoint on ring
or another path; formal symmetry assertion: mirrored features match within
quantization). **Gate: T1.**

### 27-C — Organic water/canopy + glyph dressing (REQUIRES 23-C + 026-C)
Pond/canopy upgrade to domain-warped marching squares + Chaikin (shared
module with 026-B); trees/rocks/icons onto the 026 symbol pipeline;
karesansui texture; bridge arch/zigzag styling. Perf on throttled CPU with a
city + 2 parks + forest visible. **Gate: T1 + refreshed park screenshots for
review/.** (Board: Jonah 2026-07-13 — ONE board covers plans 026+027+028, at
28-C.)

## 5. Out of scope
Park↔city street continuity (024 cascade: city streets terminating AT park
entrances is the flagship 024 demo — this plan only consumes SKETCHED roads);
benches/microdetail; seasonal variation; editing generated features (locked).

## 6. Acceptance
Side-by-side screenshots of the four varieties: each identifiable in 3 s;
no lattice anywhere; paths visibly connect to the boundary and read as a web
(city), an axis composition (formal), one circuit (japanese), near-absence
(common); pond shorelines irregular; bridge legible; formal garden
bilaterally symmetric at a glance; z4.5 overview stays clean (no clutter,
no voids); determinism/edit-locality/seam gates green; `rm .mapcache`
regenerates byte-identically; Vespergate byte-intact.

## 7. Scheduling / parallelization ruling (2026-07-13)
Same ruling as plan 026 §6: **no concurrent execution with the in-flight
arc** (`generatedLayers.ts`/`tokens.ts`/`registry.ts` collide with 22-E/F;
dirty-tree wake protocol; board fixture invalidation). Additional ordering:
27-A/27-B may run any time after 22-F's board; 27-C needs 23-C AND 026-C
(shared glyph + marching-squares modules — build once in 026, reuse here).
Recommended block: 023 → **026 → 027** → 024, so 024's cascade lands on
final park/forest schemas and its park-entrance demo consumes 27-B's
entrance model.
