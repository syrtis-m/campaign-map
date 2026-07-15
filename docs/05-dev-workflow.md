# Dev Workflow: Building & Testing with the Obsidian CLI

*The [official Obsidian CLI](https://help.obsidian.md/cli) (Obsidian 1.12.7+ installer, enable in Settings → General → Command line interface) lets coding agents build, reload, drive, and verify the plugin without a human clicking. The app must be running; commands hit the live instance. There is also a ready-made [obsidian-cli agent skill](https://github.com/kepano/obsidian-skills/blob/main/skills/obsidian-cli/SKILL.md) — install it alongside the MapLibre skills.*

## Setup (once per machine)

1. Obsidian installer ≥ 1.12.7; enable CLI in Settings → General (macOS symlinks `/usr/local/bin/obsidian`; Windows adds `Obsidian.com` redirector to PATH — covers both the Mac Neo and the Surface Pro).
2. Dev vault at `dev-vault/` in this repo (a real vault with a test campaign per genre: fictional-fantasy, real-city, neon-sprawl city).
3. `npm run dev` — esbuild watch, output symlinked/copied into `dev-vault/.obsidian/plugins/campaign-map/`.

## Playground — the procgen inner loop (start here for generator work)

`npm run playground` → http://localhost:8734 — a standalone browser harness
(`playground/`, esbuild serve, zero new deps) that imports `src/gen` **directly**: no
build-to-vault, no plugin reload, no Obsidian. Iteration on a generator goes from
minutes to milliseconds, so it is the FIRST stop for any procgen work:

- **Tuning**: every algorithm's zod params render as live knobs (sliders/dropdowns
  auto-derived from the schema — a new param appears with zero playground changes);
  regenerate-on-release with per-run timing and feature count.
- **Seed sweeps**: scrub seeds (◀ ▶ / random) to judge variety and robustness before
  writing a fuzz assertion.
- **Preset review**: one click renders every preset side-by-side at the current seed —
  the fastest way to check a new preset reads distinctly (docs/04 genre test).
- **Region robustness**: circle / square / blob / concave-L region shapes and spine
  shapes for line-kind algorithms — eyeball containment and concave behavior live.

What the playground is NOT: its canvas paint is a per-gid **shim** (plan 030-D replaces
it with the theme style contract), so it judges *geometry and composition*, not theme
paint — final visual sign-off for anything paint-related still needs the in-app
screenshot below. It also exercises no host code (cache, worker, lifecycle, undo),
so it never substitutes for a live gate. Generator work order: **playground (tune +
judge) → unit/fuzz tests (T0/T1) → Obsidian loop only for the host-integration slice.**

### Shipping a retune — the standard tuning loop (plan 029, versioned determinism)

A generator change that alters output bytes for the same `(seed, params)` needs **no
byte-neutrality analysis** — it ships behind a version bump:

1. **Tune** in the playground until the output reads right.
2. **Bump** the algorithm's `currentVersion` in `src/gen/procgen/registry.ts` (add a
   `migrateParams` entry only if param semantics changed with it).
3. **Re-golden**: `npm run goldens:accept -- <algorithm>` regenerates the one
   byte-golden fixture (explicit-only — never CI-auto); review the diffstat.
4. **Bands stay green**: the structural invariants + metric-band tests are the net
   that survives tuning — if a band breaks, the retune changed more than intended.
5. **Adoption is the GM's**: existing regions keep rendering their pinned cached
   bytes; editing one prompts, the panel offers Adopt, and "Update all regions to
   current generators" adopts campaign-wide. Never fork old generator code to
   reproduce old bytes — cache + consent carry them.

Prefer a param over a bump when an absent param naturally reproduces old behavior;
bumps are for retunes and algorithmic changes where byte-neutral defaults would
distort the design.

## The core loop — Obsidian (host/theme/integration work; the live-gate cycle)

```bash
npm run build                                   # or rely on the dev watcher
obsidian plugin:reload id=campaign-map          # hot-reload the plugin
obsidian dev:errors clear                       # reset error buffer
obsidian command id=campaign-map:open-map       # open the map view
obsidian dev:errors                             # MUST be empty
obsidian dev:screenshot path=shots/latest.png   # then LOOK at it (Read the png)
```

A change is not done until: `dev:errors` is clean, and the screenshot has been *viewed* and passes the [quality bar](04-quality-bar.md) screenshot test. `dev:screenshot` is how the screenshot test stops being aspirational and becomes a check you actually run.

## Driving the app for tests

```bash
# Run JS in the app context — inspect plugin state, drive the map
obsidian eval code="app.plugins.plugins['campaign-map'].map.getZoom()"
obsidian eval code="app.plugins.plugins['campaign-map'].map.flyTo({center:[12.1,-3.8],zoom:14})"

# Simulate the yes-and flow end-to-end: create a location note, verify pin appears
obsidian create path="Campaigns/Test/Locations/Smoke Tavern.md" content="---\nmap: test\ngeometry: [12.1, -3.8]\ntype: tavern\n---" overwrite
obsidian eval code="app.plugins.plugins['campaign-map'].index.has('Smoke Tavern')"

# Reconciliation checks: rename/delete must reflect on the map instantly
obsidian rename path="Campaigns/Test/Locations/Smoke Tavern.md" name="Brine Tavern"
obsidian delete path="Campaigns/Test/Locations/Brine Tavern.md" permanent

# Frontmatter without hand-parsing YAML
obsidian property:read name=geometry file="Brine Tavern"
obsidian property:set name=type value=shrine file="Brine Tavern"

# Console + DOM when debugging rendering
obsidian dev:console level=error
obsidian dev:dom selector=".campaign-map-view canvas" total
obsidian dev:css selector=".campaign-map-place-card" prop=font-family
```

Expose a small `window`-reachable test API from the plugin (`app.plugins.plugins['campaign-map']`) — `map`, `index`, `themes`, `log` — deliberately, as the eval-testing surface. Keep it stable; CLI tests depend on it.

## Theme & platform checks

```bash
# obsidian-native theme must rebuild on css-change:
obsidian theme:set name="Minimal" && obsidian dev:screenshot path=shots/theme-minimal.png
obsidian theme:set name=""        && obsidian dev:screenshot path=shots/theme-default.png
# Diff-view both screenshots — map colors must have followed the theme.

# Mobile emulation smoke test (Vault-API-only discipline check)
obsidian dev:mobile on && obsidian dev:errors && obsidian dev:mobile off
```

## Layered test strategy

| Layer | Tool | What |
|---|---|---|
| Generator visuals + tuning | **Playground** (`npm run playground`), no Obsidian | Live param knobs, seed sweeps, preset grid, region-shape robustness — the judgment surface BEFORE assertions are written; geometry/composition only (paint shim, not theme truth) |
| Generators (pure) | **Vitest**, no Obsidian | Shared structural invariants (`gen/testkit/invariants.ts`: containment, closed rings, mm lattice, determinism), metric bands (`*Metrics.ts`), ONE byte-golden per algorithm (re-accepted on a version bump via `npm run goldens:accept -- <algorithm>`), 2×2 seam tests |
| Perceptual (headless) | **`npm run perceptual`**, no Obsidian | Pinned (algorithm, preset, seed, region) tuples rendered by a pure-TS rasterizer → PNGs pixel-diffed against approved goldens in `shots/perceptual/` (>0.5% differing pixels fails). Re-approve with `npm run perceptual -- --accept` alongside a version bump, and EYEBALL the new goldens at acceptance — never auto-accept |
| Model/validators | Vitest | Zod schemas, frontmatter parse round-trips |
| Live smoke | **The 5-gate smoke set** (`scripts/gates/`) | What headless tiers cannot prove: smokeBoot (plugin boots, every style-builder path loads live), phase1 (reconcile round-trip), smokeProcgen (sketch→generate→paint→replay, explicit-only, glyph lifecycle), version29 (migration/adoption), phase5 (exports write files) |
| Visual judgment | CLI screenshots | The docs/04 screenshot test — a release judgment, not a per-commit gate; playground + perceptual carry the per-commit visual net |

Unit tests need no Obsidian and stay fast — that's why generators are host-agnostic. Integration tests are a bash/TS script of CLI calls with exit-code assertions; run before any commit touching `src/map/`, reconciliation, or themes.

## Test tiers (T0–T3) — how much to run, when (plan 021)

Testing used to mean "run the whole board," which cost an afternoon. It no longer does. Pick the smallest tier that covers what you changed and escalate only as you approach a commit/merge. Each tier is a strict superset of the one below.

| Tier | When | What runs | Command(s) | Budget |
|---|---|---|---|---|
| **T0** inner loop | every edit | fast unit suite + tsc | `npm test` (+ `npx tsc --noEmit`) | **<45 s** |
| **T1** phase checkpoint = **per-phase COMMIT bar** | finishing (and committing) a phase's work | T0 + build + **perceptual goldens** + that phase's own gate(s) standalone (+ fuzz tier iff generator behavior changed) | `npm test && npm run build && npm run perceptual` + `tsx scripts/gates/<gate>.ts` (+ `npm run test:fuzz`) | <5 min |
| **T2** targeted re-check (optional, diagnostic) | debugging a suspected cross-gate regression | change-scoped gates | `npm run gates:changed` (add `--run` to execute them) | scoped |
| **T3** plan-end / release | **ONCE per plan, at its final phase** — and releases | **the smoke board** (unit + fuzz + tsc + build + the 5 smoke gates) | `npm run board` | **<5 min** |

**Board cadence (Jonah 2026-07-13 — binding):** the full board runs **once per plan**, at the plan's final ⛳ phase — never per commit, never per phase. Per-phase commits gate on T1: fast suite + tsc + build + that phase's OWN live gate run standalone. Unchanged gates inherit the previous board's green; cross-gate regressions are caught at the plan-end board. Multiple ~6-min board runs per phase was measured to turn hours of dev into days — that is the failure mode this rule exists to prevent.

- **`npm test` is the FAST tier** (target <30 s): everything except the slow fuzz/stress tests, which live in `*.fuzz.test.ts` and run via **`npm run test:fuzz`** at T1+. Run the fuzz tier whenever a **generator's behavior actually changed**; skip it for docs/UI-only edits. Together `npm test` + `npm run test:fuzz` cover the identical set of tests — every test is in exactly one tier.
- **Change-scoped gates (T2):** `npm run gates:changed` intersects `git diff --name-only` (vs the last green board, stored in `.lastgreenboard`; override with `--ref=<sha>`) against `scripts/gates/coverage.json` and runs only the gates whose globs match. It **escalates to the full board automatically** when a determinism-critical path changes (`src/gen/region.ts`, `src/gen/rng.ts`, any `clip.ts`, `src/model/tileCache.ts`) — which is why it is no longer a per-commit requirement: during generator-heavy plans it escalates almost every time, re-proving the world per commit. Determinism safety is instead carried by the fast tier's byte-identity/golden tests per generator and the plan-end board.
- **Board-flake rule:** a live gate that FAILS inside a board but passes standalone immediately after is an **environment flake** (long-lived-renderer degradation, plan 021-B — known, mitigated, not fully fixed). Log it (gate name + both results) in PROGRESS.md, count the gate green, and do **not** re-run the whole board to chase a clean sweep — disjoint flakes across re-runs burn ~6 min each and prove nothing new.
- **Screenshot judgment stays mandatory where visual** (docs/04's screenshot test is untouched — the tiers make room for it by removing everything else from the critical path). Never mark visual work done without reading the png. For GENERATOR visuals, do the iterating in the playground (instant re-render beats a build+reload+screenshot cycle per data point) and reserve the in-app screenshot for the final theme-paint judgment — the playground's shim paint can't stand in for themes.
- **Commit-message tag records the tier that ran:** `[gate: T1 …]` for a phase commit, `[gate: full board N/M]` for the plan-end T3. A commit that only ran T0 says so.

## The board runner (`npm run board`)

The board is the **5-gate smoke set** (smokeBoot · phase1 · smokeProcgen · version29 · phase5) behind the unit/fuzz/tsc/build prologue — everything else that used to be a live gate now lives headless (generator suites + invariants + bands + perceptual goldens; each retired gate carries a prove-by-breaking record in `review/030B-break-proofs.md`). One command, one Obsidian process, restarting only when a health probe says the renderer degraded.

```bash
npm run board                          # full board: prologue (unit+fuzz+tsc+build) + every live gate
npm run board -- --changed             # change-scoped: unit+tsc+build + selectGates() live gates (respects full-board escalation)
npm run board -- --gates=phase1,styleLoad   # explicit live-gate subset (demo/debug)
npm run board -- --no-prologue         # live gates only (you already ran unit/build)
npm run board -- --probe-fail-at=N     # inject ONE probe failure at the Nth gate to exercise the relaunch/resume path
```

- **Prologue first** (process-independent): `npm test` → `npm run test:fuzz` → `tsc --noEmit` → `npm run build`. A broken build aborts the board before any live gate (a bad bundle makes every gate meaningless). `--changed` drops the fuzz tier (a scoped run isn't a generator-behavior checkpoint) but keeps build. `test:app` is intentionally **not** in the board — it's a single-gate wrapper the board subsumes by running gates from `coverage.json` directly.
- **Health-probe attribution is the whole point.** Renderer degradation produces not just spurious FAILs but *vacuous PASSes* (a collision check passes when nothing is drawn), so the discriminator is the probe **after** each gate: pre-gate probe unhealthy → relaunch first; post-gate probe unhealthy → the result (pass *or* fail) is untrustworthy → relaunch + **re-run that gate** (capped at 3 relaunches); post-gate probe healthy + gate failed → **genuine RED, never retried**. The probe is `isStyleLoaded` + `loaded()` + a `queryRenderedFeatures()` sanity + background-layer presence on the ashfall map, ~5s budget.
- **Process control shells out to `scripts/relaunch-obsidian.sh`** (osascript quit → wait for exit → `open -a Obsidian` → poll the plugin ready). The board never relaunches unless a probe fails.
- **Fixture hygiene is enforced per gate** (§2.4b): after every live gate the board asserts `git status --short dev-vault/` is empty; a gate that passes its own assertions while dirtying committed fixtures is a **RED** gate. The board restores cleanliness (`git checkout -- dev-vault/` + `git clean -fdq -- dev-vault/`, which respects `.gitignore` so `.mapcache/` is untouched) before continuing so one offender doesn't cascade.
- **The report** is written to `shots/board-report.md` (per-gate pass/fail + wall-clock + relaunch count + post-probe health + totals) — that's the artifact you paste into PROGRESS.md.

## Rules for agents

- Generator/tuning work starts in the playground (§Playground above) — do not burn
  build+reload+screenshot cycles iterating on `src/gen` output the playground shows
  in milliseconds. Come to the Obsidian loop for the host-integration slice.
- Never mark UI work done without `dev:errors` clean + a screenshot you have actually read.
- `eval` is for *reading* state and driving the map; write vault content via `create`/`property:set` etc. (goes through Obsidian's own file layer, exercising the same events users trigger).
- `plugin:reload` after every build; `obsidian reload` (full window) if view registration changed.
- The CLI targets the vault of the cwd — run from `dev-vault/`, or pass `vault=dev-vault` as the first parameter, so you never touch Jonah's real campaign vault.

## Hard-won pitfalls (every one of these cost an agent real hours — plan-020 build, 2026-07)

- **`plugin:reload`, never `plugin:enable`.** `enable` is a silent no-op when the
  plugin is already enabled — you will spend a gate run testing stale code.
- **Long Obsidian sessions degrade the renderer.** After many back-to-back gate
  runs in one process, `isStyleLoaded()` starts returning false everywhere and
  render checks time out. Nothing in-app recovers it — fully quit and relaunch
  the Obsidian process. Final gate boards run **one gate per fresh process**.
- **Async evals**: `eval` returns synchronously — park promise results on
  `window` globals (`window.__myTest__ = …`) and poll with follow-up evals.
- **Screenshots on macOS need the window fronted** first, or you capture
  whatever is on top. Then actually Read the png.
- **Modals hang CLI automation.** Every GM flow that opens a modal needs a
  headless test-API twin on `app.plugins.plugins['campaign-map']`
  (precedents: `createRegionForTest`, `moveVertex`, `setRegionParams`,
  `rerollRegion`) that runs the FULL commit path — validation, mutation log,
  persist, regen — not a shortcut around it.
- **Never bake absolute zoom thresholds.** Fictional campaigns sit at overview
  zoom ~z4.5; layer minzooms like z14 are unreachable there. Jonah's standing
  ruling (Kanto test, reaffirmed 2026-07-12): zoom LOD affects location-name
  visibility ONLY — sketched and generated fabric render at every zoom.
- **`dev-vault/Campaigns/Vespergate` contains Jonah's real campaign data**
  (the migrated procgen district, hand-sketched districts). Gate fixtures are
  name-tagged (`__p40_test__` style), self-clean on rerun, and must leave his
  files byte-intact — `git diff` those files after a gate run; if dirty,
  `git checkout --` and find the leak.
- **Perf on the dev machine proves nothing.** The Mac Neo is several times
  faster than the Surface Pro budget target (and its Retina/ProMotion display
  further distorts "feels smooth"). Perf claims need numbers under CPU
  throttle (frame times during a scripted pan, `setData` durations), not
  vibes. Known unmeasured hotspots: always-visible footprints/parcels (~12k
  fills), whole-collection `setData` on regen.
- **Determinism is per-machine, not cross-machine.** V8's transcendental
  functions aren't guaranteed bit-identical across architectures — which is
  fine because `.mapcache/` is local, sync-excluded, and disposable. Never
  sync the cache between machines or assert byte-equality across them; the
  durable truth is the sketches + manifest, and each machine regenerates.
- **Never bypass `appendCachedTile`** (`src/model/tileCache.ts`): cache appends
  serialize through a per-file promise chain — two racing writers on a freshly
  deleted file used to clobber records (fixed 2026-07-11; don't reintroduce).
