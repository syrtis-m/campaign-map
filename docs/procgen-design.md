# Procgen design — determinism doctrine + pipeline rationale

*Merged 2026-07-14 from `procgen_v3_design.md`, `procgen_explainer.md`, and
`procgen_v2_ideas.md` (all deleted; git history keeps them). This doc holds the two
things those documents carried that the code cannot: the **determinism engineering
rules (D1–D6)** and the **design rationale** — why the pipeline is shaped the way it
is. What the system currently does lives in ARCHITECTURE.md; how to work on it lives
in docs/dev-workflow.md; the code is the truth for everything else.*

## 1. The determinism contract (versioned — plan 029)

**Within an algorithm version: same `(seed, params, region, constraints)` ⇒ same
bytes, forever, on the same machine.** Between versions, generator authors are free —
a change that alters output bytes for the same inputs bumps the algorithm's
`currentVersion` (registry) and re-goldens; existing regions keep rendering their
pinned cached bytes until the GM explicitly adopts. See CLAUDE.md (locked decisions)
and ARCHITECTURE.md §12 for the full policy; `plans/029-versioned-determinism.md` for
its rationale.

Why bytes at all? Byte-determinism within a version is what lets the cache be
**disposable** (delete `.mapcache/` → regenerate identically), sync be
**conflict-free** (regenerable files are simply excluded), and seams be **provable**
(§3). The moment a generator consults global state or iteration order, all three
guarantees rot silently.

Two honest nuances:

- **Constraints are inputs too.** Sketch a river and regenerate → a *different*
  (still deterministic) map. A cache hit deliberately does not re-check constraints;
  the input fingerprint (`gen/cache/fingerprint.ts`) catches external edits on
  replay, and adapting is what regeneration is for.
- **Per machine only.** Trig differs across platforms and the cache never syncs —
  never assert byte-equality across machines.

## 2. D1–D6 — the engineering rules that make sequential reproducible

Growth-style generation is sequential; sequential + sloppy = flaky. These six rules
are binding for every generator (they are what make *any* version reproducible):

- **D1 — Integer lattice geometry.** All topology-deciding coordinates live on a
  **1 cm integer lattice** (meters ×100, rounded, stored as int).
  Intersection/orientation tests on ints are exact — this kills both FP
  nondeterminism and the collapsed-edge crash class in one move. Convert to float
  meters only when emitting features.
- **D2 — Total ordering everywhere.** Priority queues key on
  `(priority, candidateId)` where the id is a position/parent hash — no tie is ever
  resolved by insertion order. Every `sort()` ends its comparator in an id compare.
  Any Map/Set iteration that feeds output is re-sorted before use.
- **D3 — Budgets, not convergence.** Loops stop at a profile budget
  (`maxSegments`, `maxExpansions`) or queue exhaustion — never "until it looks
  done". Search failure takes a deterministic fallback path, never a throw.
- **D4 — Trig shapes, never decides.** `atan2/hypot/cos/sin` are fine for field
  *sampling*; they never gate topology on exact equality — comparisons happen on the
  D1 lattice.
- **D5 — Canonical output.** Emitted coordinates are mm-quantized
  (`Math.round(v*1000)/1000`); features sort by first-coordinate then id; properties
  stringify with fixed key order. Incidental upstream ordering can never leak into
  cached bytes.
- **D6 — No hidden inputs.** A generator reads *only* its arguments. No clocks, no
  host state, no version branches — the *code* is the version.

Enforced by: `expectGeneratorInvariants` / `expectDeterministic`
(`src/gen/testkit/invariants.ts`) in every generator suite, one byte-golden per
algorithm, and the mandatory 2×2 adjacent-tile seam tests.

## 3. Seam safety — the hard problem and the two resolutions

Tiles generate independently — possibly years apart — yet a street crossing a tile
edge must connect exactly. The classic algorithms (dsep streamline seeding, Bridson
Poisson-disc, MST networks) are **order-dependent**: what exists depends on what came
first, so independent tiles diverge at shared edges. The world tier is built from
order-free substitutes:

1. **Position-hashed seeding** (`spatialHash.ts`) — candidate points come from a
   coarse world grid where each cell independently hashes to zero-or-one jittered
   point: a pure function of `(seed, cellX, cellY, salt)`, seam-immune by
   construction (stratified, not true blue noise — accepted).
2. **Halo generation** — every tile computes over `bbox + halo`, then clips. The
   halo is sized so any feature that can poke into the tile is fully computed by it.
3. **Fields, not neighbors** — tensor/height/moisture fields are pure functions of
   world coordinates + the campaign's *fixed* `worldBounds` (never the tile bbox);
   every tile samples the identical field.
4. **Bit-identical clipping** (`clip.ts`) — Liang-Barsky / Sutherland-Hodgman: two
   tiles clipping the same geometry against their shared edge evaluate the same
   interpolation on the same vertex pair, so boundary points match to the bit.
5. **Local pairwise rules over global ones** — k-nearest-within-distance instead of
   an MST: a purely local rule cannot diverge across an edge.

**The region tier takes the halo argument to its limit.** Growth-based street
generation is inherently sequential (priority-queue expansion, T-junction snapping) —
exactly the order-dependence the rules above avoid. The resolution isn't order-free
math; it's **scope**: the whole network is computed **once per region** as a pure
function of `(seed, region, params, constraints)`, cached under
`region:<id>:network`, and every overlapping tile clips its bbox from that one
artifact. Tile A and tile B don't need to agree — they read the same bytes. In halo
terms: the halo became the whole city. Inside the pipeline, sequential still can't
mean sloppy — that's what D1–D3 are for.

Enforcement: 2×2 adjacent-tile seam tests are mandatory for every generator,
including with sketched constraints deliberately crossing the seams and a region
straddling the shared corner.

## 4. The city pipeline — why it is shaped this way

(The stage-by-stage mechanics live in ARCHITECTURE.md §6.3 and `src/gen/citynet/`;
this is the rationale that survived two full rewrites.)

- **v1 lesson (street *texture* → street *network*):** tensor-field streamlines
  alone read as "fur, not city" — endless texture with no comprehensible structure.
  A believable town needs a **skeleton** (why the town is shaped like a town):
  arterials routed to real destinations over a cost field (slope, water,
  canon-clearance), a plaza where they converge, a wall/ring where the profile says
  so. Structure first, texture second.
- **v2 lesson (honesty about growth):** European fabric cannot be faked with
  iso-lines or Voronoi alone; it needs **sequential growth** (Parish & Müller local
  constraints: snap / cut / T-junction / angle+length floors) seeded from the
  skeleton. The cost of sequential is paid with D1–D3, and its seam cost with the
  region-scoped compute (§3).
- **Blocks are the space between streets** (Watabou's move): faces of the planar
  street graph — never an independent partition that would disagree with the
  streets. Parcels split blocks by OBB recursion keyed
  `hashSeed(seed, blockId, path)`; footprints inset toward their frontage so
  buildings *face the street*. Degenerate geometry is skipped and counted, never
  thrown (the anti-hang rule).
- **The tensor field survived as an orientation prior** — its right job. It biases
  growth direction; it no longer *is* the street generator.
- **Cityness** (`interiorT`-based falloff × noise + canon-location bumps) modulates
  branch probability, snap distance, parcel size, and coverage — one scalar field
  carries "downtown dense, edge sparse, grows around the GM's pins".
- **Profiles are data, operators are code** (the 030-C convention): a new street
  pattern ships as a preset — params + data tables (`profiles.ts`) + existing
  operators (post-growth boulevard cuts, pre-growth seeds, faces-stage ring ops like
  the chamfer). Preset-conditional branches inside generator stages are not
  allowed; a genuinely new mechanism becomes a new *operator*, reusable by every
  preset.
- **The GM's hand always wins:** sketched roads pre-seed the graph as immutable
  edges (generated streets snap *to* them); sketched water/walls are hard
  constraints; all output is contained by the sketched ring; canon locations are
  never paved over.

## 5. What was deliberately rejected

- **Canonize/promote** (generated feature → note): deleted — it made the generator a
  source of truth. Humans own durable things; the generator owns nothing durable.
- **Generation from pan/zoom**: explicit-only, forever (`generatorRunCount` flat
  under any camera movement is a standing assertion).
- **Global algorithms** (MST routes, global relaxation): globally coupled = seam
  divergence; local rules only.
- **Per-version generator code forks**: old bytes survive via cache + adoption
  consent, never via legacy code paths (plan 029 §4).
- **SQLite / OPFS / IndexedDB**: the cache is regenerable JSONL; a database earns
  nothing.
