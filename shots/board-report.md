# Board report — 2026-07-14T12:42:59.386Z

- **Mode:** full board
- **Result:** 25/27 steps passed
- **Total wall-clock:** 863.2s
- **Probe-driven relaunches:** 0
- **Obsidian process boots (by board):** 0 (initial process pre-existing)

| step | kind | result | wall | relaunches | post-probe | notes |
|---|---|---|---|---|---|---|
| unit | prologue | PASS | 20.9s | 0 | — |  |
| fuzz | prologue | PASS | 90.1s | 0 | — |  |
| tsc | prologue | PASS | 3.1s | 0 | — |  |
| build | prologue | PASS | 2.8s | 0 | — |  |
| phase0 | gate | PASS | 5.2s | 0 | healthy |  |
| phase1 | gate | PASS | 11.0s | 0 | healthy |  |
| phase2 | gate | PASS | 14.9s | 0 | healthy |  |
| phase3 | gate | PASS | 18.1s | 0 | healthy |  |
| phase4 | gate | PASS | 37.6s | 0 | healthy |  |
| phase5 | gate | PASS | 5.0s | 0 | healthy |  |
| procgen40 | gate | PASS | 34.7s | 0 | healthy |  |
| procgen41 | gate | PASS | 89.2s | 0 | healthy |  |
| procgen42 | gate | PASS | 9.8s | 0 | healthy |  |
| procgen43 | gate | PASS | 12.2s | 0 | healthy |  |
| procgen44 | gate | PASS | 34.2s | 0 | healthy |  |
| procgen45 | gate | PASS | 34.4s | 0 | healthy |  |
| procgen46 | gate | **FAIL** | 28.8s | 0 | healthy | gate exited 1 |
| procgen47 | gate | PASS | 51.2s | 0 | healthy |  |
| procgen48 | gate | **FAIL** | 48.7s | 0 | healthy | gate exited 1 |
| styleLoad | gate | PASS | 4.5s | 0 | healthy |  |
| procgen49-forest | gate | PASS | 41.4s | 0 | healthy |  |
| vo27-park | gate | PASS | 48.6s | 0 | healthy |  |
| procgen49 | gate | PASS | 43.2s | 0 | healthy |  |
| fields23a | gate | PASS | 34.5s | 0 | healthy |  |
| elevation23b | gate | PASS | 37.4s | 0 | healthy |  |
| contours23c | gate | PASS | 22.7s | 0 | healthy |  |
| hillshade23d | gate | PASS | 39.8s | 0 | healthy |  |

## Failures
- **procgen46**: gate exited 1
- **procgen48**: gate exited 1
