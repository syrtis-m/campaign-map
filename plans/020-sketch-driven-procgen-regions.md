# Plan 020 — Sketch-driven procgen regions (the three-layer model)

**Status: v4.0–v4.2 SHIPPED 2026-07-12** (commits 430710c / 55db381 / be4f0c1;
gates procgen40 10/10, procgen41 16/16; two mid-build Jonah rulings folded in:
always-visible building detail, GM-draggable persisted city center —
`params.center`). **v4.3 (consolidation + full board) in flight.** Current
status lives in `plans/README.md`; deviations and judgment calls in
DECISIONS.md. Originally: approved by Jonah 2026-07-12 ("i want to be able to sketch an area within
which procgen occurs — the district sketch tool should do this"). This plan
supersedes parts of plan 019's two-layer model and the procgen-v3 disc-domain
trigger; Jonah's message is the authorization to amend those locked decisions.

## 1. Vision

Move from the two-layer model to a **three-layer model**:

| layer | contents | source of truth | editability |
|---|---|---|---|
| 3 (top) | **Locations** — note-backed canon pins | markdown notes w/ `map:` frontmatter | notes |
| 2 | **Sketch** — GM-drawn shapes (roads, walls, rivers, water, districts, parks) | `Fabric.geojson` | select/edit any time (vertices + properties), PowerPoint-style |
| 1 (bottom) | **Procgen fabric** — generated output | regenerable `.mapcache/` only | never directly; only via the sketch shape or params that drive it |

The key inversion: **a sketched district polygon IS the request for city
procgen.** Sketch a district → the city generator runs inside that polygon.
The disc-domain flow (click at z≥8 → DomainProfileModal → disc) is retired.
Sketch shapes become the durable, selectable, re-editable handles on generated
content: move a vertex → the city adapts; open the shape's procgen settings →
change profile/seed → the city regenerates; delete the shape → the city is gone.

**Extensibility requirement (architect for it now):** district→city is the
first binding in a **sketch-kind → procgen-algorithm registry**. Future
bindings (park→park-gen, and future kinds like forest/mountain polygons,
river-kind enrichment) must slot in by adding a registry entry + params schema
+ pure generator — zero new host lifecycle code.

## 2. What stays true (unchanged invariants)

- Generation is **explicit-only**: sketching/editing a district is the explicit
  GM request. Pan/zoom still never generates (`generatorRunCount` stays flat).
- Generators stay **pure headless** `(seed, region, params, constraints) => Feature[]`
  in `src/gen/` — no DOM/map/Obsidian imports.
- Determinism D1–D6 (procgen_v3_design.md §4) still binding; §7 below maps them
  onto regions.
- Output stays regenerable JSONL in `.mapcache/`; deleting it must be harmless.
- Locations always render on top; generated renders **below** sketched
  (layerOrder.ts already encodes exactly the 3-layer z-order — this plan makes
  it the named model).
- Sketched fabric (rivers/roads/walls/water) still feeds every generator run as
  constraints. Locations still bump cityness.
- World tier (`world-region`/`world-route`, z<8 click-to-generate,
  Generated.json entries) is **untouched** by this plan.
- Fabric never promotes to a Location.

## 3. Data model

### 3.1 The procgen block (on the fabric feature)

`FabricFeatureSchema.properties` gains an optional `procgen` block:

```ts
procgen: z.object({
  algorithm: z.string().min(1),          // registry id, e.g. "city"
  seed: z.number().int(),                // persisted at creation; stable across vertex edits
  version: z.number().int().default(1),  // schema version of `params`
  params: z.record(z.string(), z.unknown()), // validated by the algorithm's own zod schema
}).optional()
```

- A district feature **with** a procgen block is a **procgen region**; without
  one it is an inert overlay shape (modal cancel path, see §6.1).
- `seed = hashSeed(campaignSeed, feature.id)` computed **once at creation** and
  persisted. Vertex edits do NOT change it — the city keeps its identity while
  its boundary adapts. A "Re-roll" action replaces it with
  `hashSeed(seed, "reroll")` (logged). Determinism holds because the seed is
  durable data in `Fabric.geojson`, not derived at run time.
- City params v1: `{ profile: ProfileId }` (validated by the city algorithm's
  zod schema; room to grow — density, wall override, etc.).

### 3.2 Manifest slimming + migration

- `Generated.json` keeps `entries` for **world tier only**. City-tier replay is
  now derived from the sketch layer: every fabric feature with a procgen block
  is regenerated/re-clipped on campaign load (cache hit or recompute).
  City-tier manifest entries and the `domains` array are **retired**.
- **Migration (one-way, on campaign load):** if `manifest.domains` is non-empty,
  each disc converts to a district fabric feature — 32-gon polygon at
  `(cx, cy, radius)`, `procgen: { algorithm: "city", seed: citySeedFor(campaignSeed, domain), version: 1, params: { profile } }` —
  appended to Fabric.geojson (`sketch-add` log entries so undo works), the
  domain + its city-tier entries removed from the manifest, city cache records
  for the old keys dropped, one Notice ("N city domains migrated to sketched
  districts"). Old schemas stay parseable (zod fields kept optional).
- The city regenerates under the new polygon math — output will differ from the
  v3 disc build. Accepted (pre-release; the request, not the bytes, is durable).

### 3.3 Cache keying (fixes a latent v3 collision)

Two non-overlapping regions can still overlap the same tile; v3's per-tile keys
(`seed:x:y:z:generatorId`) would clobber. New keys carry the region:

- whole network: `region:<regionId>:network`
- per-tile clip: `region:<regionId>:<tileX>:<tileY>:<generatorId>`
- render-store keys: `region:<regionId>:<x>:<y>`

`CachedTileSchema.key` is free-form; no schema change needed.

## 4. Region geometry core (new pure module `src/gen/region.ts`)

Built once per generation run from the fabric polygon (converted to
generation-space meters by the host, same path as existing sketch constraints;
vertices quantized to mm on ingest — D5):

```ts
export interface ProcgenRegion {
  id: string;             // fabric feature id
  ring: Pt[];             // closed polygon ring, gen-space meters, mm-quantized
  bbox: BBox;
  centroid: Pt;           // area centroid (deterministic closed-form)
  area: number;
  effectiveRadius: number; // sqrt(area/π) — replaces `radius` in size-scaled params
}
export function makeRegion(id: string, ring: Pt[]): ProcgenRegion;
export function regionContains(r: ProcgenRegion, x: number, y: number): boolean;   // even-odd
export function distanceToBoundary(r: ProcgenRegion, x: number, y: number): number; // exact per-segment, signed (+inside)
export function interiorT(r: ProcgenRegion, x: number, y: number): number;
// 0 deep inside → 1 at boundary, >1 outside: 1 - distanceToBoundary/maxInteriorDistance,
// where maxInteriorDistance is computed on a deterministic 10 m lattice over bbox
// (coarse but pure; robust for concave polygons where polar-from-centroid breaks).
export function boundaryPointAt(r: ProcgenRegion, angle: number): Pt | null;
// first ray/boundary crossing from centroid — used by skeleton gates/arterials.
export function insetRing(r: ProcgenRegion, inset: number): Pt[];
// deterministic polygon inset (miter-clamped) — the wall/ring-road path.
```

Validation at ingest: ring must be simple-enough (self-intersection check;
reject with Notice, never crash), area ≥ ~π·(150 m)² (below the useful minimum),
≤ π·(2500 m)² (perf valve, mirror of the old radius clamp).

## 5. Algorithm registry (new pure module `src/gen/procgen/registry.ts`)

```ts
export interface ProcgenAlgorithm {
  id: string;                        // "city"
  label: string;                     // "City"
  appliesTo: readonly FabricKind[];  // ["district"]
  paramsSchema: z.ZodType<Record<string, unknown>>;
  defaultParams(themeId: string): Record<string, unknown>; // theme → euro-medieval etc.
  tileGeneratorIds: readonly string[]; // e.g. DOMAIN_TILE_GENERATOR_IDS
  generate(seed: number, region: ProcgenRegion, params: Record<string, unknown>,
           constraints: GenerationConstraints): GeoJSON.Feature[];
}
export function algorithmForKind(kind: FabricKind): ProcgenAlgorithm | undefined;
export function algorithmById(id: string): ProcgenAlgorithm | undefined;
```

v1 registers only `city` (wrapping `generateCityNetwork`). `clipNetworkToTile`
stays shared. The worker job becomes
`{ kind: "procgen-region", algorithmId, seed, ring, params, constraints }`
(main-thread fallback preserved). Host lifecycle code must consult the registry
only — never `if (kind === "district")`.

## 6. Citynet generalization (disc → polygon)

`CityDomain {cx, cy, radius}` is replaced by `ProcgenRegion` throughout
`src/gen/citynet/`. Mechanical mapping:

- `pointInDomain` → `regionContains`; `domainBBox` → `region.bbox` (+margin).
- cityness falloff `t = |p−c|/radius` → `t = interiorT(p)`; same
  `max(0, 1−t²)` curve. Canon bumps: membership via `regionContains`.
- costField lattice over `region.bbox` + 200 m margin.
- skeleton: plaza at `centroid`; arterial gate points via `boundaryPointAt`
  (profile's gate azimuths unchanged); **wall + ring road follow
  `insetRing(region, inset)`** instead of a circle — sketch the city limits and
  the wall traces them (this is the payoff feature). Gates where arterials
  cross the ring, as today.
- growth extent: `regionContains` && cityness threshold, as today.
- outskirts bands: by `interiorT` — strictly inside the polygon (the sketch is
  the outer limit of ALL output; nothing spills past the GM's line).
- wards: sites inside polygon. **The plan-019 "sketched district excludes ward
  sites" constraint is retired** — a district now IS the city container, and
  procgen regions of the same algorithm may not overlap (reject at creation
  with Notice, like `domainsOverlap`). `districtRings` leaves
  `FabricConstraintIndex`.
- radius-scaled params (arterial count, growth budget…) → `effectiveRadius`.
- `domain.ts` shrinks to the lattice/seed helpers migration still needs;
  `citySeedFor` kept for migration only.

Unit gates: determinism (same inputs → byte-identical features, twice),
2×2 seam via clip (unchanged mechanism), concave-polygon smoke (L-shaped
region: all output inside, no throw), disc-equivalent sanity (32-gon ≈ old
disc metrics within tolerance), 4-profile fuzz on random polygons (no throw).

## 7. Determinism rules restated for regions

- D1: region identity = fabric feature id; seed persisted, never derived from
  floats at run time.
- D2: unchanged (total-order heaps, position-derived keys).
- D3: budgets not convergence — budgets scale on `effectiveRadius`.
- D4: trig only for sampling — `boundaryPointAt` is sampling; `insetRing` and
  `distanceToBoundary` must be closed-form arithmetic on mm-quantized input.
- D5: ring mm-quantized at ingest; emitted coords mm-quantized + canonical sort.
- D6: generators read only their arguments; `createdAt`/edit timestamps never
  cross in.

## 8. Host lifecycle (MapView)

### 8.1 Create
Finish a district sketch → save the shape (as today, `sketch-add`) → open
**RegionProcgenModal** (generalized DomainProfileModal, form driven by the
registry entry's `paramsSchema`/`defaultParams`): "Generate city" attaches the
procgen block (`sketch-procgen-set` log entry) and generates the whole region —
one network compute, clip to every overlapping tile, paint. **Cancel keeps the
shape inert** (procgen can be enabled later from the edit menu). No zoom gate:
city procgen is polygon-scoped, not zoom-scoped. The old founding path
(z≥8 click → disc) is removed; "Generate fabric here" at city zoom inside a
region = re-clip/repaint; outside any region = Notice pointing at the district
tool ("Sketch a district to generate a city").

### 8.2 Replay (campaign load)
World-tier entries replay from the manifest as today. Then every fabric
feature with a procgen block replays: cache-hit per-tile clips, else recompute
network (once) + clip. Single cache read shared across regions.

### 8.3 Edit → regenerate
Any geometry or params edit to a region (vertex drag/insert/delete, profile
change, re-roll) → debounce (existing `queueConstraintRegen` timer) → drop that
region's cache records → recompute + repaint. Edits to constraint-kind sketches
(river/road/wall/water) → regenerate every region whose bbox intersects the
edited feature's bbox (replaces the domain-bbox version).

### 8.4 Clear / delete / undo
- "Remove generated city" (context menu / edit panel): strips the procgen block
  (`sketch-procgen-clear` log entry) + drops cache records + unpaints. Shape
  stays, inert.
- Deleting the shape (`sketch-remove`): also drops cache + unpaints.
- Clear-all-generated: strips every procgen block + drops all region records
  (world tier as today).
- Undo: new log types `sketch-edit` (carries before+after feature),
  `sketch-procgen-set` / `sketch-procgen-clear` (carry before+after procgen
  block). Undo restores the prior feature state and re-runs/clears accordingly.
  Existing `sketch-add`/`sketch-remove` undo unchanged.

## 9. Edit UX (PowerPoint-style, all sketch kinds)

- Sketch sub-bar gains a **Select** tool (arrow icon, first position). Click a
  sketch feature → selected: accent highlight + draggable vertex handles +
  midpoint handles (click-drag to insert a vertex); `Backspace`/`Delete` on a
  grabbed vertex removes it (min-vertex floor enforced); `Esc`/click-empty
  deselects; `Delete` with no vertex grabbed deletes the whole shape (confirm
  via Notice-with-undo, not a modal).
- Selected feature panel (small overlay, bottom of sketch bar): name field,
  kind label, and — when the kind has a registry algorithm — the procgen
  section: enable/params (schema-driven form)/re-roll/regenerate/remove.
- Right-click a sketch feature at ANY time (outside sketch mode too): context
  menu gains "Edit shape" (enters sketch mode with it selected) and, for
  regions, "City settings…". The existing click grammar (pin/place-card/
  dropped-pin) is untouched — sketch features participate only via right-click
  outside sketch mode.
- Geometry edits write `sketch-edit` to the log and persist Fabric.geojson
  (same optimistic-render-then-IO path as sketch-add).

## 10. Phases and gates (docs/06 protocol; commit per green gate)

- **v4.0 — pure core**: `region.ts`, registry, fabric schema `procgen` block,
  citynet generalized to regions, `districtRings` retirement, unit gates of §6.
  No host changes; `npm test` green; old host still compiles against a thin
  disc→region shim if needed within the phase, removed by v4.1.
- **v4.1 — host lifecycle**: RegionProcgenModal, sketch-finish trigger flow,
  region cache keys, replay-from-sketch-layer, migration, clear/delete flows,
  worker job, new log types (set/clear), explicit-only gate preserved.
  Integration gate `scripts/gates/procgen40.ts` (live Vespergate: sketch a
  district headlessly → city appears; byte-diff cache after rm+replay; pan
  generates nothing; migration of a seeded pre-v4 manifest).
- **v4.2 — edit UX**: Select tool, vertex handles, `sketch-edit` log + undo,
  params panel, edit→regen loop. Gate `procgen41.ts` (move a vertex → city
  adapts + determinism holds; re-roll changes city; remove-procgen leaves inert
  shape; screenshot review).
- **v4.3 — 3-layer consolidation**: layerOrder comments/tests renamed to the
  three-layer model, gates procgen30–34 + phase3/4 modernized to sketch-driven
  flows, DomainProfileModal deleted, CLAUDE.md + docs updated (docs subagent
  runs in parallel from this plan), DECISIONS/PROGRESS entries, full board
  green one-gate-per-fresh-process.

## 11. Decisions made in this plan (log to DECISIONS.md as they land)

1. Sketch layer is the source of truth for city-tier requests; Generated.json
   manifest shrinks to world tier. (Amends plan-019 D1 wording.)
2. Region seed persisted at creation from `hashSeed(campaignSeed, featureId)`;
   vertex edits preserve city identity; explicit re-roll only.
3. Modal cancel keeps an inert district (procgen opt-in later) — sketching a
   shape never silently runs a generator the GM didn't confirm.
4. All generated output stays strictly inside the sketched polygon.
5. Ward-exclusion role of sketched districts retired; same-algorithm regions
   may not overlap.
6. Per-tile cache keys gain the region id (fixes latent v3 same-tile
   two-domain clobber).
7. v3 disc domains migrate one-way to 32-gon district sketches; regenerated
   output may differ from the disc build.
