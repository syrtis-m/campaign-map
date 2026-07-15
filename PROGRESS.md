# Progress

*Updated after every gate run. A fresh session should be able to resume from CLAUDE.md + this file alone.*

## Status: plans 029 + 030 COMPLETE (2026-07-14) — the versioned-determinism + rearchitecture arc is done. Next: the pipeline arc (plans 031–038, ratified same day) or plan 039. Plans 020–028 complete.

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
