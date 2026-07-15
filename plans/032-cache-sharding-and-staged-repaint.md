# Plan 032 — Cache sharding, persistent cache view, staged repaint

**Status:** TODO. Ratified via `plans/research-generation-pipeline.md` §6.3/§6.7/§6.8 and §9 Q6
(Jonah 2026-07-14: sharding confirmed within the "JSONL in .mapcache" locked decision).

**Depends:** 031 (batching parity groundwork). **Read first:** research report §3 "perf ground
truth" + §6 items 3/7/8; `src/model/tileCache.ts`; `src/map/generation/generationService.ts`.

## 0. Context for a cold-start implementer

Measured reality: `generated.jsonl` is **170 MB for 17 regions** (~10 MB/region ⇒ ~1 GB at 100).
Today every cache read parses the whole file (zod-walking every feature — hundreds of MB of
transients), every key drop rewrites the whole file (`tileCache.ts:95–102` — a 10-region cascade ≈
3.4 GB of vault IO), and every repaint is one whole-map `setData` re-index (4,313 features at 17
regions; p95 is already 52 fps on the DEV machine). These are the load-bearing floor of the later
forward-pass work (plan 034) — "retrofitting later means re-goldening the world twice", so they
land before the pass formalizes read/write patterns. Everything in `.mapcache/` is regenerable by
definition, EXCEPT that plan-029 pinned-old regions render **cache-only** — their network records
must survive any migration or they blank (needs-adoption badge). That is the one migration hazard.

## 1. Scope

1. **Shard the cache per region**: `.mapcache/region-<id>.jsonl` (world-tier records keep a shared
   shard, e.g. `world.jsonl`). Drops become file deletes; appends stay appends (keep the
   per-file promise-chain serialization from `appendCachedTile` — per shard now); reads scope to
   the regions a caller needs. Still JSONL in `.mapcache/`: the locked decision holds.
2. **Migration**: on first load with a monolithic `generated.jsonl` present, split it into shards
   (streaming, line-by-line — never hold the parsed whole in memory), then delete the monolith.
   Pinned-old regions' network records MUST be carried over byte-identically (gate below). The
   mutation log is untouched.
3. **Persistent in-memory cache view**: read shards once per campaign open (lazily per region is
   acceptable), mutate incrementally on every write, write behind. No code path may re-read a shard
   it already holds. `.mapcache` deletion mid-session must still be harmless (detect-and-rebuild on
   the next read miss).
4. **Stop persisting per-tile clip records** for whole-artifact regions (they duplicate the network
   record's bytes — the source of the 10 MB/region figure); re-clip from the in-memory network at
   paint time. Per-tile records remain for world-tier generators. This changes the cache FORMAT,
   not any generator byte (clipping is already deterministic; the same clip runs at paint instead
   of at write).
5. **Staged repaint**: split the generated source per stage (or adopt MapLibre `updateData` diffs)
   so a repaint scales with changed features, not total features; one repaint per STAGE per batch
   (≤ stage-count `setData`s), upstream stages first.

## 2. Phases & verification (headless — NO live gates, per Jonah 2026-07-14)

- **32-A (shards + migration):** FakeHost IO-counter tests (drop = file delete, no rewrite; append
  scoped to one shard); migration test on a fixture monolith incl. a pinned-old region whose
  network record must be byte-identical post-split; delete-`.mapcache` replay byte-diff still
  green.
- **32-B (persistent view):** read-counter assertions (≤1 read per shard per session; zero re-reads
  across two consecutive edit batches); crash-consistency test: kill the write-behind before flush,
  reopen ⇒ fingerprints treat missing records as misses and regenerate byte-identically.
- **32-C (no per-tile clip records):** cache-size assertion on a fixture region (network record
  only); paint-path unit test that re-clipped features equal the previously persisted per-tile
  records byte-for-byte; pinned-old region still renders from its network record alone.
- **32-D (staged repaint):** repaint-counter ≤ stages-touched per batch (render-hook seam); feature-
  count-per-repaint budget assertion. Visual judgment of the staged repaint happens in normal app
  use — no scripted live check.

## 3. STOP conditions / risks

- If pinned-old records cannot be carried over byte-identically, STOP and redesign the migration —
  silently blanking a pinned region violates the plan-029 contract.
- Write-behind must never reorder against the undo log's expectations; if sequencing gets subtle,
  flush-on-log-append is the safe fallback.
- Do not begin the unified pass here; 034 consumes these primitives.
