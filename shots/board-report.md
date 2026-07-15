# Board report — 2026-07-15T03:24:26.132Z

- **Mode:** full board
- **Result:** 9/9 steps passed
- **Total wall-clock:** 363.8s
- **Probe-driven relaunches:** 1
- **Obsidian process boots (by board):** 1 (initial process pre-existing)

| step | kind | result | wall | relaunches | post-probe | notes |
|---|---|---|---|---|---|---|
| unit | prologue | PASS | 44.3s | 0 | — |  |
| fuzz | prologue | PASS | 187.6s | 0 | — |  |
| tsc | prologue | PASS | 10.7s | 0 | — |  |
| build | prologue | PASS | 5.4s | 0 | — |  |
| smokeBoot | gate | PASS | 6.4s | 0 | healthy |  |
| phase1 | gate | PASS | 11.1s | 0 | healthy |  |
| smokeProcgen | gate | PASS | 17.6s | 1 | healthy |  |
| version29 | gate | PASS | 30.3s | 0 | healthy |  |
| phase5 | gate | PASS | 5.1s | 0 | healthy |  |
