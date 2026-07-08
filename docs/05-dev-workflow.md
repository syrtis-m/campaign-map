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

## Rules for agents

- Never mark UI work done without `dev:errors` clean + a screenshot you have actually read.
- `eval` is for *reading* state and driving the map; write vault content via `create`/`property:set` etc. (goes through Obsidian's own file layer, exercising the same events users trigger).
- `plugin:reload` after every build; `obsidian reload` (full window) if view registration changed.
- The CLI targets the vault of the cwd — run from `dev-vault/`, or pass `vault=dev-vault` as the first parameter, so you never touch Jonah's real campaign vault.
