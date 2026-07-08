# Decisions Log

*Append-only. Format: date, decision, alternatives considered, reversibility.*

## 2026-07-08 — Local Node.js install without a package manager

**Decision:** Downloaded the official Node v22.14.0 darwin-arm64 tarball from nodejs.org and symlinked its `bin/` into `~/.local/bin` (already first on PATH), since neither `node`/`npm` nor `brew`/`nvm`/`fnm`/`volta` were present on the build machine.
**Alternatives:** wait for human to install Node; use a different package manager. Rejected — preflight requires network+Node, and a direct binary download is standard/reversible.
**Reversibility:** fully reversible — delete `~/.local/opt/node-*` and the symlinks in `~/.local/bin`.

## 2026-07-08 — dev-vault registration requires editing Obsidian's global vault registry

**Decision:** The Obsidian CLI only operates against vaults already known to the running app (`~/Library/Application Support/obsidian/obsidian.json`); there is no CLI command to register a new vault, and the `obsidian://open?path=` URI only resolves vaults that already contain a known path. To make `dev-vault/` CLI-addressable, quit the running Obsidian app, added a `dev-vault` entry to `obsidian.json` (new random hex id, `"open": true`), and relaunched. Confirmed with Jonah before relaunching since this touched global (out-of-repo) state and briefly closed his `ao3-archiver` session.
**Alternatives:** drive the GUI "Open folder as vault" dialog (no click/GUI-automation tool available in this environment); skip live CLI integration entirely (rejected — CLI-driven testing is load-bearing per docs/05 and docs/06 Tier A gates).
**Reversibility:** reversible — removing the `dev-vault` entry from `obsidian.json` (or just its `"open": true` flag) restores prior behavior; `ttrpgs` and `ao3-archiver` entries were left untouched other than clearing the stale `"open"` flag on `ao3-archiver` (harmless — only affects which vault auto-opens next launch).

## 2026-07-08 — GitHub repo created fresh

**Decision:** No existing `campaign-map` repo under the user's GitHub account; created `syrtis-m/campaign-map` (private, matching the pattern of the user's other in-progress/private repos) via `gh repo create --source=. --remote=origin`.
**Alternatives:** none — user's `/goal` invocation explicitly authorized autonomous commit+push.
**Reversibility:** reversible (repo can be deleted/renamed later).

## 2026-07-08 — Phase 0 "blank parchment world" = literal placeholder style

**Decision:** Roadmap Phase 0 says "blank parchment world panning at 60fps", while architecture §4 pins `obsidian-native` (CSS-variable-derived) as the default theme for new campaigns, with handcrafted themes like `parchment` as per-campaign overrides landing Phase 1/2. Read "parchment" here as colloquial ("blank, parchment-colored, non-broken-looking"), not a commitment to the `parchment` theme id. Implemented `src/map/style.ts` as a single-layer MapLibre style (background only) using the pinned `parchment` land token (`#f2e8cf`, docs/06 §3) as a neutral placeholder color — no theme system exists yet.
**Alternatives:** build the real `obsidian-native` runtime style generator now — rejected, it's explicitly scoped to Phase 1 and depends on reading live Obsidian CSS variables + `css-change` events, which is real work belonging to that phase's roadmap bullet.
**Reversibility:** fully reversible — `blankWorldStyle()` is replaced wholesale by the theme system in Phase 1/2.

## 2026-07-08 — Custom scale bar instead of MapLibre's ScaleControl

**Decision:** MapLibre's built-in `ScaleControl` computes meters-per-pixel from the map's actual (real) latitude via true Web Mercator math. Fictional campaigns use fake lng/lat as coordinates (architecture §4, Spike B), so the built-in control would show numerically meaningless units. Wrote `src/map/fictionalCRS.ts`: treats fake coordinates as degrees at the equator, converts pixel distance → fake-degree distance → real-world meters via each campaign's `scaleMetersPerUnit`, then rounds to a "nice" 1/2/5×10^n step, Google-Maps-style (docs/06 §3: "when genuinely undecided, pick the option closest to Google Maps behavior").
**Alternatives:** disable the scale bar for fictional campaigns entirely — rejected, quality-bar / Spike B exit criteria explicitly calls for a working scale bar in fake-coordinate space.
**Reversibility:** reversible/extensible — real-city campaigns (Phase 2) can just use MapLibre's stock `ScaleControl` since their coordinates are true lng/lat; the custom bar only needs to apply to `crs: fictional` campaigns.

## 2026-07-08 — Manual DOM patch for map-tab header/title text

**Decision:** Obsidian doesn't re-invoke `ItemView.getDisplayText()` after `setState()` changes what it would return — confirmed empirically (calling the undocumented `leaf.updateHeader()` after `setState` did not change the rendered header text). Both the tab-strip title and the center-pane header title are patched directly in `MapView.refreshHeaderTitle()`, using `leaf.tabHeaderInnerTitleEl` (undocumented but stable, used by many community plugins) for the tab and a scoped `.view-header-title` DOM query for the pane header.
**Alternatives:** live with the generic "Campaign map" title until the leaf is closed/reopened — rejected, fails the Phase 0 exit test's implicit requirement that the opened tab reads "Map: Ashfall".
**Reversibility:** reversible — if a future Obsidian version re-queries `getDisplayText()` properly, this patch becomes a no-op-safe redundant write, not a correctness hazard.
