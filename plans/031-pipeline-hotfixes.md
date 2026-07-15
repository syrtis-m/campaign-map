# Plan 031 — Pipeline hotfixes: network-once, batched regen, stage-ordered raw channel, worker rivers

**Status:** TODO. Direction ratified via `plans/research-generation-pipeline.md` (Jonah 2026-07-14,
§9 Q1–Q6 OK'd). First of the pipeline arc (031→038); this plan is deliberately small, mostly
byte-identical, and safe to run alongside the 030 waves.

**Depends:** none. **Read first:** `plans/research-generation-pipeline.md` §3 (pathologies P1–P10 —
this plan fixes P1, P2, P3 and parts of P6/P7), CLAUDE.md. Verification is headless-only — the
docs/05 T1 "own live gate" clause does NOT apply to this arc (Jonah 2026-07-14).

## 0. Context for a cold-start implementer

The regen machinery has two invalidation channels (DAG cascade + raw-sketch reach). The research
report diagnosed ten pathologies; four are cheap, high-value, and independent of the later
rearchitecture (plans 032–034), so they land first:

- **P1** — `generationService.ts:176`: under `force`, the network-cache read is skipped *inside the
  tile loop*, so a forced regen of a T-tile region runs the full generator T times (byte-identical
  waste) and appends T duplicate network records.
- **P2 (live correctness bug)** — `MapController.regenerateAffectedTiles` walks affected regions in
  fabric-file order; a downstream region can read its upstream's OLD network record, the `done` set
  blocks any correction, and the record is stamped with the fingerprint of the *post-edit durable
  inputs* — so the stale bytes read as FRESH forever (survives reloads). Violates "the map is a
  pure function of the durable data".
- **P3** — the flush's roots loop runs in queue order, not stage order (same stale mechanism).
- **Worker spine loss** — `MapController.ts:567–574`: the worker protocol drops `region.spine`, so
  every river/wall (line-kind) regen runs on the main thread and blocks the UI.

## 1. Scope (four fixes, no architecture change)

1. **Network once per forced regen** (P1): hoist the network compute out of the tile loop (or make
   `force` consult the shared/preloaded map after the first write). Assert with the existing
   `generatorRunCount`: one forced T-tile region regen ⇒ exactly 1 generator execution.
2. **Batching parity** (P6/P7 partial, byte-identical): thread ONE `computeRegionFingerprints`
   result and ONE shared cache read through the flush and cascade paths, exactly as
   `replayGeneratedManifest` already does; coalesce repaints to one per flush/cascade batch.
3. **Stage-order the raw channel** (P2+P3): merge `affected ∪ roots` into a single worklist sorted
   by `(stage, id)` (`cascadeOrder`) and execute as one walk, so an upstream's fresh network always
   lands before a downstream reads it. This is a *correctness* fix: regions that were stale under
   P2 will produce different (correct) bytes — that is the fix working, not a determinism break.
4. **Line-kind regions through the worker**: carry `spine` across the worker boundary (it is plain
   data; extend the job payload + zod schema) so river/wall regen leaves the main thread.

## 2. Phases & verification (headless-only — NO live gates, per Jonah 2026-07-14: gate runs take
north of 2,000 s and are unreliable; every property proves in Vitest)

- **31-A (P1):** fix + `generatorRunCount === 1` per forced region regen (FakeHost); byte-diff
  golden proving output unchanged; assert no duplicate network records in the cache after a pass.
- **31-B (batching parity):** FakeHost vault-adapter read/write counters — one cache read + one fp
  pass per flush/cascade; repaint counter ≤ 1 per batch; full fast suite byte-green (parity is
  byte-identical by construction).
- **31-C (stage order):** the P2 regression test — fixture with a water polygon edit affecting a
  river and a city, fabric file order adversarially city-before-river ⇒ city bytes must track the
  NEW channel; plus the property test "record fingerprint fresh ⇒ bytes fresh" (regen from scratch
  equals cached bytes for every region after any single edit); plus a shuffled-fabric-file-order
  determinism test.
- **31-D (worker spine):** unit test that a line-kind job round-trips the worker with byte-identical
  output vs. the main-thread fallback; main-thread fallback retained.

Commit per green phase on the fast suite + tsc + build (+fuzz where generator behavior changed).
No live-gate runs, period.

## 3. STOP conditions / risks

- If fixing P2 tempts you to thread upstream state into a cache-HIT path, stop — that inverts the
  design (plan 024 §0): a hit must never need upstream fields; the fix is ordering + fresh writes.
- 31-C changes bytes only for regions that were *incorrectly stale*. If a golden flips for a region
  that was NOT stale under the P2 mechanism, that is a real regression — investigate, don't
  re-golden past it.
- Do not extend scope into consumption-aware invalidation (plan 033) or the unified pass (plan
  034); this plan's value is that it is small and lands now.
