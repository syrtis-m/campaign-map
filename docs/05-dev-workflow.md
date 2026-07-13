# Dev Workflow: Building & Testing with the Obsidian CLI

*The [official Obsidian CLI](https://help.obsidian.md/cli) (Obsidian 1.12.7+ installer, enable in Settings → General → Command line interface) lets coding agents build, reload, drive, and verify the plugin without a human clicking. The app must be running; commands hit the live instance. There is also a ready-made [obsidian-cli agent skill](https://github.com/kepano/obsidian-skills/blob/main/skills/obsidian-cli/SKILL.md) — install it alongside the MapLibre skills.*

## Setup (once per machine)

1. Obsidian installer ≥ 1.12.7; enable CLI in Settings → General (macOS symlinks `/usr/local/bin/obsidian`; Windows adds `Obsidian.com` redirector to PATH — covers both the Mac Neo and the Surface Pro).
2. Dev vault at `dev-vault/` in this repo (a real vault with a test campaign per genre: fictional-fantasy, real-city, neon-sprawl city).
3. `npm run dev` — esbuild watch, output symlinked/copied into `dev-vault/.obsidian/plugins/campaign-map/`.

## The core loop (agents: this is your inner cycle)

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
| Generators (pure) | **Vitest**, no Obsidian | Seeded snapshot fixtures; 2×2 seam tests; determinism (same seed twice → identical) |
| Model/validators | Vitest | Zod schemas, frontmatter parse round-trips |
| Integration | **Obsidian CLI script** (`npm run test:app`) | The loops above: reload → drive → eval-assert → `dev:errors` clean |
| Visual | CLI screenshots | Per-theme, per-genre screenshots into `shots/`; agent reviews against quality bar; keep goldens in repo |

Unit tests need no Obsidian and stay fast — that's why generators are host-agnostic. Integration tests are a bash/TS script of CLI calls with exit-code assertions; run before any commit touching `src/map/`, reconciliation, or themes.

## Test tiers (T0–T3) — how much to run, when (plan 021)

Testing used to mean "run the whole board," which cost an afternoon. It no longer does. Pick the smallest tier that covers what you changed and escalate only as you approach a commit/merge. Each tier is a strict superset of the one below.

| Tier | When | What runs | Command(s) | Budget |
|---|---|---|---|---|
| **T0** inner loop | every edit | fast unit suite + tsc | `npm test` (+ `npx tsc --noEmit`) | **<45 s** |
| **T1** phase checkpoint | finishing a phase's work | T0 **+ fuzz tier + that phase's own gate(s)** | `npm test && npm run test:fuzz` + `tsx scripts/gates/<phase>.ts` | <5 min |
| **T2** pre-commit | before any commit | T1 **+ change-scoped gates** | `npm run gates:changed` (add `--run` to execute them) | scoped |
| **T3** pre-merge / release / determinism-critical | merging, releasing, or touching determinism-critical shared code | **full board** (unit + fuzz + tsc + build + every live gate) | `npm run board` *(lands in plan 021 phase B; until then, run the gate scripts one-per-fresh-process)* | <15 min |

- **`npm test` is the FAST tier** (target <30 s): everything except the slow fuzz/stress tests, which live in `*.fuzz.test.ts` and run via **`npm run test:fuzz`** at T1+. Run the fuzz tier whenever a **generator's behavior actually changed**; skip it for docs/UI-only edits. Together `npm test` + `npm run test:fuzz` cover the identical set of tests — every test is in exactly one tier.
- **Change-scoped gates (T2):** `npm run gates:changed` intersects `git diff --name-only` (vs the last green board, stored in `.lastgreenboard`; override with `--ref=<sha>`) against `scripts/gates/coverage.json` and runs only the gates whose globs match. It **escalates to the full board automatically** when a determinism-critical path changes (`src/gen/region.ts`, `src/gen/rng.ts`, any `clip.ts`, `src/model/tileCache.ts`) — those feed every generator, so a scoped run can't prove them safe.
- **Screenshot judgment stays mandatory where visual** (docs/04's screenshot test is untouched — the tiers make room for it by removing everything else from the critical path). Never mark visual work done without reading the png.
- **Commit-message tag records the tier that ran:** `[gate: changed-scope 4/4]` for a T2 commit, `[gate: full board]` for T3. A commit that only ran T0/T1 says so.

## Rules for agents

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
