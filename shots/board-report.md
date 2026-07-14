# Board report — 2026-07-14T17:03:03.385Z

- **Mode:** full board
- **Result:** 26/30 steps passed
- **Total wall-clock:** 1142.4s
- **Probe-driven relaunches:** 0
- **Obsidian process boots (by board):** 0 (initial process pre-existing)

| step | kind | result | wall | relaunches | post-probe | notes |
|---|---|---|---|---|---|---|
| unit | prologue | PASS | 22.5s | 0 | — |  |
| fuzz | prologue | PASS | 100.9s | 0 | — |  |
| tsc | prologue | PASS | 3.2s | 0 | — |  |
| build | prologue | PASS | 2.9s | 0 | — |  |
| phase0 | gate | PASS | 4.9s | 0 | healthy |  |
| phase1 | gate | PASS | 10.7s | 0 | healthy |  |
| phase2 | gate | PASS | 14.8s | 0 | healthy |  |
| phase3 | gate | PASS | 17.9s | 0 | healthy |  |
| phase4 | gate | PASS | 37.4s | 0 | healthy |  |
| phase5 | gate | PASS | 4.0s | 0 | healthy |  |
| procgen40 | gate | PASS | 34.4s | 0 | healthy |  |
| procgen41 | gate | **FAIL** | 119.4s | 0 | healthy | gate exited 1 |
| procgen42 | gate | PASS | 9.1s | 0 | healthy |  |
| procgen43 | gate | PASS | 11.8s | 0 | healthy |  |
| procgen44 | gate | PASS | 34.4s | 0 | healthy |  |
| procgen45 | gate | **FAIL** | 34.9s | 0 | healthy | gate exited 1 |
| procgen46 | gate | PASS | 41.3s | 0 | healthy |  |
| procgen47 | gate | PASS | 51.1s | 0 | healthy |  |
| procgen48 | gate | **FAIL** | 80.3s | 0 | healthy | gate exited 1 |
| styleLoad | gate | PASS | 3.4s | 0 | healthy |  |
| procgen49-forest | gate | PASS | 41.5s | 0 | healthy |  |
| procgen50-canopy | gate | PASS | 46.9s | 0 | healthy |  |
| procgen51-glyphs | gate | PASS | 38.3s | 0 | healthy |  |
| vo27-park | gate | PASS | 80.4s | 0 | healthy |  |
| procgen49 | gate | PASS | 55.0s | 0 | healthy |  |
| fields23a | gate | PASS | 34.6s | 0 | healthy |  |
| elevation23b | gate | PASS | 37.5s | 0 | healthy |  |
| contours23c | gate | PASS | 22.7s | 0 | healthy |  |
| hillshade23d | gate | **FAIL** | 69.7s | 0 | healthy | gate exited 1 |
| coupling23e | gate | PASS | 32.3s | 0 | healthy |  |

## Failures
- **procgen41**: gate exited 1
- **procgen45**: gate exited 1
- **procgen48**: gate exited 1
- **hillshade23d**: gate exited 1
