# Plan 024 — Cross-layer regen cascade: layer-2 procgen output constrains layer 1

**Status:** research/design, approved direction from Jonah 2026-07-12 ("we want
all procgen meshes/things on layer 2 to impact layer 1 — so if we have a river
going through a city and we increase the windy-ness of the river, and it
regenerates, that should regenerate the city as well around that constraint").
Builds on plans 020/022/023. This is the contract that makes the suite feel
like one world instead of independent stamps.


## 0. Context for a cold-start implementer (read even if you skip everything else)

**The product in one line:** an Obsidian plugin giving a solo GM a
Google-Maps-style tab for tabletop campaigns; locations invented mid-session
become notes + pins in ≤5 s, and background world detail is procedurally
generated *only on explicit GM request*, deterministically, forever.

**Read before writing code:** `CLAUDE.md` (locked decisions — binding),
`plans/020-sketch-driven-procgen-regions.md` (the architecture you're
extending), `procgen_v3_design.md` §4 (determinism rules D1–D6 — binding),
`docs/05-dev-workflow.md` + `docs/06-autonomous-build.md` (build/gate
protocol), and skim `scripts/gates/procgen40.ts`/`procgen41.ts` (the live-gate
patterns to clone).

**State you inherit (plan 020, shipped):** the three-layer model — layer 1
procgen fabric (regenerable `.mapcache/` JSONL, disposable by design), layer 2
sketches (`Fabric.geojson`, GM-owned, selectable/editable via the Select tool),
layer 3 note-backed Locations (always on top; `layerOrder.ts` asserts it). A
sketched shape carrying a `procgen` block (`{algorithm, seed, version,
params}`) IS the generation request: `src/gen/procgen/registry.ts` maps
sketch-kind → algorithm; `src/gen/region.ts` is the polygon geometry core;
`src/gen/citynet/` computes a whole artifact per region which tiles then CLIP —
that is the seam story (adjacent tiles agree because they cut the same bytes).
The seed is persisted at creation and survives vertex edits (the identity
property: edits ADAPT output, only explicit re-roll REPLACES it). MapView owns
the lifecycle (sketch-finish → modal → generate; edit → debounced regen;
`sketch-procgen-set/clear`/`sketch-edit` log types with undo).

**Non-negotiable invariants (don't re-derive, don't violate):**
- *Explicit-only generation*: pan/zoom never generates (`generatorRunCount`
  stays flat in every gate); sketching/confirming IS the request.
- *Determinism is sacred*: same durable inputs → byte-identical output,
  forever; deleting `.mapcache/` must be harmless — a replay byte-diff is a
  release blocker, not a flaky test. Hence: params/seeds persisted, ids hashed
  on position/path never emission order, budgets not convergence, trig only
  for sampling, mm quantization + canonical sort on emit.
- *Generators are pure headless* `src/gen/` functions (no DOM/map/Obsidian
  imports, read only their arguments); zod at every IO boundary (bad data →
  warning, never silent drop, never crash).
- *Generators emit typed features only; themes own ALL paint.*
- *The GM's hand always wins*: output stays inside the sketched shape/corridor;
  sketch/location geometry is never overwritten.

**Infra pitfalls that cost previous agents real hours (all still live):**
- Obsidian CLI: `plugin:reload id=campaign-map`, NEVER `plugin:enable` (no-op
  when already enabled → you test stale code); async evals park results on
  `window` globals and poll; front the window before `dev:screenshot` and
  actually LOOK at it; `dev:errors` clean; run from `dev-vault/` only.
- Long Obsidian sessions degrade the renderer (`isStyleLoaded` false
  everywhere) — only a full process quit+relaunch clears it; run final boards
  one-gate-per-fresh-process.
- Modals hang CLI automation — every GM flow needs a headless test-API twin on
  `app.plugins.plugins['campaign-map']` running the FULL commit path
  (precedents: `createRegionForTest`, `moveVertex`, `setRegionParams`).
- Fictional campaigns sit at overview zoom ~z4.5 — never bake absolute zoom
  thresholds; Jonah's standing ruling: zoom LOD affects location-name
  visibility ONLY (fabric always renders).
- `dev-vault/Campaigns/Vespergate` holds Jonah's REAL campaign data (migrated
  district `fabric-mri7r4bj-ll0bd5`, 5 hand-sketched districts): gates use
  name-tagged fixtures, self-clean, and must leave his files byte-intact.
- Never bypass `appendCachedTile` (`src/model/tileCache.ts`) — cache appends
  serialize through a per-file promise chain (a fixed write race).

**Protocol:** phase-by-phase with one gate per phase (unit + live), PROGRESS.md
updated, every judgment call logged in DECISIONS.md, commit per green gate with
the `[gate: …]` message convention. Open questions need a ruling from Jonah or
the orchestrator — if unavailable, decide, log decision AND rationale in
DECISIONS.md, and flag it prominently in your report; never guess silently.

**Plan-024-specific intent:** the cascade exists so the world composes — the
GM should never manually re-run downstream things after tuning an upstream
knob. Two properties carry the whole design, and every implementation choice
must preserve them: (1) *cycle-freedom by construction* — the stage numbers
are a fixed partial order, so dependency resolution is trivial and
deterministic; resist any "just this once" same-stage dependency, it
reintroduces ordering ambiguity and breaks D2 for the host; (2) *replay
byte-stability* — a cache hit must never need upstream fields (determinism
guarantees the bytes already match a recompute), which is what keeps
"delete `.mapcache/` is harmless" true across multi-stage worlds. If you find
yourself threading upstream state into a cache-hit path, stop: either
determinism is already broken (find that bug first) or the design is being
violated.

## 1. The gap
Today `GenerationConstraints.fabricFeatures` carries RAW SKETCHED geometry only.
Once rivers/forests are procgen (sketched spine + params → generated channel),
the city must adapt to the GENERATED channel — which moves when the GM turns a
windiness knob — not to the original spine. And that adaptation must re-run
automatically, deterministically, and without cycles.

## 2. Stages — a fixed global partial order (cycle-free by construction)

Every registry algorithm declares a `stage`:

```
0 elevation   (mountain regions — a FIELD, plan 023)
1 hydrology   (river, water bodies)
2 vegetation  (forest, park)
3 settlement  (city)
4 detail      (wall elaboration, future street furniture)
```

- An algorithm may consume constraints only from strictly LOWER stages (plus
  raw sketches and canon Locations, as today). Same-stage regions never see
  each other's output (they see each other's *sketch* geometry only) — no
  ordering ambiguity, no cycles, ever.
- Replay/generation global order: `(stage, regionId)` lexicographic — one
  fixed, documented, deterministic sequence. Cache stays byte-stable because
  the order is data-independent (D2 for the host).

## 3. Constraint interface — fields, not feature soup

Plan 023's `Field`/SDF is the currency. Registry entries declare what they
produce and consume:

```ts
interface ProcgenAlgorithm {
  …
  stage: 0 | 1 | 2 | 3 | 4;
  produces: ConstraintKind[];   // e.g. river → ["water"]; forest → ["vegetation"]
  // generate() signature gains upstream context:
  generate(seed, regionOrSpine, params, constraints: GenerationConstraints): Feature[];
}
// GenerationConstraints gains:
//   upstream: { water: Field; vegetation: Field; elevation: ElevationField; … }
// each built from LOWER-stage generated output (SDF of channel polygons etc.)
// + the raw-sketch constraints that exist today (unchanged, back-compat).
```

- The host builds `upstream` per generation run: collect lower-stage generated
  features intersecting the target's bbox (+margin), build SDFs once, memoize
  per run. Generators keep reading only their arguments (D6) — the fields are
  arguments.
- **Worker boundary (adversarial review 2026-07-12):** `Field` closures do not
  survive structured clone. What crosses to the worker is DATA — the upstream
  feature lists (or compact quantized lattices for stage-0 elevation) — and
  the worker rebuilds the SDF closures on its side from that data. The
  registry's `generate()` therefore takes upstream as declarative inputs, and
  the field construction is a pure function both sides share.
- citynet consumes `upstream.water` exactly where it consumes sketched water
  today (blockedByWater/BRIDGE_COST paths) — bridges over the *meandered*
  channel, quays along its real bank. Forest consumes `upstream.water`
  (no canopy in the river). **One direction only:** the CITY (stage 3) sees
  vegetation (growth cost bump); the forest (stage 2) NEVER sees the city —
  canopy is not clipped by footprints; the town reads as a clearing because
  city fabric paints above canopy within layer 1 (see plan 022 §3.2, corrected
  2026-07-12 — an earlier draft implied a reverse dependency; reverse
  dependencies are rejected outright, they break cycle-freedom).

## 4. The cascade (Jonah's windiness scenario, made precise)

Dependency edges, computed at regen time (never persisted):
`A → B` iff `stage(A) < stage(B)` and `outputBBox(A) ∩ inputBBox(B) ≠ ∅`
(inputBBox = region/spine bbox + the algorithm's declared influence margin).

On commit of any edit to feature F (params, geometry, re-roll, procgen
set/clear — the plan-020 commit paths):
1. Regenerate F (drop its records, recompute).
2. Walk downstream: every feature G with F →* G (transitive, stage-ascending),
   in `(stage, regionId)` order, regenerate against fresh upstream fields.
3. One debounce window coalesces a drag storm into one cascade; one Notice
   summarizes ("River updated — regenerated 1 city, 2 forests"). Undo of the
   edit re-runs the same cascade with the restored inputs (deterministic → the
   downstream output is restored byte-identically for free).

Explicit-only survives: a cascade only ever RE-generates things the GM already
requested; it never first-time-generates. Pan/zoom Δ0 unchanged.

Cost control: cascade regen is per-affected-feature, worker-executed, serial in
stage order (upstream must land before downstream reads it). Vespergate-scale
(1 river + 1 city + a forest) is ~2–3 network computes ≈ interactive. A
100-region campaign turning a continental river's knob is the pathological
case — cap with a confirm above N downstream regenerations (N≈10). The
confirm must be Notice-with-action or command-palette based, NOT a modal, and
needs a headless test-API bypass (modals hang CLI automation — docs/05).

## 5. Replay
Campaign load ordering becomes: world tier (unchanged) → stage 0 fields →
stages 1–4 in `(stage, regionId)` order, cache-hit per feature as today. A
cache hit needs no upstream fields (bytes are already right — determinism
guarantees they match what a recompute would produce); only misses compute
fields. Deleting `.mapcache/` therefore still regenerates the whole world
byte-identically — the release-blocker invariant extends across the cascade,
and the gate must prove it with a multi-stage fixture (river+city+forest).

### 5.1 Staleness fingerprints (adversarial review 2026-07-12 — required)
"A cache hit needs no upstream fields" assumes the cache is FRESH — but
`Fabric.geojson` can change without any in-app commit path running (vault sync
from another device, external edits, a crash mid-cascade). A blind key-match
replay would then paint stale downstream output and silently violate "the map
is a pure function of the durable data". Fix: every whole-artifact cache
record stores an **input fingerprint** — a canonical hash of
`(seed, procgen version+params, quantized ring/spine, sorted upstream artifact
fingerprints, relevant raw-sketch constraint hashes)`. Replay treats a key hit
with a fingerprint mismatch as a MISS and recomputes (in stage order, so a
stale stage-1 recompute automatically invalidates its dependents' fingerprints
too). Deterministic, cheap (hashing durable data we already read), and it
hardens plan 020's single-region replay against external sketch edits as a
side effect. Gate: edit Fabric.geojson on disk (simulating sync), reopen —
downstream regenerates without any manual action; byte-diff gates unaffected
(fingerprints are themselves deterministic).

## 6. Gates (acceptance = Jonah's sentence)
- **Windiness gate:** river+city fixture; bump `windiness`; assert river
  channel changed, city regenerated, bridges/quays track the new channel, zero
  city geometry intersects the new channel, byte-determinism on second run,
  undo restores both byte-identically.
- Cascade-order determinism: shuffled manifest/fabric file order → identical
  bytes (order comes from `(stage, regionId)`, not file order).
- No-cascade isolation: editing a stage-3 city never touches the river.
- rm `.mapcache/` multi-stage replay byte-diff.
- Explicit-only: cascade never generates an un-requested feature; pan Δ0.

## 7. Open questions
1. ~~Stage of `wall`~~ RESOLVED (2026-07-12, with 022 §3.4's correction):
   the raw wall SKETCH is a stage-agnostic constraint every stage may read
   (suppresses the city's own wall near the rim, as today it stops streets);
   the procgen wall ELABORATION (towers/gates/moat) is stage 4, consuming
   stage-3 streets. The cascade never carries stage-4 output downward.
2. Elevation edits (stage 0) potentially cascade EVERYTHING — is a mountain-
   params drag too hot? Mitigation: elevation-consuming algorithms sample
   coarsely; consider a "apply on release" (no live preview) commit mode for
   stage-0 edits.
3. Should canon Locations join the DAG (moving a pin regenerates the city —
   already true today via constraint regen; formalize as stage −1 input)?
   Proposal: yes, formalize; no behavior change.
