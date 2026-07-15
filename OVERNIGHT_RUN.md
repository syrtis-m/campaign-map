# OVERNIGHT RUN — pipeline arc 031→039 (2026-07-14)

Autonomous run per Jonah's goal: implement plans 031–039, parallelize with opus subagents,
build a new overlap-focused test map, commit+push continuously. Everything needing Jonah's
eyes lands HERE. Newest items at the top of each section.

## Ground rules in force
- **NO live Obsidian gates** (Jonah 2026-07-14) — all verification headless (Vitest, FakeHost
  counters, goldens, metric bands, fuzz); visual judgment via playground contact sheets.
- Commits per green phase on fast suite + tsc + build (+fuzz when generator behavior changed);
  explicit-path staging only (shared checkout — a parallel session has
  `review/v29-needs-adoption-panel.png` modified; untouched by this run).
- Vespergate untouched; the new test map is its own campaign (`dev-vault/Campaigns/Overlap`).

## Scope interpretations (flag if wrong)
1. **Plan 039**: the plan file says FUTURE ("do not schedule without a fresh ruling"), but the
   goal explicitly says "031 through 039" — I'm treating the goal as the fresh ruling and
   shipping **§1.1 only** (market-pin → plaza snap), per the plan's own "ship §1.1 first and
   alone". Temple/gate variants stay deferred.

## NEEDS JONAH'S EYES
- **Overlap campaign eyeball pass**: open `dev-vault/Campaigns/Overlap` in Obsidian (or view in
  the playground) and judge the generated result on the 8 overlap scenarios. Regenerate the
  campaign any time with `npx tsx scripts/emit-overlap-campaign.ts` — never hand-edit.
- **Wall-on-ring design call** (Overlap S2): the test wall traces the district ring exactly
  (offset 0) because any outward offset would cut the adjacent district / farmland shared edges;
  along the shared south edge the wall coincides with Newquarter's north boundary (old-wall/
  faubourg reading). Flag if plan-037 gate work wants a cleaner separation fixture instead.

## Landed
- **Plan 034 COMPLETE — the keystone** (`4a1d932`, `2239983`, `d8f0829`, `41e125f`, `cba1986`):
  sketches/pins are stage −1 DAG source nodes; ONE `runForwardPass` drives every trigger (flush,
  cascade, adopt, replay, undo) — `regenerateAffectedTiles`, `cascadeDownstream`,
  `cascadeFromRoot`, `forceRegenInStageOrder` all DELETED; runtime guards (stage monotonicity +
  closure bound) throw and are proven to fire via injected violations; cost-weighted cap
  (cheap 1/medium 2/expensive 4, budget 24, bills only fp-stale deferrable work); declined bills
  reopen to an OUTDATED badge with zero generator runs; preview mode (drag = root-only ephemeral,
  release = one pass, kill leaves no trace); adopt-all O(k). 955→974 fast + fuzz green.
  **Jonah's eyes:**
  1. Found + fixed a REAL live-vs-replay divergence: a city reading a procgen wall's raw line
     was left stale live but recomputed on replay — region roots now mint their own −1 source.
  2. Pinned-old + fp-stale on a cost-deferred replay serves pinned bytes WITH the outdated badge
     (visible-not-silent; ordinary pinned-old semantics untouched).
  3. Cap weights/budget (24) and Notice/panel wording are conservative picks — reword freely.
- **Plan 033 COMPLETE** (`790caff`, `58a3622`, `f593564` + 033-A `d9dacc2`): two-lane 32-bit
  hasher (measured 56 → 975 MB/s, 17.3×; FP_VERSION fp1→fp3 self-heals), registry
  `consumesSketch`/`influenceMargin`/`costClass` seeded from the HARNESS table, raw-channel
  invalidation now kind+margin-scoped (P4 fixture: road edit 3 regens → 1; district-add ⇒ zero
  neighbors), scoped fingerprints (P5 load-storm reopen recomputes ZERO out-of-reach regions;
  pinned-old region SURVIVES an unrelated far edit — the old global hash would have
  false-blanked it). 939→955 tests, fuzz harness green off the registry. Judgment calls:
  fp-equality force-skip is opt-in for the flush/cascade walk only (direct GM regenerate always
  recomputes); river/farmland's `mountain` consumption rides the upstream DAG fp path (mountain
  isn't a raw-constraint bucket) — no special-casing.
- **Plan 032 COMPLETE** (`8b2cc5a`, `5b5e4f0`, `6d77f3a`, `ff1f065`): per-region cache shards
  with verbatim-line streaming migration (pinned-old network record proven byte-identical —
  STOP condition never triggered), persistent per-controller cache view (one disk read per
  session, zero re-reads across batches), per-tile clip records eliminated (fixture city:
  55 records → 1; ~721 KB shard = network only — this was the bulk of 170 MB/17 regions),
  staged repaint (river→city flush repaints exactly stages [1,3] via MapLibre updateData diff
  on the single generated source — no theme/style surface change). 924→939 tests. Judgment
  calls: write-THROUGH not write-behind (undo-log hazard structurally impossible); view is
  per-controller (reopen = fresh view — deliberate, keeps pinned-old blanking + mid-session
  .mapcache-delete safety); world tier stays on the direct disk path.
  **Jonah's eyes: the MapView `updateData` staged-repaint path is build/tsc-verified only —
  judge it visually in your next normal app session** (pan around after an edit cascade).
- **Plan 033-A landed early** (`d9dacc2`, parallel with 032): the under-invalidation property
  harness — the shipping gate for everything consumption-keyed. TWO REAL FINDINGS vs the
  report §1 table: (1) **river also consumes mountain** (slope coupling on by default;
  compact-support field ⇒ 30 m margin suffices); (2) **city's influence margin is ~1500 m,
  not 200 m** (the exp(−d/60) road tensor blend has no cutoff — a road at 400 m still steers
  streets by whole degrees; measured byte-inert from ≈1 km). 33-C seeds from THIS table, not
  the report's. Prove-the-net: 4 intentional under-declarations all detected.
- **Plan 031 COMPLETE** (`cebb66f`, `02f0e07`, `5557ba6`, `a42cace`, `c111ec2`): network-once
  under force (P1), batching parity (one fp pass + one shared cache read + ≤1 repaint per batch),
  stage-ordered raw channel (P2/P3 correctness — ordering assertion verified to fail with the
  sort disabled), river/wall regen through the worker (spine across the boundary). 895→924 tests;
  independently re-verified (tsc+suite+build) before push. Judgment calls for Jonah:
  1. **Force semantics moved** from "always recompute network" to "recompute-if-absent" (caller
     clears the cache to force a true recompute) — an existing test's contract was updated.
  2. **Worker zod scope**: only the new `spine` field got a schema (`JobSpineSchema`); the rest of
     the job payload stays plain TS interfaces per pre-existing convention. Extending validation
     to the whole payload would be a follow-up.
  3. **P2 test note**: a water sketch edit can't byte-move a city (water only toggles river
     estuary dressing; the channel the city consumes is spine/params/elevation-driven) — the P2
     discriminator is the regen-order assertion + fingerprint-fresh⇒bytes-fresh property. Worth
     knowing if a later plan wants water→channel coupling.
- **Overlap test map** (`41f5790`): `src/gen/testkit/overlapMap.ts` — 9 deterministic scenario
  builders (S1 river×district, S2 wall-on-ring, S3 forest×river, S4 farmland shared-edge +
  downstream river, S5 park-in-district, S6 ε=0 adjacent districts, S7 mountain/farmland/river
  litmus, S8 typed `market` pin + untyped boundary pins) with premise-asserting tests (17) +
  emitted `dev-vault/Campaigns/Overlap` campaign. Seeds = `hashSeed(7341, featureId)`; procgen
  versions read from registry `currentVersion` at build time (a future bump changes emitted
  bytes visibly — re-emit + eyeball is the intended response).

## Deviations / STOP conditions hit
_(none yet)_

## Flakes / environment notes
_(none yet)_
