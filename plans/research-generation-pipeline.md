# Research report — The generation pipeline: strict order, single forward pass, global terrain

**Status:** research/design proposal (Fable, 2026-07-14), commissioned by Jonah: "a more strict order
of what impacts what, so any single generation after placing or updating something is effectively a
single forwards pass … an update to something later in the order only impacts things after it …
move towards a global terrain system with specific mountain objects rather than just mountain
objects." Synthesized from five parallel research passes (global terrain · hydrology cluster ·
vegetation cluster · settlement cluster · pipeline mechanics) and an adversarial performance
red-team whose findings are woven inline (§3 ground truth, §5 guards, §6 mitigations, §8
preconditions). Builds on plans 020/022–025 (shipped), 029 (policy ratified), 030 (sequencing
ratified).
Nothing here is implemented; this is the design to promote into numbered plans.

---

## 0. TL;DR

1. **The "circles" are real and diagnosable.** Two invalidation channels coexist: the clean plan-024
   DAG cascade, and a stage-blind raw-sketch channel (`regenerateAffectedTiles`) that force-regens
   every region within 200 m of any sketch edit, in *file order*, kind-blind — then a `done`-set
   suppresses the cascade from correcting the ordering. Ten distinct pathologies (§3), including one
   live correctness bug (permanently stale downstream bytes stamped with a *fresh* fingerprint) and
   one silent 4–12× multiplier (a forced regen recomputes the region network once **per tile**).
2. **Unify to one rule.** Fold sketches (and canon pins) into the DAG as source nodes; each algorithm
   declares which sketch *kinds* it reads (`consumesSketch`) with a per-algorithm influence margin;
   every trigger becomes `markDirty(roots) → runForwardPass()` — one dirty-closure, one persistent
   cache view, one fingerprint pass, one (stage,id) walk with fresh upstream threading, batched cache
   writes, staged repaints. Fingerprint-mismatch becomes the *only* staleness rule, shared verbatim
   by live edits and replay. "An edit at stage s never touches stage < s" becomes a theorem with a
   runtime assertion, not a hope.
3. **Reorder the stages to match GM intent.** Hydrology moves *above* terrain: rivers are canon
   strokes; terrain conforms to them (valley/gorge carve keyed on the sketched spine), not the other
   way around. `slopeSensitivity` flips to opt-in (default 0). Farmland moves *below* settlement
   (fields radiate from generated gates/walls); park splits — rural parks stay at vegetation,
   urban parks move below settlement and stop producing vegetation. Final order:
   **sources → hydrology → terrain → vegetation → settlement → peri-urban → detail.**
   Jonah's example holds by construction: a terrain edit reaches farmland (later) and never a river
   (earlier).
4. **Terrain becomes a global system.** One campaign-wide `terrainAt(x,y)` composed in a fixed,
   documented order — `base → add-stamps → replace-stamps → water-carve → site-grading` — where
   mountains (and new plateau/basin/coastline/ridge objects) are *terrain-modifier stamps*: sketch
   polygons/polylines whose durable `(seed, ring, params)` contribute closed-form, point-evaluable
   terms. Literature-backed (Génevaux feature-primitives & hydrology-first terrain; Houdini/Unreal/
   Gaea layer stacks). Contours/hillshade/DEM become lazily-computed, viewport-keyed render leaves
   of the composed field.
5. **Headless-first.** Every pipeline property (dirty-set, ordering, fingerprints, upstream
   threading, run counts, batching) is asserted in Vitest via the MapController+FakeHost harness and
   pure modules — no Obsidian in the loop; live gates shrink to paint/host wiring (aligned with
   plan 030-B).

**Red-team verdict: ship-with-mitigations, with two hard preconditions and one rethink** (findings
woven into §3, §5–§8 below). Preconditions: (1) an under-invalidation property harness must
exist before any consumption-aware invalidation ships (scoped invalidation inverts the failure mode
from "slow but correct" to "silently stale bytes"); (2) a root-only drag-preview mode must land
before the reorder widens the city/river cascades (else the most common edit regresses 5–10×). The
rethink: the `.mapcache` monolith and the whole-map repaint are the proposal's load-bearing floor —
per-region cache sharding and per-stage/diff repaint must be designed in from the start, not
retrofitted ("retrofitting later means re-goldening the world twice").

---

## 1. Building blocks today (the inventory)

**Sketch kinds** (`FABRIC_KINDS`, `src/model/fabric.ts`): lines `road, wall, river`; polygons
`water, district, park, forest, farmland, mountain`. `road` and `water` are **inert** (no algorithm;
constraint-only). Everything else binds to an algorithm via `src/gen/procgen/registry.ts`.

**Algorithms** (registry, plan-024 stages as shipped):

| algorithm | stage | produces | consumes (declared) | actually wired reads (from code) |
|---|---|---|---|---|
| mountain | 0 elevation | elevation | — | nothing (emits massif/hachure/peak/contour) |
| river | 1 hydrology | water | elevation | mountain-sketch elevation field (slope), water sketch (mouth), other river spines (confluence) |
| forest | 2 vegetation | vegetation | water | **nothing** (declared water is inert) |
| park | 2 vegetation | vegetation | water | road sketch (entrances) |
| farmland | 2 vegetation | — | elevation | mountain-sketch elevation field (paddy) |
| city | 3 settlement | settlement | water, vegetation | water/road/wall/farmland sketches + canon pins + routeHints + **generated river channel** (the one wired output edge) |
| wall | 4 detail | detail | settlement | road sketch (gates) — settlement consumption unwired |

**Other blocks:** canon Locations (note-backed pins; constraint to every generator; plan 024 §7.3
proposes stage −1); world tier (`world/heightmap.ts` — frozen; routes feed `routeHints`);
render leaves (contours today per-mountain-region; DEM/hillshade from per-region fields); themes
(paint only, out of scope).

**Two constraint channels today:**
- **Raw sketch** — every generator receives ALL sketches (`fabricConstraints.ts`:
  waterRings/riverLines/roadLines/wallLines/farmlandRings) + the sketch-derived elevation field
  (`elevationFieldFromFabric`). Stage-agnostic. Invalidation: blanket 200 m bbox reach, kind-blind.
- **Generated output** — `constraints.upstream` (plan 024 §3), strictly stage-ascending; only
  `river-channel` → city is wired. Invalidation: DAG closure, correct order.

## 2. The interaction matrix — every connection, enumerated

Legend: **[S]** shipped · **[W]** declared-but-inert, wire it · **[N]** new edge, recommended ·
**[?]** speculative/later · **[✗]** rejected (keep rejected) · currencies: *sketch* (raw geometry;
zoning/land-claim), *field* (terrain scalar derived from durable sketch data), *output* (generated
features via upstream).

### Hydrology
| edge | currency | behavior | verdict |
|---|---|---|---|
| water sketch → river | sketch | mouth classification: estuary flare vs delta arms; confluence snap | [S] keep |
| river → water body | — | never mutate the lake ring; delta/estuary output *overlays* the fill | [✗] |
| river ↔ river (same stage) | sketch spines | confluence Y-gusset today; add deterministic Strahler-ish rank from spine topology → tributary width ≤ main at junction, downstream width step-up, junction-angle nudge. No network artifact, no sub-stages | [S]+[N] |
| river → city | output (channel rings) | bridges/quays (shipped); + bank-tangent street alignment via tensor field, building-only bank setback | [S]+[N] |
| river → city (mouth) | output (`river-mouth` point + flare) | harbor/dock ward bias where a mouth falls in a district | [?] |
| river → forest/park | output (channel SDF) | no canopy/paths in channel (correctness); riparian density ramp ≤ ~4–6 widths; pond placement courts/avoids bank | [W] |
| river → farmland | output (channel rings + bank tangent) | no fields in channel; riverine long-lot strips perpendicular to bank; water-meadow tag | [N] |
| river/water → wall | output + sketch | moat suppressed along banks (river IS the moat); moat ends snap to bank; water-gates where wall crosses channel | [N] |
| terrain → river | field (macro only) | `slopeSensitivity` flips **default 0** (opt-in per river; river v2 bump). A terrain edit leaves default rivers byte-identical | [S→opt-in] |
| river sketch → terrain | sketch (inside the field module — not a DAG edge) | valley/gorge **carve** subtracted from the composed terrain: terrain conforms to the GM's stroke (antecedent river cuts a gorge) | [N] core |

### Terrain consumers
| edge | currency | behavior | verdict |
|---|---|---|---|
| terrain → farmland | field | shipped paddy terraces; + slope-gate fields (steep → untilled/pasture), contour-oriented strips/lanes | [S]+[N] |
| terrain → forest | field | relative-elevation timberline (percentile, never absolute meters), conifer-upslope variety bias, contour-sag canopy | [N] |
| terrain → park | field | pond anchored at local low point when relief exists; nothing else | [N] low |
| terrain → city | field | site grading term (city district flattens toward its persisted center's elevation) — default OFF; steep-ground street cost later | [?] |
| terrain → render leaves | field | contours/hillshade/DEM become viewport-keyed, lazily-computed products of the composed field | [N] core |

### Vegetation / peri-urban / settlement
| edge | currency | behavior | verdict |
|---|---|---|---|
| vegetation → city | output (canopy) | growth-cost bump (streets thin in woods) + parcel rejection in dense canopy | [W] |
| city → forest (clip canopy) | — | never; town reads as clearing via paint order | [✗] keep |
| forest ↔ farmland (same stage) | sketch adjacency, symmetric | shared-boundary hedgerow/woodland-bank; canopy-rim fade; hedging bias. **No sub-stage** — assarting is mutual, faking causality breaks the model | [N] |
| forest ↔ park (same stage) | sketch adjacency | canopy continuity across shared edge | [N] low |
| **city → farmland** | output (gates, arterials, wall line) | **farmland moves to peri-urban (post-settlement)**: lanes/strips radiate from gates, field-size gradient toward the wall. City keeps reading only the farmland *sketch* for outskirt suppression → cycle-free | [N] structural |
| **city → urban-park** | output (streets) | **park splits by variety**: rural varieties stay at vegetation (produce vegetation); an urban-park path moves post-settlement, aligns entrances/axes to generated streets, and **stops producing vegetation** (the one bidirectional trap, closed by rule) | [N] structural |
| farmland/forest sketch → city | sketch | outskirt suppression — permanent design: "**ring = land claim, output = interior dressing**" | [S] keep |
| road sketch → city | sketch | steers street field (shipped); + in-region promotion to arterial w/ frontage; road×ring crossing ⇒ forced gate | [S]+[N] |
| wall sketch → city | sketch | stops streets, suppresses city's own band (shipped) | [S] keep |
| city → wall algorithm | output (`settlement` payload: ring + gates + arterial crossings w/ bearings + canal lines) | gates where generated streets cross the spine (min-spacing merge, class precedence); gatehouse axis = street bearing; moat side = away from town; water-gates at canal crossings | [W] core |
| canon pins → city | canon (typed points; stage −1) | route-around (shipped); `market` pin → plaza snap (params.center precedence); `temple` → forecourt; `gate` → forced gate | [S]+[N] |
| city → locations | — | never (no auto-notes, no canonization); populate-area covers naming on GM request | [✗] keep |
| city ↔ city (same stage) | sketch (shared-edge hash) | adjacent districts derive matching arterial stubs/gates by hashing shared-edge geometry — the tile-seam pattern; no ordering | [N] |
| nested region → outer city | sketch (inner ring) | hole-with-frontage: no streets/blocks inside the inner ring, perimeter frontage street, hashed entrances; never read inner output (uniform for park-in-city and citadel-in-district) | [N] core |
| city → world routes | output (gate stubs: point+bearing+class) | world tier owns inter-city roads, terminates them at emitted gates; routeHints stay position-only (no cycle) | [N]/[?] |

**Standing rejections (unchanged):** same-stage output coupling of any kind; whole-network
hydrology solve; vegetation ← settlement; generator-written notes; sketch-geometry mutation.

## 3. Why updates go in circles today (pathologies, verified with file:line)

From the mechanics audit of `src/controller/MapController.ts`, `src/map/generation/generationService.ts`,
`src/gen/cache/fingerprint.ts`.

**Perf ground truth** (measured on the dev machine; the Surface Pro factor is an *estimated* 3–5× —
CLAUDE.md itself demands CPU-throttled numbers before any perf claim ships): city network compute
~87–200 ms (DECISIONS.md), city network artifact ~4 MB JSON, real caches **170 MB of
`generated.jsonl` for 17 regions** (~10 MB/region ⇒ ~1 GB extrapolated at 100 regions), p95 ≈ 52 fps
panning dense forest *already on the dev machine*, 400 ms edit debounce, 6 m river resample (a 20 km
braided river ≈ 10–15 k channel vertices). These numbers ground the design constraints in §5–§6.

- **P1 — force recomputes the network once PER TILE** (`generationService.ts:176`: force skips the
  network-cache read *inside the tile loop*). A 6-tile city region runs the full generator 6× for
  identical bytes, and appends duplicate network records. Multiplies every other pathology.
- **P2 — permanent stale-downstream bug (correctness, live).** `regenerateAffectedTiles`
  (`MapController.ts:1717`) walks affected regions in *fabric-file order*; a city ordered before a
  river reads the river's OLD network as upstream; the river then regens; the `done` set blocks any
  correction; and the city's records are stamped with the fingerprint of the *post-edit durable
  inputs* (`:635`) — not of the bytes actually read — so replay reports FRESH and the stale city
  survives reloads indefinitely. Violates "the map is a pure function of the durable data".
- **P3 — roots regen in queue order, not stage order** (`:1658–1665`) — same stale mechanism when a
  river+city are queued in one debounce window.
- **P4 — blanket, kind-blind, consumption-blind reach**: any sketch edit force-regens every region
  within 200 m of the edit's overall bbox (a long diagonal road claims a huge dead rectangle) —
  editing a road regenerates mountains and forests, which read nothing. Measured true consumption
  table is in §1.
- **P5 — the fingerprint hashes ALL fabric** (`fingerprint.ts:111`): any constraint-kind edit
  anywhere flips every region's fingerprint → next campaign open recomputes the entire campaign
  (byte-identical churn — the load-time "circles"); worse, it can blank pinned-old regions
  (needs-adoption badge) from an unrelated sketch across the map.
- **P6 — repeated IO/hashing**: force path drops the shared cache read; the flush/cascade paths
  never thread `opts.fingerprints` (`:869, :1661, :1720`), so hashing is O(R² × |fabric|) per flush;
  a full `.mapcache` read per water-consumer per pass. `removeCachedTiles` does a **full-file read +
  parse + rewrite per region** (`tileCache.ts:95–102`) — a 10-region cascade on a real 170 MB cache
  ≈ 3.4 GB of vault IO.
- **P7 — one repaint per region per regen** (10-region cascade ⇒ 10+ full `setData` re-indexes).
- **P8 — double regen on sketch-create/undo-restore** (the new feature is "in reach" of itself).
- **P9 — adopt-all is O(k²)** (each adoption runs its full cascade over soon-re-dirtied dependents).
- **P10 — the confirm cap guards only the DAG channel**; the raw-sketch channel is uncapped.
- (Also found: **river regions regenerate on the main thread** — the worker protocol loses
  `region.spine`, `MapController.ts:567–574` — so every river edit blocks the UI thread.)

Worst case on paper: a 3-pause river-spine drag over a city = **30 generator executions** where 2
are needed (P1 × P3 × per-pause cascade); via the non-debounced vertex API, 10 per keypress.

## 4. The proposed interaction graph

### 4.1 Stages (semantic order = execution order = invalidation order)

```
 −1 SOURCES      raw sketches (9 kinds) + canon location pins        [DAG source nodes, not generators]
  0 HYDROLOGY    river (consumes: nothing¹)                          produces: water
  1 TERRAIN      terrain stamps: mountain, plateau, basin,           produces: elevation (a FIELD:
                 coastline, ridge/valley lines                        terrainAt = base + stamps − river carve ± grading)
  2 VEGETATION   forest, rural park                                  produce: vegetation
  3 SETTLEMENT   city                                                produces: settlement (ring+gates+crossings+canals+stubs)
  4 PERI-URBAN   farmland, urban-park                                produce: nothing²
  5 DETAIL       wall elaboration                                    produces: detail (terminal)
  render leaves: contours / hillshade / DEM tiles                     (viewport-keyed products of terrainAt; nothing consumes them)
```
¹ opt-in `slopeSensitivity>0` reads *macro* terrain re-derived from sketches (durable-input, legal at
any stage) — documented as "reads macro terrain, not finished terrain".
² the hard invariant that keeps the band cycle-free: **nothing may consume `settlement` while
producing a currency the city consumes.** (Urban-park drops vegetation production; farmland already
produces nothing.)

Jonah's ordering requirement, checked: terrain edit → farmland ✓ (stage 1 → 4), rivers untouched ✓
(stage 0 < 1). River edit → carve → terrain-render + everything downstream that reads water. City
edit → farmland/urban-park/wall only. Wall edit → nothing else. Renumbering note: mechanically the
carve could stay sketch-keyed under today's numbering (both are pure functions of durable data),
but renumbering makes the stage numbers MATCH the semantic direction so the single invariant —
"an edit at stage s never writes stage < s" — holds without a carve-shaped special case.

### 4.2 The three currencies and their rules

| currency | what | read scope | invalidation |
|---|---|---|---|
| **sketch** | raw GM geometry (+canon pins) | any stage ("ring = land claim") | consumption-aware: algorithm's `consumesSketch: FabricKind[]` × per-algorithm `influenceMargin` |
| **field** | `terrainAt(x,y)` — closed-form from durable sketch data, memoized lattices | any stage reads; semantically stage-1 output | DAG edges from terrain-stamp/river nodes to declared elevation consumers |
| **output** | `UpstreamArtifacts` GeoJSON (channel rings, canopy, settlement payload) | strictly lower → higher stage | DAG closure |

Same-stage coupling: **sketch adjacency + hashed shared-edge agreement only** (adjacent districts,
forest/farmland boundary, tributary junctions) — the tile-seam philosophy applied to regions: two
independent computations agree because they hash the same shared durable geometry.

### 4.3 Registry deltas

- `stage` renumbered per §4.1; `Stage` gains −1 (sources) internally.
- New per-algorithm declarations: `consumesSketch: FabricKind[]` (seeded from the *measured* table in
  §1 — not from optimistic intent), `influenceMargin: number` (city ≈ road-falloff+bridge span;
  river ≈ confluence snap; default 200 m preserves today), and a **cost class** (feeds the
  cost-weighted confirm cap, §6).
- `settlement` payload defined concretely: `{ ring, gates[], arterialCrossings: {point,bearing,class}[], canalLines[], stubs[] }` (all already computed in `citynet/skeleton.ts`).
- Park gains the urban/rural split (variety-driven stage + produces).
- River v2: `slopeSensitivity` default 1→0 (plan-029 bump + adoption; needs Jonah's sign-off —
  §9 Q1).

## 5. The global terrain system

### 5.1 Composition (fixed, documented evaluation order — FP determinism by sorted fold)

```
T(x,y) = grade( carve( replace( add( B(x,y) ) ) ) )
  B    = seaDatum + campAmp · fbm_continental(campaignSeed)      // NEW fn; default campAmp = 0 (flat) ⇒ existing campaigns byte-stable
  add:     T₁ = B + Σᵢ mask_i(sdf_i, BAND) · h_i(x,y)            // mountains, hills, ridge/valley polylines (signed profile); feature-id order
  replace: T₂ = lerp(T₁, target_j, mask_j)                       // plateaus/mesas, basins, coastline→seaDatum; id order, optional integer priority param
  carve:   T₃ = smin(T₂, bed_k)                                  // per river, keyed on the sketched spine (durable), fixed band; id order
  grade:   T  = lerp(T₃, T₃(center_m), gradeMask_m)              // city-site flattening toward the persisted center's elevation; default OFF
```

- Every term is a pure function of durable sketch data (seeds/rings/spines/params) — the exact
  legality pattern `elevationFieldFromFabric` already established; point-evaluable, analytic
  gradients compose by chain rule; falloff bands are fixed absolute meters.
- Determinism: id-sorted fold per operator class (FP addition isn't associative; polynomial
  smooth-min isn't order-independent — sort *before* fold, the `cascadeOrder` discipline).
- **Terrain-object grammar v1:** mountain (migrated as-is), plateau/mesa (replace→target),
  basin/depression, coastline (replace→seaDatum), ridge/valley polylines (signed cross-profile).
  Deferred: cliffs (needs domain-warp operators — Génevaux 2015), craters.
- **Carve details:** bed profile re-derived from each river's durable `(seed, spine, params)` via a
  memoized per-region channel field; simplified bed (main channel only, no braids) is acceptable.
  **Every polyline-keyed stamp/carve MUST use a segment spatial hash** (`spatialHash.ts`) — a naive
  nearest-point-on-polyline over a continental spine is ~1e9 ops per lattice fill; without the hash,
  cold carve rebuilds dominate every other terrain cost.
- **Lattice discipline (binding):** chunked `Float32Array` tiles with LRU eviction — never a global
  10 m `Map` (0.5–1 GB at 30×30 km); worker-side memo caches keyed on the terrain fingerprint,
  bounded.
- **Precedent:** Génevaux et al. 2013 (hydrology-first terrain — the flagship "physical" paper is
  itself rivers→terrain), Génevaux 2015 feature primitives (construction tree of point/curve/polygon
  stamps with blend/replace/carve — this design flattened to a fixed stack), Hnaidi 2010 (curve UX,
  solver rejected: global pass), Houdini/Unreal/Gaea layer stacks (add/max/replace-with-falloff
  vocabulary; Unreal's spline-conforms-terrain is the industry ordering).

### 5.2 What each edit dirties

| edit | dirty | untouched |
|---|---|---|
| base params (campAmp/seaDatum) | whole campaign: every elevation consumer + all contour/DEM leaves | all rivers, forests/parks that don't read terrain, cities |
| stamp shape/params/re-roll | stamp bbox + falloff band: overlapping elevation consumers + contour leaves | rivers, everything outside band |
| river spine/params | corridor + carve band: channel, carve → contour leaves, riparian/water consumers downstream | terrain stamps, other rivers |
| district ring (grading on) | district bbox + grade band | rivers |

**Guards (binding):** contour/hillshade/DEM leaves are computed **lazily per viewport
tile with LRU** — never eagerly whole-campaign (a 30×30 km base-noise campaign is ~2.4 M samples ≈
10–30 s on the Surface Pro if eager); leaf sampling runs in the worker; base-terrain params sit
behind an explicit **Apply** button (never a live slider) since they are the one whole-campaign
invalidation.

### 5.3 Migration & frozen world tier

`world/heightmap.ts#heightAt` stays byte-frozen (biomes). `terrainAt` is a NEW `src/gen/fields/`
function; base defaults flat so every existing campaign is byte-stable until opted in. Contours
migrate from per-mountain-region features to viewport-keyed products of the composed field (cache
key = hash of the durable terrain inputs intersecting the tile; 2×2 seam gates mandatory). Two-oceans
note: sketched coastline vs. world-tier ocean paint can disagree; coastline stamp is styled truth,
world tier learns to defer in a later, flagged migration.

## 6. Execution model — the single forward pass

Every trigger (sketch add/edit/delete · param/preset/center/re-roll · adopt · undo · replay-on-load ·
cache-miss) reduces to `markDirty(roots) → runForwardPass()`:

1. Build DAG nodes: procgen regions + **sketch/canon source nodes** (stage −1, `produces: [kind]`).
   Edges: `kind ∈ consumesSketch(B) ∧ bboxOverlap(influenceMargin_B)` for sources; the existing
   produces∩consumes rule above. `regenerateAffectedTiles` is deleted.
2. Dirty set = `downstreamClosure(roots)` — an edit structurally cannot reach a lower stage.
   Runtime assertions: executed order non-decreasing in stage; no writes outside the closure.
3. **Persistent in-memory cache view**: the cache map is read ONCE per campaign open, mutated
   incrementally by passes, written behind — never re-read per pass. Today's `readCachedTiles`
   parses the whole file as one string and zod-walks every feature of every record; at the measured
   170 MB (17 regions) that is a ~340 MB transient plus parsed objects at 3–5× JSON size, and at
   100 regions (~1 GB) a **2–5 GB peak — OOM territory in Electron on an 8 GB Surface Pro** — so a
   per-pass re-read is not a simplification, it is a cliff. One scoped-fingerprint pass per
   `runForwardPass` (fingerprint = hash of *only* the sketch kinds this algorithm consumes, within
   its influence bbox, + upstream artifact fingerprints — fixes P5), and a dirty region whose
   recomputed fp equals its cached record's fp is **skipped** (declared-but-inert edges cost
   nothing). Two safety notes carry the whole scoping idea: (a) scoping **inverts the failure
   mode** — today's global hash over-invalidates (slow but correct), while an under-declared
   `consumesSketch` row would silently serve stale bytes as fresh, the exact class plan 029 exists
   to prevent — hence the §7 under-invalidation harness is a shipping gate, not a nice-to-have;
   (b) the current FNV hasher does a BigInt multiply per character (~10–30 MB/s) and must be
   replaced (two 32-bit lanes / xxhash-style) before scoped fps hash 10–15 k-vertex braided rings
   (~500 KB canonical JSON ⇒ 20–50 ms per hash per region at BigInt speeds). The fp pass **throws**
   on a missing upstream fp (never silently filters); sketch sources at stage −1 sort first under
   the same `(stage,id)` rule, so the fp pass has no new ordering trap.
4. **Cost-weighted confirm cap** covering the whole pass — region cost classes from the registry
   plus render-leaf work (a region-count cap is blind to both 10-cities-vs-10-farmlands and to
   contour storms). A declined pass leaves downstream records fp-stale and **replay serves them with
   an "outdated" badge instead of an uncapped recompute at next open** (reusing the plan-029 badge
   machinery; recompute happens on explicit apply).
5. Walk dirty set in `(stage,id)` order: compute each region's network **once** (fixes P1), clip
   tiles, stamp the threaded fingerprint, update the shared cache view so downstream reads fresh
   upstream with zero IO (fixes P2/P3 by construction). River/spine regions move into the worker
   (fix the protocol's spine loss — today every river edit blocks the UI thread). Worker
   structured-clone volume is dominated by the ~4 MB return artifacts (acceptable: ~40 MB / 20–50 ms
   per 10-city pass); a 2-worker pool for independent same-stage regions is determinism-safe since
   same-stage regions never read each other's output and the commit order stays `(stage,id)`.
6. **Interactive edits get a preview mode** (hard precondition for the stage reorder): during a
   drag, only the ROOT regenerates per debounce pause, painted as ephemeral render state — never
   fingerprint-stamped, never cached; the full forward pass runs once on release/commit. Without
   it, the reorder makes the most common edit in the product 5–10× slower than today: a city ringed
   by 6 farmlands + 2 urban parks + a wall ≈ 10 generator runs per 400 ms pause (~0.75 s dev ≈
   2.5–4 s Surface Pro, *every pause of a drag*), and a continental river's 40-region closure ≈
   12–20 s per pause — while the payoff (fields tracking gates) is invisible mid-drag. Preview mode
   is also the Google-Maps grammar (drag = live handle, release = commit). Two tempting
   alternatives were evaluated and rejected as footguns: per-stage debounce tiers (a second timing
   regime whose windows leave cache and DAG disagreeing by design) and closure-truncation
   heuristics (float-keyed thresholds break the determinism story; the fingerprint IS the exact
   truncation rule).
7. Batched cache-key drops. **Cache storage shards per region** (`.mapcache/region-<id>.jsonl`):
   drops become file deletes, appends stay appends, reads scope to dirty regions — still JSONL in
   `.mapcache/`, so the locked decision holds. Today's `removeCachedTiles` does a full-file
   read+parse+rewrite *per region* — ≈ 3.4 GB of vault IO for a 10-region cascade on the real
   170 MB cache — and any single stale key rewrites everything; sharding removes the write
   amplification entirely. Stop persisting per-tile clip records for whole-artifact regions (they
   duplicate the network's bytes — that's where ~10 MB/region comes from); re-clip from the
   in-memory network on paint.
8. **Per-stage repaint** (≤6 `setData`s per pass, upstream stages appear first — the world visibly
   reflows downstream; zero determinism risk since repaint order never touches cached bytes; a
   single end-of-pass repaint was rejected: a 10-region Surface-Pro cascade would show a frozen,
   visibly-wrong map for 3–10 s). This must be backed by per-stage generated sources or MapLibre's
   diff-based `updateData` so repaint cost scales with changed features, not total features: today
   every repaint is one whole-map `setData` re-index (measured 4,313 features at 17 regions, ~25 k
   projected at 100 ⇒ ~1 s per re-index on the Surface Pro), and with p95 already at 52 fps on the
   *dev* machine there is no headroom for any repaint policy that re-indexes the full collection.
9. Fingerprint-mismatch is the ONLY staleness rule; replay-on-load = `runForwardPass(dirty = fp
   mismatches)` — live and replay share one code path, so "delete `.mapcache/` is harmless" and
   "sync edited Fabric.geojson under me" converge on the same machinery (subject to the §6.4 badge
   rule for declined bills).
10. Pinned-old (plan 029) semantics unchanged inside a pass: cache-serve-or-badge, never recompute;
    consent stays at direct-edit entry points; scoped fps stop unrelated edits from blanking pinned
    regions. Adopt-all: raise all pins first (durable writes, (stage,id) order), then ONE pass over
    the union closure — fixes P9.

## 7. Headless testing strategy (no Obsidian in the loop)

The pipeline is designed so every property in this report is a Vitest assertion:

- **Pure modules** (no host): `dag.ts` (closure/order/acyclicity — exists), `fields/` (terrain
  composition goldens + gradient checks + 2×2 lattice seam tests), `fingerprint.ts` (scoped-fp
  agreement: live pass vs replay compute identical fps; missing-upstream-fp throws).
- **The under-invalidation property harness (shipping gate for anything consumption-aware):** for
  each algorithm, generate with and without an out-of-scope / out-of-margin sketch feature of every
  kind and assert byte-identical output; run in the fuzz suites. This is the single most important
  new test — it converts `consumesSketch` from trusted declaration into verified contract.
- **Controller-level** (MapController + FakeHost, plan 021 — exists): counter-based pass invariants —
  `generatorRunCount === dirtyRegionCount` (network once per region; P1 regression), fake-vault
  adapter read/write/append counters (one incremental-view mutation + one batched write per pass),
  repaint counters via the injectable render hook (≤ stage count per pass), cascade-order recording
  (`cascadeRegeneratedIds` precedent), the P2 regression (water edit with adversarial fabric file
  order ⇒ downstream bytes track fresh upstream), "record fp fresh ⇒ bytes fresh" property test,
  pinned-old survival under unrelated edits, undo = byte-identical restoration, declined-cap →
  reopen ⇒ badge-not-storm, adopt-all single-pass, preview-mode leaves no durable records.
- **Determinism nets**: goldens per algorithm version + metric bands (029/030-B machinery); a
  shuffled-fabric-file-order test must produce byte-identical campaign state (order comes from
  (stage,id), never file order).
- **Perf proxies in Vitest**: budget assertions on counters — generator-runs-per-pass,
  lattice-cells-allocated (via an optional stats hook on field memos), features-per-repaint,
  bytes-hashed-per-pass. Never assert `process.memoryUsage` (flaky); assert entry counts. When a
  perf CLAIM is made, CPU-throttled numbers come from a manual throttled run (CLAUDE.md), never a
  scripted gate.
- **NO live Obsidian gates in this arc** (Jonah 2026-07-14: gate runs take north of 2,000 s and are
  unreliable — banned). All verification is headless; visual judgment happens in the playground
  (`npm run playground`) and in normal app use. No pipeline property may require a live renderer to
  assert — that is a review-blocking criterion for the implementing plans 031–039.

## 8. Sequencing (relative to 029/030) — PROMOTED TO PLANS 031–039 (2026-07-14)

Risk-ordered and now written as numbered plans in implementation order; 031 fixes live bugs (mostly
byte-identically) and can run alongside the 030 waves; 032–034 align with 030-B (the headless nets
are the safety story); 035–038 are the interaction-graph and terrain changes.

1. **Plan 031 — pipeline hotfixes**: P1 fix (network once per forced regen; assert with
   `generatorRunCount`), batching parity (thread fpMap + shared cache read like replay; coalesced
   repaints), stage-ordered raw channel (fixes the live P2/P3 correctness bug), worker spine fix
   (rivers off the main thread).
2. **Plan 032 — cache sharding + persistent view + staged/diff repaint** — the load-bearing floor
   (§6.3/§6.7/§6.8); lands before the pass unification formalizes read/write patterns.
3. **Plan 033 — consumption-aware invalidation**: under-invalidation property harness FIRST, hasher
   replacement, `consumesSketch` + `influenceMargin`, then scoped fingerprints (FP_VERSION bump ⇒
   one-time self-healing recompute).
4. **Plan 034 — `runForwardPass` unification**: delete the flush/affected/cascade/replay split;
   cost-weighted cap; preview mode; badge-not-storm replay; adopt-all as one pass.
5. **Plan 035 — stage reorder**: hydrology above terrain, river v2 (`slopeSensitivity` default 0),
   urban/rural park split, farmland → peri-urban — each a plan-029 version bump with adoption.
   Preview mode (034) is the ratified precondition.
6. **Plan 036 — global terrain**: field module, stamps, carve w/ segment hash, lazy leaves, contour
   migration; base defaults flat so it lands byte-stable.
7. **Plan 037 — coupling edges wave 1 (correctness)**: river→vegetation/farmland channel exclusion
   + riparian, vegetation→city growth cost, settlement payload → wall, nested-region holes.
8. **Plan 038 — coupling edges wave 2 (flavor)**: waterfront streets, long-lots, tributary rank,
   terrain-reading vegetation/agriculture, road promotion, shared-edge district stubs, wall water
   refinements — independent items, individual version bumps, any order.
9. **Plan 039 — typed location pins (FUTURE)**: deferred by Jonah 2026-07-14; the stage −1
   formalization itself still lands with plan 034.

## 9. Open questions for Jonah

**Q1–Q6 RATIFIED (Jonah, 2026-07-14).** Q7 pending (reworded below for clarity).

1. **River default flip** (`slopeSensitivity` 1→0, river v2): existing rivers crossing mountains
   re-meander once on adoption. — **OK'd.**
2. **Farmland/urban-park post-settlement move**: a city edit will now (correctly) regenerate
   adjacent farmland and urban parks, with the preview-mode mitigation (drag = root-only, commit =
   full pass). — **OK'd.**
3. **Grading default-off** (district → terrain → farmland is a new forward edge GMs may find
   surprising: "I moved my wall and the paddies moved"). — **OK'd.**
4. **Replace-stamp overlap**: id-order last-wins + optional `priority` param, no UI affordance for
   overlapping mesas. — **OK'd.**
5. **Base terrain edit** behind an explicit Apply (whole-campaign invalidation). — **OK'd.**
6. **Cache sharding** (`.mapcache/region-<id>.jsonl` + no per-tile clip records) read as within the
   "JSONL in .mapcache" locked decision; re-goldens replay gates. — **OK'd.**
7. **Typed location pins shaping generation — in scope for the next arc?** Two parts. (a) The
   formalization: canon pins already feed generators (city routes streets around them; a pin move
   already regenerates nearby regions) — making them stage −1 source nodes in the DAG just routes
   that existing behavior through the unified pass; no visible change, comes free with the pipeline
   work, not really a question. (b) The feature being asked about: should a pin's `type:` frontmatter
   ATTRACT generation instead of only blocking it — a `market` pin inside a district snaps the
   generated plaza to the pin ("the market is HERE"), a `temple` pin gets a forecourt/landmark
   block, a `gate` pin on the wall forces a gate with an arterial aimed at it. Strictly one-way
   (pins shape fabric; generation never creates/moves/names pins — no-canonization untouched).
   Question: include the typed-attractor behaviors in the next arc, or keep pins as plain obstacles
   for now? — **RULING (Jonah 2026-07-14): future item, separate plan — deferred to plan 039.**
   The stage −1 formalization (no visible behavior change) still lands with plan 034.
