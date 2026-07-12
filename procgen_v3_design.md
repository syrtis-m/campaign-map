# Procgen v3 — design & execution doc for the rewrite

> **Superseded in part by plans/020 (Jonah, 2026-07-12) — disc domains →
> sketch-driven regions.** The city-tier trigger and geometry here (click at
> z≥8 → DomainProfileModal → disc `CityDomain {cx, cy, radius}`) are replaced by
> a GM-sketched district polygon (`ProcgenRegion`); §3–§5 are historical on that
> point. **Determinism rules D1–D6 (§4) remain binding** and are restated for
> regions in plans/020 §7. This file is kept as the historical record of the v3
> pipeline; do not edit it to match plan 020.

*Handoff document for the coding agent executing the city-procgen rewrite,
July 2026. Self-contained: everything you need is here or in the files this
doc points at. Background reasoning lives in `procgen_v2_ideas.md` (§5–6:
why field-only methods were rejected, why city-scoped growth was chosen);
current-system tour in `procgen_explainer.md`. You do not need to re-derive
any of that — this doc is the decision, that doc is the rationale.*

**Mission:** replace the current city-tier generators (disconnected
tensor-field streamline "fur", street-ignorant Voronoi blocks) with a
**city-scoped deterministic growth pipeline** that produces street networks
and blocks that could pass for real European or North American towns —
T-junction-dominated organic warrens, jogged NA grids, cul-de-sac suburbs —
while preserving every locked invariant of the plugin.

---

## 0. Read first, in this order

1. `CLAUDE.md` — locked decisions. Nothing below overrides them.
2. `procgen_explainer.md` — how the current system works end to end.
3. `procgen_v2_ideas.md` §5–7 — the critique and the v3 concept you are building.
4. `docs/06-autonomous-build.md` — the unattended-build protocol (Tier A/B
   gates, PROGRESS.md / DECISIONS.md / review/ state files). **Follow it.**
5. `docs/04-quality-bar.md` — the screenshot test you must pass.
6. Algorithm references (fetch as needed):
   [Parish & Müller 2001](https://graphics.ethz.ch/Downloads/Publications/Papers/2001/p_Par01.pdf)
   (growth loop, local constraints),
   Martin Evans's [Roads](https://martindevans.me/game-development/2015/12/11/Procedural-Generation-For-Dummies-Roads/) /
   [Lots](https://martindevans.me/game-development/2015/12/27/Procedural-Generation-For-Dummies-Lots/) /
   [Half-Edge](https://martindevans.me/game-development/2016/03/30/Procedural-Generation-For-Dummies-Half-Edge-Geometry/)
   posts (readable implementations of the same),
   Watabou's [0.10.0-alpha postmortem](https://www.patreon.com/watawatabou/posts/medieval-fantasy-87882877)
   (the stability failure mode you must not reproduce).

## 1. Invariants (violating any of these is a failed build)

These restate CLAUDE.md operationally for this rewrite:

- **I1 Purity.** Everything under `src/gen/` stays headless: no DOM, no map,
  no Obsidian, no `Math.random()`, no `Date.now()`. Only PRNG:
  `mulberry32(hashSeed(...))` from `src/gen/rng.ts`.
- **I2 Determinism.** Same `(campaignSeed, request inputs, constraints)` →
  byte-identical cache records, forever, in any generation order. The
  release-blocker test is unchanged: delete `.mapcache/`, replay manifest,
  byte-diff.
- **I3 Explicit-only.** Generation runs only from a GM request. Pan/zoom
  never generates; `MapView.generatorRunCount` must stay 0 under pan/zoom
  in the existing gate.
- **I4 Two-layer model.** Locations and sketched fabric are never
  overwritten, never generated. No pins, no named Locations from
  generators. Fabric never promotes. Sketches + locations enter as
  constraints only.
- **I5 Cache disposability.** `.mapcache/` deletable, harmless, regenerates
  identically. What persists is the request (manifest). No SQLite. No new
  synced binary anything.
- **I6 Typed features only.** Generators emit `generatorId` / `type` /
  `roadClass` / etc. properties — never paint. Themes own all styling.
  Z-order invariant (`layerOrder.ts`) untouched: generated < sketched <
  locations.
- **I7 Seam safety.** Adjacent tiles must render geometry that matches at
  shared edges bit-for-bit. v3 achieves this differently than v2 (see §3.1)
  but the 2×2 seam gate still has to pass.
- **I8 Mobile-possible.** Vault/DataAdapter APIs only in host code; worker
  fallback to main thread preserved.

## 2. What changes, in one paragraph

The unit of city generation changes from *tile* to **city domain**: a
bounded disc (center, radius ≤ 1500 m, profile) recorded in the manifest as
part of the GM's request. The whole city street network is computed **once
per domain** as a pure function of `(campaignSeed, domain, constraints)` —
internally *sequential* (priority-queue growth, T-junction snapping), which
is now legal because every tile that overlaps the domain computes or reads
the *same whole network* and clips its own bbox from it. This is the
existing halo argument taken to its limit ("halo = the whole city"). Tile
cache keys, JSONL cache, manifest replay, worker dispatch, constraint
threading: all structurally unchanged. The old streamline/Voronoi-block
generators are deleted at the end (kept behind a flag until v3.2 ships).

## 3. Architecture

### 3.1 City domains

```
CityDomain = {
  id: string          // "dom:<anchorCellX>:<anchorCellY>"
  cx, cy: number      // center, generation-space meters, snapped to a 30 m lattice
  radius: number      // 400–1500 m, default 900
  profile: ProfileId  // "euro-medieval" | "euro-continental" | "na-grid" | "na-suburb"
  createdAt: number   // host-side timestamp (never read by generators)
}
```

- `citySeed = hashSeed(campaignSeed, "domain", anchorCellX, anchorCellY)`
  where anchor cell = `cx,cy` on the 30 m lattice. Position-keyed, like
  everything else in the codebase.
- Domains are created by **Generate fabric here** at city tier when the
  click point is not inside an existing domain (center = click point
  snapped to lattice; profile from a small modal defaulting by campaign
  theme: parchment/ink-soot → euro-medieval, modern-clean → na-grid,
  neon-sprawl → na-grid dense). Clicking inside an existing domain
  generates/clips further tiles of it. Overlapping domains are rejected
  with a Notice (merge is out of scope; see §10).
- **Seam story (replaces order-free-per-tile for city tier):** the network
  is a pure function of the domain + constraints. Tile A and tile B don't
  need order-free math to agree — they agree because they clip the *same
  deterministic artifact*. Clipping stays bit-identical via the existing
  `clip.ts` (Liang-Barsky / Sutherland-Hodgman).
- World tier (`world-region`, `world-route`) is untouched by this rewrite.

### 3.2 Manifest schema (additive, zod, per-entry salvage preserved)

Extend `src/model/generatedManifest.ts`:

```ts
export const CityDomainSchema = z.object({
  id: z.string().min(1),
  cx: z.number(), cy: z.number(),
  radius: z.number().min(100).max(3000),
  profile: z.enum(["euro-medieval", "euro-continental", "na-grid", "na-suburb"]),
  createdAt: z.number(),
});
// GeneratedManifestSchema gains: domains: z.array(CityDomainSchema).default([])
// ManifestEntrySchema gains:     domainId: z.string().optional()
```

Old `Generated.json` files parse unchanged (`default([])`, `.optional()`).
`manifestEntryId` unchanged — still one entry per (tier, tile). Clear-here
removes the tile entries; **Clear domain** (new menu item) removes the
domain + all its entries + all its cache records (extend the existing
clear flow in `MapView`; log as `clear-area` with the domain id in payload).

### 3.3 Cache layout (same file, same schema, one new record kind)

`.mapcache/generated.jsonl`, `CachedTileSchema` unchanged. Two record kinds:

1. **Domain network record** — `generatorId: "city-network"`,
   `tileX/tileY` = domain anchor cell, `features` = the *whole unclipped
   network + blocks + parcels* for the domain (typed features; graph node
   ids in properties). Computed once, ~1–5 MB worst case — measure; if
   >8 MB at radius 1500, store streets+blocks only and derive parcels
   per-tile (parcels are per-block pure, §5.3).
2. **Per-tile records** — `generatorId: "city-street" | "city-block" |
   "city-parcel" | "city-footprint" | "city-landmark"`, exactly today's
   shape: the clip of (1) to the tile bbox. These are what MapView paints;
   painting code changes minimally.

`generateTile` (`src/map/generation/generationService.ts`) grows a
sibling: `generateDomainTile(ctx, domain, tileX, tileY, ...)` that
cache-or-computes the network record first, then clips. Replay
performance note in the explainer §6 applies doubly: replay must read the
cache file once and share the parsed map — never recompute the network per
entry.

### 3.4 New module layout under `src/gen/`

```
src/gen/citynet/            # NEW — all pure, all unit-tested
  domain.ts                 # CityDomain type, citySeed, lattice snap
  profiles.ts               # ProfileId + parameter bundles (§6)
  costField.ts              # terrain/water/canon cost lattice for A*
  skeleton.ts               # Stage A: arterials, waterfront, ring, plaza
  growth.ts                 # Stage B: priority-queue street growth
  graph.ts                  # planar graph: snap-rounding, node/edge store
  faces.ts                  # Stage C1: half-edge face extraction → blocks
  parcels.ts                # Stage C2: OBB parcelling + footprints
  landmarks.ts              # plaza/church/market footprints, walls, gates, bridges
  cityness.ts               # scalar density field (moved/adapted from v2 idea 2.3)
  index.ts                  # generateCityNetwork(citySeed, domain, constraints) → Feature[]
                            # + clipNetworkToTile(features, bbox) → per-generatorId Feature[]
src/gen/city/               # OLD — freeze; delete in v3.4 (keep corridor.ts, see §5.5)
```

Every module: same JSDoc discipline as the existing code (explain the
determinism/seam argument at the top of each file — future agents rely on
these).

## 4. Determinism engineering rules (read twice)

The growth loop is sequential; sequential + sloppy = flaky. These rules
make it reproducible:

- **D1 Integer lattice geometry.** All Stage A/B node coordinates live on a
  **1 cm integer lattice** (multiply meters by 100, round, store as int).
  Intersection/orientation tests on ints are exact — this kills both FP
  nondeterminism and Watabou's collapsed-edge crash class in one move.
  Convert to float meters only when emitting features.
- **D2 Total ordering everywhere.** Priority queue keyed
  `(priority, candidateId)` where `candidateId = hashSeed(citySeed,
  parentEdgeId, branchIndex)` — no tie ever resolved by insertion order.
  Any `sort()` gets a full comparator ending in id compare. Any Map/Set
  iteration feeding output must be re-sorted before use.
- **D3 Budgets, not convergence.** Growth stops at
  `profile.maxSegments` or empty queue — never "until it looks done".
  A* gets `maxExpansions` with a deterministic failure path (straight-line
  fallback route flagged `degraded: true` in DECISIONS.md, not a throw).
- **D4 Trig caution.** `Math.atan2/hypot/cos/sin` are already used by the
  existing generators; keep them but confine to field *sampling*, never to
  decisions that gate topology on exact equality (always compare with the
  lattice, D1). Cache portability across OSes is not required (cache is
  sync-excluded); same-machine delete-and-regen byte-identity **is**.
- **D5 Canonical output.** Quantize emitted coordinates
  (`Math.round(v * 1000) / 1000`), sort features by first-coordinate then
  id (existing convention), stable-stringify properties (fixed key order).
- **D6 No hidden inputs.** `generateCityNetwork` reads *only* its
  arguments. `createdAt` and anything host-side never crosses into gen.

## 5. The pipeline

### 5.0 Inputs

`generateCityNetwork(citySeed, domain, constraints)` where `constraints` is
the existing `GenerationConstraints` (`src/gen/types.ts`) — worldBounds,
canonFeatures, fabricFeatures (whole, never pre-clipped), naming ids. New
optional field: `routeHints?: {x,y,bearing}[]` — world-route endpoints near
the domain, threaded by the host from `world-route` output if present
(deterministic: those are position-hashed already). Absent hints → hashed
compass bearings.

### 5.1 Stage A — skeleton (`skeleton.ts`, `costField.ts`)

1. **Cost lattice:** 10 m world-anchored grid over `domain + 200 m`;
   cell cost = base 1 + slope penalty from `heightAt` (`world/heightmap.ts`)
   + water penalty (∞ for sketched water polygons, `BRIDGE_COST ≈ 25` for
   crossing a river line cell — expensive, so crossings concentrate) +
   canon-location proximity penalty (never pave the GM's pins, existing
   rule). Pure function of position + constraints.
2. **Destinations:** from `routeHints`, else `profile.arterialCount` (3–6)
   bearings = `hashSeed(citySeed, "bearing", i)` spread with jitter.
   Endpoint = domain-boundary point at that bearing.
3. **Arterials:** A* center→each endpoint on the lattice (neighbor order
   fixed N,E,S,W,NE,SE,SW,NW; f-ties by (g, cellHash)). Smooth with the
   existing `chaikinSmooth` (exported from `city/corridor.ts`). Where a
   path crosses a river: the crossing segment becomes a `bridge` feature;
   consecutive arterials crossing within 40 m share one bridge (snap to
   the cheaper crossing — deterministic via cost comparison then hash).
4. **Waterfront streets:** for each sketched river/coast within the
   domain: offset polylines at 20 m and 55 m (`euro-*` profiles), clipped
   to domain, class `street`. Offsetting on the int lattice; degenerate
   self-intersections dropped by area test.
5. **Ring / wall (profile-gated):** breadth-first *network distance* field
   from the center over Stage A arterials + lattice; ring = smoothed
   contour of that field at `profile.ringRadius`, snapped to arterial
   crossings (gates). Emit `roadClass: "ring"`, wall polygons
   `type: "wall"`, gate points `type: "gate"` (unnamed fabric, I4).
6. **Plaza:** polygon where arterials converge (offset intersection of
   the ≥2 highest-class roads at center), plus 1–2 `landmark` footprints
   facing it (church/market per profile).

### 5.2 Stage B — growth (`growth.ts`, `graph.ts`)

Parish & Müller with the classic local constraints, on the int lattice,
inside the domain disc, seeded by Stage A:

```
queue ← branch candidates along arterials/waterfront/ring   (priority =
        cityness(midpoint) + profile bias, id-tiebroken)
while queue nonempty and segments < profile.maxSegments:
  seg ← pop
  localConstraints(seg):
    - if end within snapDist of existing node → snap (junction)
    - if seg crosses existing edge → cut at intersection, T-junction
    - if end within snapDist of edge interior → extend/trim to it, T-junction
    - reject if angle to joined edge < profile.minAngle
    - reject if resulting edge < profile.minEdge
    - reject/trim on: sketched water (unless bridging arterial), walls
      (cross only at gates), canon clearance, domain boundary
  commit seg to graph; spawn children (straight-continue + left/right
  branches at profile.branchAngle ± jitter, probability by cityness &
  profile), push
```

- Direction of children biased by the **tensor field** (keep
  `tensorField.ts` — it survives as the *orientation prior*, its right
  job) blended with sketched-road alignment via the existing
  `fabricAngleSampler` (`fabricConstraints.ts`).
- `na-suburb`: branches curve (fixed per-segment curvature from hash),
  snap probability lowered — unsnapped ends *are* the cul-de-sacs; cap
  them with `type: "court"` bulbs.
- `na-grid`: branchAngle 90°, curvature 0, two hashed grid azimuths per
  quadrant (jogs where they meet — real NA grids jog).
- Sketched roads inside the domain are **pre-seeded into the graph before
  growth** (as immutable edges): generated streets snap *to* them. This
  supersedes v2's field-blend-only integration and is the strongest form
  of "the generator adapts around your sketch".
- Dead-end pruning pass (deterministic order: node id): remove stubs
  < `profile.minStub` unless `court`-capped.

### 5.3 Stage C — blocks, parcels, buildings (`faces.ts`, `parcels.ts`)

1. **Faces:** graph is planar by construction (every crossing became a
   node in B). Build half-edge structure; extract faces by
   smallest-left-turn traversal; drop the outer face and faces touching
   the domain boundary. Each face = a **block**
   (`type: "block"`, id = hash of sorted node ids). Degenerate face
   (area < 40 m², self-touching) → skip, count, continue (per-entry
   salvage philosophy applied to geometry — **never throw**; this is the
   anti-Watabou-hang rule).
2. **Parcels:** per block, OBB parcelling (Evans's Lots post): fit
   oriented bounding box brute-force over edges, slice across the short
   axis, recurse; stop rules with hashed violation chances —
   `minArea`, `maxAspect`, `minFrontage` (frontage = edge shared with a
   street), all from profile. Recursion keyed
   `hashSeed(citySeed, blockId, path)` — same discipline as current
   `blocks.ts`.
3. **Footprints:** inset each parcel toward its frontage edge (buildings
   *face the street*); depth/coverage by cityness + profile; interior of
   deep blocks left open (courtyards). Outside the growth extent but
   inside the domain: Watabou's outskirts rule — buildings ribbon along
   arterials only, then farm-field quads aligned to the road
   (`type: "field"`), then nothing.
4. **Wards:** keep the district Voronoi *concept* at ward scale only:
   Voronoi over Stage A junction+plaza sites, cells tagged
   (market/craft/temple/gate/slum) by hash + waterfront/gate adjacency;
   emit as `type: "district"` polygons (themes may tint subtly; naming
   via existing `naming/` machinery). Blocks do NOT derive from these —
   they derive from faces.

### 5.4 Cityness (`cityness.ts`)

`cityness(x,y) = falloff(|p - center|/radius) × (0.6 + 0.4·noise) +
Σ location bumps` (settlement-type canon Locations inside the domain add
hashed-magnitude bumps — the "city grows around the GM's pins" idea).
Modulates: branch probability, snap distance, parcel minArea, footprint
coverage, growth extent (streets stop where cityness < profile.edge).

### 5.5 What survives, what dies

| Current | Fate |
|---|---|
| `city/streamlines.ts`, `city/tensorField.ts` | tensorField **survives** (orientation prior); streamlines survive only for corridor elaboration |
| `city/corridor.ts` + `chaikinSmooth` | survives (sketch-driven corridor + smoothing util) |
| `city/districts.ts` (blocks parent) | dies in v3.2; Voronoi helper survives for wards |
| `city/blocks.ts` | dies in v3.2 (replaced by faces+parcels) |
| `fabricConstraints.ts` | survives whole; growth consumes it |
| `spatialHash.ts`, `clip.ts`, `rng.ts`, cache, worker, manifest replay | survive whole |
| world tier | untouched |

## 6. Profiles (`profiles.ts` — initial values, tune against screenshots)

| param | euro-medieval | euro-continental | na-grid | na-suburb |
|---|---|---|---|---|
| arterialCount | 4–6 | 4–5 | 3–4 | 2–3 |
| ring/wall | yes | optional | no | no |
| branchAngle | 90°±25° | 90°±10° | 90°±2° | 75°±20°, curved |
| curvature/step | high | low | 0 | high |
| snapDist | 18 m | 22 m | 25 m | 12 m |
| minAngle | 30° | 45° | 60° | 35° |
| block target | 1–3 k m² | 3–8 k m² | 6–12 k m² rect | superblocks |
| alleys | yes (sub-branch in high cityness) | no | yes (mid-block) | no |
| cul-de-sacs | rare | no | no | **signature** |
| maxSegments | 4000 | 3000 | 2500 | 2000 |

`roadClass` emitted: `arterial | ring | street | alley | court`. Themes
map class→width; add the class→width ramps to each theme JSON +
`obsidian-native` builder (one PR, no schema break — same pattern as
existing `roadClass`).

## 7. Host wiring (the only non-`src/gen/` work)

1. `MapView.generateFabricHere` (city tier): resolve-or-create domain
   (modal for profile on create) → upsert manifest domain + tile entry
   (`domainId` set) → `generateDomainTile` → paint. Log `generate-area`
   with domainId. Command palette + right-click menu entries unchanged in
   shape.
2. **Replay** (`MapView` manifest replay): group entries by domainId,
   compute/read each network once, clip per entry. Cache-miss path must
   remain O(file read once).
3. **Auto-regen on sketch edit:** if a sketch's influence bbox intersects
   a domain disc, invalidate that domain's network record + regenerate its
   manifest tiles (debounced, existing `queueConstraintRegen` machinery;
   influence radius for domains = the domain disc, since growth is
   globally coupled within it — document this in the method JSDoc).
4. **Worker:** `generationWorker.ts` gains a `city-network` job type; same
   Blob-URL loading, same main-thread fallback. Network computation must
   run off-thread (it's the expensive one).
5. Painting: per-tile records keep today's generatorIds where possible so
   `layerOrder.ts` and themes change minimally; new ids
   (`city-parcel`, `city-landmark`) slot into the generated-fabric band.

## 8. Performance budgets (Tier B gate numbers)

- Network compute (radius 900, euro-medieval, maxSegments 4000): **≤ 2.0 s
  in the worker** on the dev machine; ≤ 4.0 s at radius 1500.
- Tile clip from cached network: ≤ 30 ms.
- Replay of a 20-entry manifest with warm cache: ≤ 500 ms added to map open.
- 60 fps pan unchanged (paint path is unchanged; feature counts per tile
  must stay within ~2× current — if parcels blow past that, gate them to a
  higher minzoom in themes, not in the generator).
- Memory: network graph ≤ 50 MB transient in worker.

## 9. Phases, each with exit gates (docs/06 protocol; snapshot fixtures per phase)

**v3.0 — domains + skeleton.**
Scope: §3 schemas/plumbing, `costField`, `skeleton`, host wiring 7.1–7.2;
per-tile output = arterials/waterfront/bridges/plaza only, old generators
still on for everything else.
Gates: (a) determinism byte-diff after cache delete; (b) 2×2 seam test with
a domain straddling the corner; (c) **arterial reachability** — every
arterial reaches its endpoint or a `degraded` flag exists; (d) bridge
crossings land on the river line; (e) screenshot: town visibly *shaped* —
radial spokes, river crossed not smeared.

**v3.1 — growth loop, euro-medieval only.**
Scope: `graph`, `growth`, D1–D6 hardening, sketched-road pre-seeding,
dead-end pruning. Old street generator off behind flag for domains.
Gates: (a,b) as above; (c) **junction histogram**: T-junction share >
4-way share; (d) **connectivity**: dangling/total endpoints < 0.15 inside
growth extent; (e) crash-free over 200 hashed domains (fuzz harness in
Vitest — the anti-Watabou gate); (f) budget: ≤ 2 s.

**v3.2 — faces → parcels → footprints.**
Scope: `faces`, `parcels`, wards; delete `districts.ts`/`blocks.ts` paths
for domains.
Gates: (a,b); (c) **block-shape entropy**: quads < 70% of blocks
(euro-medieval); (d) **alignment**: mean parcel-frontage angle deviation
< 15°; (e) zero thrown errors over the 200-domain fuzz (degenerate faces
counted, not thrown); (f) screenshot test vs `docs/04` — genre readable
in 3 s.

**v3.3 — cityness, outskirts, walls/gates, landmarks.**
Gates: (a,b); (c) street density falls monotonically outside core (sampled
ring statistic); (d) buildings-along-roads ribbon visible in screenshot;
(e) wall contour closes, gates = arterial crossings only.

**v3.4 — remaining profiles + cleanup.**
Scope: na-grid, na-suburb, euro-continental; delete dead v2 code; update
`procgen_explainer.md`.
Gates: junction histogram flips appropriately per profile (na-grid:
4-way > T; na-suburb: court count > 0 and loops present); all prior gates
green; `npm run test` + `test:app` clean; `dev:errors` clean after
reload+drive+screenshot loop from `dev-vault/`.

Every phase: update PROGRESS.md; any deviation from this doc → one-line
entry in DECISIONS.md; screenshots into `review/`.

## 10. Out of scope / parked (do not build; note in DECISIONS.md if tempted)

Domain merge/overlap resolution; interiors/floorplans stage; real-city
(PMTiles) campaigns — domains are fictional-CRS only for now (guard:
refuse domain creation when campaign CRS is real-world, Notice explains);
MST world routes; terrain-aware growth outside `heightAt`; named streets
(street `type: "street(named)"` labeling can reuse naming later — keep the
property shape).

## 11. Risks → mitigations

- **Planarization bugs (Watabou's hang):** int lattice (D1) + snap-round
  every inserted vertex + fuzz gate (v3.1e) + never-throw salvage (5.3.1).
- **Determinism drift:** D2 total ordering + byte-diff gate in *every*
  phase, not just release.
- **Perf blowout at radius 1500:** budgets in §8 gated at v3.1; fallback
  knobs: maxSegments, parcel minzoom, network-record splitting (§3.3).
- **Look misses the bar:** the histograms/entropy gates are proxies; the
  final arbiter is docs/04's screenshot test — if a phase passes metrics
  but fails the eye, tune profile params first, then escalate to Jonah
  before touching pipeline structure.
- **Schema regret:** every schema change here is additive with zod
  defaults/optionals; old vaults must open clean (test with a fixture
  vault containing a pre-v3 Generated.json).

---

*One-sentence summary for the agent: build `src/gen/citynet/` — a pure,
budgeted, integer-lattice, seed-total-ordered implementation of
skeleton→growth→faces→parcels scoped to manifest-recorded city domains,
clip it through the existing tile cache, pass the per-phase gates, and
delete the fur.*
