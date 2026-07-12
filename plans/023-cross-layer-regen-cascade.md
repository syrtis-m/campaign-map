# Plan 023 — Cross-layer regen cascade: layer-2 procgen output constrains layer 1

**Status:** research/design, approved direction from Jonah 2026-07-12 ("we want
all procgen meshes/things on layer 2 to impact layer 1 — so if we have a river
going through a city and we increase the windy-ness of the river, and it
regenerates, that should regenerate the city as well around that constraint").
Builds on plans 020/021/022. This is the contract that makes the suite feel
like one world instead of independent stamps.

## 1. The gap
Today `GenerationConstraints.fabricFeatures` carries RAW SKETCHED geometry only.
Once rivers/forests are procgen (sketched spine + params → generated channel),
the city must adapt to the GENERATED channel — which moves when the GM turns a
windiness knob — not to the original spine. And that adaptation must re-run
automatically, deterministically, and without cycles.

## 2. Stages — a fixed global partial order (cycle-free by construction)

Every registry algorithm declares a `stage`:

```
0 elevation   (mountain regions — a FIELD, plan 021)
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

Plan 021's `Field`/SDF is the currency. Registry entries declare what they
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
- citynet consumes `upstream.water` exactly where it consumes sketched water
  today (blockedByWater/BRIDGE_COST paths) — bridges over the *meandered*
  channel, quays along its real bank. Forest consumes `upstream.water`
  (no canopy in the river) and cities subtract from canopy at stage-2→3? No —
  subtraction the other way: forest is stage 2, city is stage 3, so the CITY
  sees vegetation (cost bump, clearings around footprints handled by forest
  re-clip in §4). Keep one direction only; document it.

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
case — cap with a confirm Notice above N downstream regenerations (N≈10).

## 5. Replay
Campaign load ordering becomes: world tier (unchanged) → stage 0 fields →
stages 1–4 in `(stage, regionId)` order, cache-hit per feature as today. A
cache hit needs no upstream fields (bytes are already right — determinism
guarantees they match what a recompute would produce); only misses compute
fields. Deleting `.mapcache/` therefore still regenerates the whole world
byte-identically — the release-blocker invariant extends across the cascade,
and the gate must prove it with a multi-stage fixture (river+city+forest).

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
1. Stage of `wall`: sketched-wall-as-constraint is stage-agnostic today
   (feeds city growth); procgen wall elaboration is stage 4 consuming city
   streets (gates where streets cross). Ruling needed when 022 §3.4 lands.
2. Elevation edits (stage 0) potentially cascade EVERYTHING — is a mountain-
   params drag too hot? Mitigation: elevation-consuming algorithms sample
   coarsely; consider a "apply on release" (no live preview) commit mode for
   stage-0 edits.
3. Should canon Locations join the DAG (moving a pin regenerates the city —
   already true today via constraint regen; formalize as stage −1 input)?
   Proposal: yes, formalize; no behavior change.
