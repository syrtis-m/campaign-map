# Progress

*Updated after every gate run. A fresh session should be able to resume from CLAUDE.md + this file alone.*

## Status: plans 029 + 030 COMPLETE (2026-07-14) — the versioned-determinism + rearchitecture arc is done. Pipeline arc (031–038) STARTED: plan 031 COMPLETE (2026-07-15). Plans 020–028 complete.

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
