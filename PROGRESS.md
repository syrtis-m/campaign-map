# Progress

*Slim current state for resuming multi-session work — a fresh session resumes from
CLAUDE.md + this file + `git log` alone. Keep this short: when an arc closes, move
its journal to `review/` and leave one line here. Full history:
`review/progress-archive.md` (plans 001–039 era) and `review/overnight-run-031-039.md`
(the pipeline-arc journal).*

## Status (2026-07-16)

- **All planned arcs complete.** Plans 001–041 shipped (041 A+B landed; see
  `plans/README.md`, the ledger of record). Algorithm versions: city 5, river 3,
  forest 4, park 5, wall 4, farmland 10, mountain 2, relief 1, landform 1.
- **2026-07-16 perf/UX arc** (details: ARCHITECTURE §13.11): relief vertex edit
  22.1 s → 0.40 s; live contour preview during terrain drags; resident-mesh 3D
  (on/flat/off); river-carve digest scoping; label clicks open notes; city v5
  geometric water mask; farmland v10 true-contour paddy terraces; param tooltips
  everywhere; documentation overhauled (this commit).
- Suite: 1,577 fast tests green; build clean.

## Open items

The unscheduled-work register lives in `plans/README.md` §Open items. Nothing is
currently in flight.
