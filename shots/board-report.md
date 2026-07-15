# Board report — 2026-07-15T00:23:07.815Z

- **Mode:** full board
- **Result:** 31/35 steps passed
- **Total wall-clock:** 2198.3s
- **Probe-driven relaunches:** 1
- **Obsidian process boots (by board):** 1 (initial process pre-existing)

| step | kind | result | wall | relaunches | post-probe | notes |
|---|---|---|---|---|---|---|
| unit | prologue | PASS | 48.6s | 0 | — |  |
| fuzz | prologue | PASS | 212.5s | 0 | — |  |
| tsc | prologue | PASS | 4.4s | 0 | — |  |
| build | prologue | PASS | 3.8s | 0 | — |  |
| phase0 | gate | **FAIL** | 5.6s | 0 | healthy | RED (fixture hygiene): dirtied dev-vault — 2 path(s) |
| phase1 | gate | PASS | 11.3s | 0 | healthy |  |
| phase2 | gate | PASS | 15.0s | 0 | healthy |  |
| phase3 | gate | PASS | 18.2s | 0 | healthy |  |
| phase4 | gate | PASS | 37.8s | 0 | healthy |  |
| phase5 | gate | PASS | 5.9s | 0 | healthy |  |
| procgen40 | gate | PASS | 60.5s | 0 | healthy |  |
| procgen41 | gate | **FAIL** | 154.6s | 0 | healthy | gate exited 1 |
| procgen42 | gate | PASS | 10.9s | 0 | healthy |  |
| procgen43 | gate | **FAIL** | 13.2s | 0 | healthy | gate exited 1 |
| procgen44 | gate | PASS | 95.5s | 0 | healthy |  |
| procgen45 | gate | PASS | 44.5s | 0 | healthy |  |
| procgen46 | gate | PASS | 74.5s | 0 | healthy |  |
| procgen47 | gate | PASS | 69.8s | 0 | healthy |  |
| procgen48 | gate | PASS | 72.8s | 0 | healthy |  |
| styleLoad | gate | PASS | 4.5s | 0 | healthy |  |
| procgen49-forest | gate | PASS | 51.1s | 0 | healthy |  |
| procgen50-canopy | gate | PASS | 65.6s | 0 | healthy |  |
| procgen51-glyphs | gate | PASS | 40.0s | 0 | healthy |  |
| vo27-park | gate | PASS | 95.6s | 0 | healthy |  |
| procgen49 | gate | PASS | 144.0s | 1 | healthy |  |
| fields23a | gate | PASS | 59.6s | 0 | healthy |  |
| elevation23b | gate | PASS | 48.5s | 0 | healthy |  |
| contours23c | gate | PASS | 23.5s | 0 | healthy |  |
| hillshade23d | gate | PASS | 39.1s | 0 | healthy |  |
| coupling23e | gate | PASS | 37.5s | 0 | healthy |  |
| staleness24a | gate | PASS | 34.7s | 0 | healthy |  |
| cascade24b | gate | PASS | 38.8s | 0 | healthy |  |
| cascade24c | gate | PASS | 46.9s | 0 | healthy |  |
| presetGallery | gate | **FAIL** | 272.3s | 0 | healthy | gate exited 1 |
| version29 | gate | PASS | 30.0s | 0 | healthy |  |

## Failures
- **phase0**: RED (fixture hygiene): dirtied dev-vault — 2 path(s)
- **procgen41**: gate exited 1
- **procgen43**: gate exited 1
- **presetGallery**: gate exited 1
