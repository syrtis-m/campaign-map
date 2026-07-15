# Progress

*Updated after every gate run. A fresh session should be able to resume from CLAUDE.md + this file alone.*

## Status: plans 029 + 030 COMPLETE (2026-07-14) — the versioned-determinism + rearchitecture arc is done. Pipeline arc (031–038) STARTED: plans 031 + 032 + 033 COMPLETE (2026-07-15). Plans 020–028 complete.

## Plan 033 — consumption-aware invalidation (2026-07-15, COMPLETE — headless-only per Jonah 2026-07-14)
Declare per algorithm which raw sketch KINDS it reads and how far they reach, then
scope both the invalidation walk and the staleness fingerprint to that — killing
the P4 over-invalidation (a road edit regenerating mountains) and the P5 load-storm
(any sketch edit flipping every region's fingerprint). Verified in Vitest + FakeHost
counters + the 033-A fuzz gate; NO live gates. 955 fast + 36 fuzz green.
- **[x] 033-A — under-invalidation property harness** (`d9dacc2`, prior session): the
  shipping gate. `checkUnderInvalidation` proves per algorithm × sketch-kind that any
  non-declared kind (overlapping/touching/far) and any declared kind beyond its margin
  are BYTE-INERT — so an under-declaration fails HERE. Runs in the fuzz tier forever.
- **[x] 033-B — fast fingerprint hasher** (`790caff`): the FNV-1a BigInt-per-char hasher
  (~56 MB/s measured) replaced by a pure-TS two-lane 32-bit hash (cyrb-style, two
  `Math.imul` lanes cross-mixed, same 16-hex width) — **975 MB/s, 17.3x** on a 127 KB
  ring string. Perf is a BUDGET COUNTER (`hashByteBudget`: bytes/pass), never wall-clock
  (docs/06). Hash-equivalence not required: `FP_VERSION fp1→fp2` self-heals one recompute.
- **[x] 033-C — registry consumption declarations** (`58a3622`): each algorithm declares
  `consumesSketch` (raw kinds it reads), `influenceMargin` (m, bbox-to-bbox), `costClass`
  (routing data for plan 034's cap — nothing keys on it yet). Values from the 033-A
  VERIFIED table: city water/river/road/wall/farmland@1500 expensive; river
  water/river/mountain@30 medium; park road@30; wall road@0; farmland mountain@0;
  forest/mountain none. The fuzz harness now reads them off the registry (temporary
  MEASURED_CONSUMPTION fixture deleted; prove-the-net clones kept); a `registry.test.ts`
  row pins the exact values. `affectedRegionIds` switches from the blanket 200 m
  kind-blind reach to `kind ∈ consumesSketch ∧ bboxGap ≤ influenceMargin` — **P4: 3
  regens → 1** (road edit no longer regenerates mountains/forests); district-add ⇒ zero
  neighbour regens; margin scopes near-vs-far. The DAG output-coupling reach
  (CONSTRAINT_REACH, buildRegionUpstream/upstreamEdges) is deliberately unchanged.
- **[x] 033-D — scoped fingerprints** (`<this commit>`): `canonicalConstraints` now hashes
  ONLY the consumed kinds within the influence bbox (+ upstream DAG fps as before), so a
  far / non-consumed sketch edit leaves a region's fingerprint intact. `FP_VERSION
  fp2→fp3` (self-heal). The fp pass THROWS on a missing upstream fp (never silently
  filters — a dangling DAG edge surfaces). An invalidation-walk force whose recomputed
  fp equals the cached record's is SKIPPED (`skipInertForce`, flush/cascade opt-in only —
  a direct GM regenerate/adopt always recomputes, preserving 031-A): declared-but-inert /
  no-op edits become free (`inertForceSkipCount`). Proof: scoped hash inert to a far/
  non-consumed edit but flips inside the bbox; P5 load-storm (reopen after a far external
  road recomputes ZERO out-of-reach regions); a pinned-old region survives an unrelated
  far edit (no needs-adoption badge, no blank — the global hash would have false-blanked
  it); an inert re-commit skips the generator run.
- **STOP conditions honored**: no behavior keys on `consumesSketch` beyond what 033-A
  verifies; the invalidation walk is never special-cased (a missed read is fixed in the
  DECLARATION, harness catches it); delete-`.mapcache`+replay stays byte-identical; no
  plan 034 source-nodes / unified-pass / cost-cap behavior begun.

## Plan 032 — cache sharding, persistent view, staged repaint (2026-07-15, COMPLETE — headless-only per Jonah 2026-07-14)
The load-bearing cache/repaint floor for the pipeline arc (research §3, §6.3/6.7/6.8).
Verified in Vitest + FakeHost IO/repaint counters only (no live gates). +15 tests
(939 total green; the sole tsc error is a parallel session's untracked plan-033
`underInvalidation.*`, not this work).
- **[x] 032-A — shard the cache per region** (`8b2cc5a`): `generated.jsonl` split by
  key into per-region `region-<id>.jsonl` + a shared `world.jsonl` (keys DISJOINT
  across shards). A drop rewrites — or, for a whole-region drop, DELETES — only the
  one shard (research P6: a 10-region cascade was ~3.4 GB of vault IO); appends/reads
  scope to a shard; `readCachedTiles` enumerates shards via `adapter.list`. Migration:
  a pre-032 monolith splits line-by-line on first touch (per-folder lock, idempotent
  truncate-write, then delete), routing RAW line strings so records — incl. a
  pinned-old region's network record (the plan §3 STOP condition) — carry over
  BYTE-IDENTICALLY. Proof: region records land only in their shard; a drop deletes its
  shard + rewrites no sibling; a monolith migrates + self-deletes byte-for-byte; the
  pinned-old STOP gate (network line verbatim, still renders cache-only).
- **[x] 032-B — persistent in-memory cache view** (`5b5e4f0`): the cache is read from
  disk ONCE per campaign open (`cacheView`) and served from memory; region appends
  `.set()` into it and drops (`dropCached`) write through to disk AND `.delete()` from
  it, so no batch re-reads a held shard (research P7). Owned per-controller (not a
  module global) — a fresh controller (`reopen`/switch) starts empty, so
  delete-`.mapcache`-then-reopen still blanks a pinned-old region and a lost write is
  a fingerprint MISS that regenerates byte-identically (write-through, not deferred
  write-behind — determinism makes lost writes harmless, sidestepping the undo-log
  sequencing hazard). World-tier tiles stay on the direct `getCachedTile` disk path.
  Proof: one disk read per session, ZERO re-reads across consecutive batches;
  crash-consistency (cleared cache regenerates byte-identically on reopen, view
  rebuilt on the miss); a drop clears the live view. The 031-B per-batch read
  assertion tightens 1→0.
- **[x] 032-C — stop persisting per-tile clip records** (`6d77f3a`): a region wrote a
  network record PLUS one per-tile clip per (tile × generator) — the per-tile clips
  just re-sliced the network's bytes (the ~10 MB/region figure). Now ONLY the network
  record persists; tiles RE-CLIP it on demand (`clipNetworkToTile`, pure), so bytes
  are byte-identical to the dropped per-tile records and the network is both the
  freshness authority and the fast path. World tiers keep their own records.
  Measured on the RING city fixture: **55 region cache records → 1** (54 per-tile
  clips eliminated; 9 tiles × 6 generators). Pinned-old still renders from its network
  alone. Proof: exactly ONE persisted region record; a re-clip == `clipNetworkToTile`
  of the persisted network byte-for-byte; forced regen leaves record + render
  byte-identical.
- **[x] 032-D — staged repaint** (`<this commit>`): a batch now fires ONE repaint per
  TOUCHED DAG STAGE, upstream-first (`dirtyStages` in `withRepaintBatch`), not one
  blanket paint — a river→city cascade repaints stages [1,3] and never touches the
  untouched mountain (stage 0). MapView scopes each staged repaint to that stage's
  features via an incremental `updateData` diff (single `generated` source, no
  theme/layer changes; full `setData` on the no-stage initial/replay path). MapView
  side is build+tsc-only; visual judgment deferred to normal app use (plan §2). Proof
  (FakeHost `repaintGeneratedStages`): river→city flush repaints `[1,3]` (upstream-
  first, no `0`, no full paint); a single city regen repaints `[3]`; world generation
  repaints the WORLD_STAGE bucket; a stage's feature budget ⊂ the whole map.
- **STOP conditions honored**: pinned-old records migrate + render byte-identically
  (never blanked/re-derived); delete-`.mapcache`+replay stays byte-identical; no plan
  034 unified pass begun.

## Plan 031 — pipeline hotfixes (2026-07-15, COMPLETE — headless-only per Jonah 2026-07-14)
Four fixes from `plans/research-generation-pipeline.md` §3; mostly byte-identical,
verified in Vitest only (no live gates this arc).
- **[x] 031-A — network once per forced regen (P1)** (`cebb66f`): `generateRegionTile`
  under `force` recomputed the whole-region network once PER TILE (T× waste + T
  duplicate network records). Now force consults the (preloaded) cache like the
  non-force path — the first tile computes + writes, every later tile of the pass
  re-clips only; `generateRegion` clears the region's stale network from vault +
  shared map so the first tile recomputes fresh. Proof: `generatorRunCount` delta
  === 1 on a ~9-tile city regen; exactly ONE raw network record in generated.jsonl;
  output byte-identical.
- **[x] 031-B — batching parity** (`02f0e07`): flush / cascadeDownstream /
  cascadeFromRoot / applyPendingCascade now compute ONE fingerprint map + read ONE
  shared cache view and thread both through every region regen (like replay), and
  wrap the pass in a repaint batch (coalesced to 1 paint). buildRegionUpstream
  serves fresh upstream from the shared view (0 extra IO). Byte-identical by
  construction. Proof (FakeHost gateway/repaint counters): 1 fp pass + 1
  host.vault.readCached + 1 repaint per river→city flush; batched output ==
  from-scratch replay. (removeCached's per-region file rewrite — P6 — is plan 032.)
- **[x] 031-C — stage-ordered raw channel (P2/P3, CORRECTNESS)** (`5557ba6`): the
  raw-sketch reach walked affected regions in FABRIC FILE ORDER (roots in QUEUE
  ORDER), so a downstream stamped fresh over stale-upstream bytes survived reloads.
  Now `affected ∪ roots` merge into ONE `(stage,id)` walk (`forceRegenInStageOrder`);
  cascade still seeds from region-edit roots only (fan-out = plan 033). Only
  incorrectly-stale regions change bytes. Proof: adversarial city-before-river file
  order ⇒ river regenerates first (`forceRegenOrder`, fails on the pre-fix walk);
  fingerprint-fresh⇒bytes-fresh property; reversed-file-order determinism.
- **[x] 031-D — line-kind regions through the worker** (`<this commit>`): the worker
  job now carries `region.spine` (plain `Pt[]` + a localized zod schema); the worker
  rebuilds the corridor via `makeSpine`+`makeCorridorRegion` (shared pure
  `reconstructJobRegion`), so river/wall regen leaves the main thread. Main-thread
  fallback retained (no worker ⇒ `algorithm.generate`). Proof: JSON-round-tripped
  spine job produces byte-identical output vs the main-thread build, for river AND
  wall; polygon path + guard + malformed-spine zod throw covered.
- **STOP conditions honored**: no upstream threaded into a cache-HIT path; no
  consumption-aware invalidation / unified pass (032–034 untouched).

## Plan 030 — rearchitecture waves (2026-07-14, COMPLETE)
- **030-A DONE** (docs slice `9bb4328` + 4-agent sweep integrated, close `c3f77e6`):
  ~630 comment plan-citations → 0 across 126 src files (19 justified string
  survivors: snapshot-key test names + 1 runtime error string — deviation
  ruling in DECISIONS); docs/02 + the 3 procgen design docs deleted (folded
  into ARCHITECTURE.md + docs/procgen-design.md); ARCHITECTURE §12 = single
  invariants home w/ enforcement pointers; 030-C operators+data rule in
  CLAUDE.md; PROGRESS archived; DECISIONS indexed. Zero golden changes.
- **030-B DONE** (`c54bc2c` smoke gates + audit, `3416f93` shrink): 31 live
  gates → 5-gate smoke board (smokeBoot/phase1/smokeProcgen/version29/phase5);
  perceptual golden runner (scripts/perceptual.ts, zero deps, 8 pinned tuples,
  byte-deterministic); every deleted gate has a prove-by-breaking record
  (review/030B-break-proofs.md) — 3 real net holes found at the
  controller/paint seam, repaired + re-proven BEFORE deletion (strengthened
  vertex-edit test, river→city consumption test, styleGolden theme digests).
  Board 2198s → 308s GREEN 9/9.
- **030-C** standing convention active (CLAUDE.md + ARCHITECTURE §12.19).
- **030-D DONE** (worktree agent, integrated `a3f5067`): per-algorithm
  styleContract (14-role vocabulary) + roleColors per theme + ONE generic
  builder replaces the 8 map/themes/generated/* files (−972 lines);
  tileGeneratorIds derives from the contract + emitted-gid ⊆ contract test
  (silent-drop structurally dead); playground renders the contract; proof:
  styleGolden BYTE-IDENTICAL (no -u), perceptual 8/8 at 0.000%, ZERO per-theme
  overrides needed; smokeProcgen hardened with a rendered-pixels assertion
  after finding the raw-setStyle blank-screenshot artifact.
- **030-E DONE** (`a3dcbc9`): full doc read-through against as-built code —
  ARCHITECTURE §5 versioned determinism / §8 style contract / §9 tiers+smoke
  board / §10 portable renderer contract / §12 contract-enforced invariants;
  CLAUDE.md + docs/05/06/08 + README reconciled; playground/README.md added;
  HEARTBEAT retired to review/. PLAN 030 COMPLETE.

## Plan 029 — versioned determinism (2026-07-14, COMPLETE)
- **29-A DONE** (`612cfd2`): `ProcgenAlgorithm.currentVersion` (all 7 at 1) +
  optional `migrateParams` + `migrateParamsForAdoption` + `allAlgorithms()`;
  creation writes `currentVersion`; version-pin unit family (creation pins,
  edits keep the pin, lenient unknown-key params round-trip); fingerprint
  version-flip test verified pre-existing.
- **29-B DONE** (`b3e74f6`): adoption lifecycle — `ConfirmSink` host gateway;
  consent prompt on every direct edit of a pinned-old region (decline cancels
  the edit); `generateRegion` = the single cache-only funnel for indirect
  demands (pinned-old + no cache ⇒ renders NOTHING + needs-adoption badge,
  generator NEVER runs under an old pin); panel Adopt button, adopt-all
  command, test twins + `overrideCurrentVersionForTest`; `version29` gate
  13/13 standalone; Vespergate byte-intact. Policy docs in `e77e798`
  (CLAUDE.md versioned-determinism bullet + .mapcache carve-out; docs/05
  tuning loop).
- **29-C DONE** (`0a9c50b`, Opus worktree agent): shared
  `testkit/invariants.ts` (containment/closed-rings/mm-lattice/determinism)
  wired into all 7 suites; 6 pure metrics modules + golden-anchored bands
  (river sinuosity/width, forest cover/holes/trees, park path/water/points,
  wall spacing/count/gates, farmland fields/lanes, mountain
  peaks/contours/hachures); goldens shrink river 2→1 + city 4→1 (coverage
  converted structural, euro-medieval golden byte-identical);
  `npm run goldens:accept -- <algorithm>` explicit-only re-golden script.
- **§9 exit test DONE with a REAL change** (`67c9041`): `blobFeature` D5
  quantization bug (found by the 29-C agent, ruled bump-not-bugfix) fixed
  behind park v1→2 + `goldens:accept` + mm opt-outs removed — the full
  bump/re-golden/bands/adoption loop in one sitting, zero byte-neutrality
  analysis. The policy paid for itself on day one.
- **Plan board (T3)**: 31/35 raw = 35/35 effective — procgen41 (16/16) +
  procgen43 (7/7) standalone-green right after (environment flakes per the
  2026-07-13 rule); phase0 "dirtied dev-vault" + presetGallery = Jonah's own
  live edits (new `testing/` campaign + Preset Gallery), ruled green by Jonah
  same day. `version29` passed in-board.

Older arcs (plans 001–028, phases 0–5): `review/progress-archive.md`.
