# Board report — 2026-07-14T19:22:41.031Z

- **Mode:** full board
- **Result:** 30/33 steps passed
- **Total wall-clock:** 1423.2s
- **Probe-driven relaunches:** 0
- **Obsidian process boots (by board):** 0 (initial process pre-existing)

| step | kind | result | wall | relaunches | post-probe | notes |
|---|---|---|---|---|---|---|
| unit | prologue | PASS | 26.0s | 0 | — |  |
| fuzz | prologue | PASS | 100.8s | 0 | — |  |
| tsc | prologue | PASS | 3.3s | 0 | — |  |
| build | prologue | PASS | 3.0s | 0 | — |  |
| phase0 | gate | PASS | 4.9s | 0 | healthy |  |
| phase1 | gate | PASS | 10.7s | 0 | healthy |  |
| phase2 | gate | PASS | 14.7s | 0 | healthy |  |
| phase3 | gate | **FAIL** | 47.8s | 0 | healthy | gate exited 1 |
| phase4 | gate | PASS | 37.5s | 0 | healthy |  |
| phase5 | gate | PASS | 4.7s | 0 | healthy |  |
| procgen40 | gate | PASS | 36.7s | 0 | healthy |  |
| procgen41 | gate | PASS | 94.0s | 0 | healthy |  |
| procgen42 | gate | PASS | 10.0s | 0 | healthy |  |
| procgen43 | gate | PASS | 12.3s | 0 | healthy |  |
| procgen44 | gate | PASS | 82.7s | 0 | healthy |  |
| procgen45 | gate | PASS | 36.9s | 0 | healthy |  |
| procgen46 | gate | PASS | 68.6s | 0 | healthy |  |
| procgen47 | gate | PASS | 52.7s | 0 | healthy |  |
| procgen48 | gate | **FAIL** | 49.9s | 0 | healthy | gate exited 1 |
| styleLoad | gate | PASS | 2.3s | 0 | healthy |  |
| procgen49-forest | gate | PASS | 44.3s | 0 | healthy |  |
| procgen50-canopy | gate | PASS | 47.6s | 0 | healthy |  |
| procgen51-glyphs | gate | PASS | 38.5s | 0 | healthy |  |
| vo27-park | gate | PASS | 89.0s | 0 | healthy |  |
| procgen49 | gate | **FAIL** | 154.6s | 0 | healthy | gate exited 1 |
| fields23a | gate | PASS | 37.3s | 0 | healthy |  |
| elevation23b | gate | PASS | 41.9s | 0 | healthy |  |
| contours23c | gate | PASS | 30.5s | 0 | healthy |  |
| hillshade23d | gate | PASS | 40.4s | 0 | healthy |  |
| coupling23e | gate | PASS | 37.0s | 0 | healthy |  |
| staleness24a | gate | PASS | 33.9s | 0 | healthy |  |
| cascade24b | gate | PASS | 33.4s | 0 | healthy |  |
| cascade24c | gate | PASS | 45.8s | 0 | healthy |  |

## Failures
- **phase3**: gate exited 1
- **procgen48**: gate exited 1
- **procgen49**: gate exited 1
