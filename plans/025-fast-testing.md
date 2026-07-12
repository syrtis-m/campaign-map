# Plan 025 — Make testing fast (the board must stop costing an afternoon)

**Status:** design done 2026-07-12, approved direction from Jonah ("make testing
take less time? testing right now takes forever, with all these gates etc").
Scheduled AFTER plans 021–024 land (it hardens the workflow they'll all use;
pieces marked ⚡ are safe to pull forward any time). The §0 cold-start context
of `plans/021-procgen-suite-rivers-forests-parks-walls.md` applies verbatim —
read it first, especially the infra pitfalls (several exist only because
testing is slow; this plan attacks their root causes).

## 1. Where the time actually goes (measured, 2026-07-12 build days)

| Cost | Today | Why |
|---|---|---|
| Unit suite (`npx vitest run`) | ~125 s | two fuzz tests dominate: 200-region 4-profile fuzz ~79 s, 120-run polygon fuzz ~21 s — >80% of wall clock in <2% of the tests |
| One live gate | ~2–5 min | full Obsidian process boot + vault load + plugin load + eval-poll loops + screenshots |
| Full board | ~45–90 min | ~12 gates × fresh process each (prophylactic restart because of the renderer-degradation bug) + unit + tsc + build + test:app, all serial |
| Failure modes | hours | a board that long collides with session limits (killed two agents today), renderer degradation mid-board forces re-runs, and agents re-run whole boards to validate one-file changes |

The fresh-process-per-gate rule is a WORKAROUND, not a law of nature: long
sessions degrade the MapLibre renderer (`isStyleLoaded()` → false everywhere;
README lists it as under investigation). Everything else serializes behind
that workaround.

## 2. The fixes, ranked by wall-clock-per-effort

### 2.1 ⚡ Split the fuzz tier out of the unit suite (hours of agent time, ~1 h of work)
`npm test` = fast suite (target **<30 s**): everything except tests tagged
slow. `npm run test:fuzz` = the fuzz/stress tier (unit-gate fuzzes, 200-region
stress), run at phase gates and pre-merge only, not on every inner-loop edit.
Vitest supports this directly (test tags / separate config include). Protocol
change in docs/05: the agent inner loop runs the FAST suite; fuzz runs when a
generator's behavior actually changed.

### 2.2 Fix the renderer degradation at the root (the single biggest unlock)
A first-class INVESTIGATION phase, not a workaround: reproduce degradation
deterministically (N reload/generate cycles in one process, probe
`isStyleLoaded` + frame time each cycle), then bisect the leak — prime
suspects: MapLibre `Map` instances not `remove()`d on `plugin:reload`
(view teardown), GL contexts accumulating, style-image/glyph caches surviving
reload, event listeners on `window` (we register several). Exit test: 50
consecutive reload+generate+screenshot cycles in ONE process with
`isStyleLoaded` true and stable frame time throughout. **If fixed, the
fresh-process-per-gate rule is retired** (update docs/05 §pitfalls + CLAUDE.md)
and the board runs in one process. If truly unfixable at our layer (Obsidian/
Electron bug), document the evidence and keep 2.3's mitigation.

### 2.3 One board runner with health-probed restarts (works either way)
`scripts/board.ts`: runs the whole board in ONE Obsidian process, executing a
cheap health probe between gates (`isStyleLoaded` + a 1-tile render check);
restarts Obsidian ONLY when the probe fails, resuming where it left off, and
records per-gate wall-clock + restart count to a board report. Even with the
bug unfixed, empirically the renderer survives several gates — probe-driven
restarts cut process boots from ~12 to ~2–4. Also: one `npm run board`
command instead of a dozen hand-run scripts; the report is the thing agents
paste into PROGRESS.md.

### 2.4 Headless host harness — test the lifecycle without the renderer
Most gate assertions never needed pixels: manifest state, cache byte-diffs,
log entries, feature counts, containment, fingerprints. They need the PLUGIN
LOGIC, not MapLibre. Two steps:
1. **Extract the lifecycle controller from MapView** (it is ~2500 lines and
   Obsidian-bound): generation/regen/clear/undo/replay/cascade orchestration
   moves to a host-agnostic `MapController` that takes narrow interfaces
   (vault adapter, notice sink, render sink). MapView becomes wiring + paint.
   This is a refactor with regression risk — do it right after a green board,
   land it with zero behavior change, prove it with the existing gates.
2. **`FakeHost` test double** (in-memory vault adapter over a temp dir, no-op
   render sink): the controller's whole surface — sketch-commit → generate →
   cache/manifest/log state, replay, migration, undo — becomes fast Vitest
   integration tests (**seconds, parallel, no Obsidian**). Live gates shrink
   to what genuinely needs eyes/GPU: paint, layer order, screenshots,
   interaction wiring. Target: ≥70% of current live-gate assertions move
   headless.

### 2.5 ⚡ Change-scoped gating (stop re-proving the world)
A small manifest maps each gate to the source globs it covers
(`scripts/gates/coverage.json`). `npm run board -- --changed` runs unit fast
tier + only the gates whose globs intersect `git diff --name-only` against the
last green-board commit. Full board remains the bar for phase commits and
anything touching determinism-critical shared code (`region.ts`, `rng.ts`,
`clip.ts`, `tileCache.ts` → always full board). The tag in the commit message
records which tier ran: `[gate: changed-scope 4/4]` vs `[gate: full board]`.

### 2.6 Tier protocol (docs/05 + docs/06 update, lands with the above)
- **T0** inner loop: fast unit suite (<30 s) + tsc, on every edit.
- **T1** phase checkpoint: T0 + fuzz tier + the phase's own gate(s).
- **T2** pre-commit: T1 + change-scoped gates (2.5).
- **T3** pre-merge/release + determinism-critical changes: full board via
  `npm run board`, one report artifact.
Screenshots stay mandatory where visual judgment matters (docs/04 screenshot
test is untouched — this plan makes room for it by removing everything else
from its critical path).

## 3. Sequencing
1. ⚡ 2.1 fuzz split + 2.5 change-scoped gating + 2.6 tier docs (one small
   phase, immediate relief, no risk).
2. 2.2 renderer investigation (timeboxed: if no root cause in a bounded
   effort, ship the evidence + keep the workaround) and 2.3 board runner
   (build it during the investigation — it's also the investigation's
   instrument: the probe + per-gate timings ARE the repro harness).
3. 2.4 controller extraction + FakeHost (the big one — own phase, zero-
   behavior-change bar, full board green before and after).

## 4. Acceptance (numbers, not vibes)
- Inner loop (edit → fast unit + tsc): **<45 s**.
- Phase checkpoint (T1): **<5 min**.
- Full board (T3): **<15 min** wall clock (from ~45–90 min), ≤4 process boots,
  one command, one report.
- A deliberately-injected determinism break (flip one hash salt) is still
  caught: by the fast tier OR the change-scoped gates — prove it in the gate
  for this plan itself.
- No reduction in what is asserted: every assertion deleted from a live gate
  must reappear in a headless test (map the migration in the phase report).

## 5. Open questions
1. Parallel headless gates across cloned temp vaults (post-2.4 the FakeHost
   tests parallelize under Vitest anyway — probably moot; revisit only if T3
   is still >15 min).
2. Golden-screenshot pixel-diffing to automate part of the visual review
   (risk: theme/font drift makes it flaky — Jonah's call whether the
   maintenance tax is worth it; the plan-024 gallery contact sheet may be the
   better artifact).
3. CI (GitHub Actions) for T0/T1 on push — needs the FakeHost work first;
   live gates stay local (Obsidian licensing/GUI).
