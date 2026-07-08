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
