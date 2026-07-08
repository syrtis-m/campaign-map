# Autonomous Build Protocol

*Audit result, July 2026: the docs as of rev 2 were NOT sufficient for an unattended 5-phase run. Five gap classes: un-scriptable human setup, human-judgment exit tests, unpinned aesthetic decisions (stall-or-drift risk), gates described in prose rather than assertions, and no long-run state protocol. This doc closes all five. `GOAL.md` at repo root is the actual goal command.*

## 1. Preflight (human does once; agent verifies, never assumes)

The agent's first act is `scripts/preflight.sh` (build it in Phase 0 before anything else). Every check fails fast with a remediation message:

| Check | How | If missing |
|---|---|---|
| Obsidian ≥ 1.12.7 running | `obsidian version` | HUMAN: install/launch (CLI registration shows an admin dialog — cannot be scripted) |
| CLI registered | `which obsidian` | HUMAN: Settings → General → Command line interface |
| dev-vault exists + restricted mode off | `obsidian vault=dev-vault vault` / `plugins:restrict off` | Agent creates `dev-vault/`, seeds `.obsidian/` config, test campaigns |
| Node ≥ 20, git repo, network | standard | HUMAN if offline |
| Agent skills present | `ls .claude/skills/` | Agent clones [maplibre-agent-skills](https://github.com/maplibre/maplibre-agent-skills) + [obsidian-skills](https://github.com/kepano/obsidian-skills) |
| Assets fetchable | HEAD requests | See asset manifest §4 |

**Jonah's total required setup: install Obsidian 1.12.7+, enable CLI, launch it, run `claude` with GOAL.md. Everything else is agent work.**

## 2. Two-tier gates (replaces prose exit tests)

**Tier A — automated, blocking.** Machine-checkable assertions; the agent may not enter phase N+1 until phase N's Tier A passes. Each phase gets `scripts/gates/phaseN.ts` (CLI-driven; exit code = verdict). The canonical assertions:

- **Determinism**: generate tile set twice with same seed → deep-equal; delete `.mapcache/` → regenerate → hash-identical. (Every phase from 3 on.)
- **Seams**: 2×2 adjacent tiles → every edge-crossing line's endpoints match within ε; screenshot pixel-strip diff across seam < threshold.
- **Label collisions**: `eval` `queryRenderedFeatures` on symbol layers → bounding-box overlap count == 0 at z∈{4,8,12,16} on the three test campaigns.
- **Blank voids**: screenshot → no contiguous region > 15% of viewport with zero rendered features AND background-only pixels (checks F4 treatments exist).
- **Reconcile**: CLI `create`/`rename`/`delete` location note → `eval` index state within 500ms; bad frontmatter → warning badge present, note untouched.
- **Perf**: `eval` frame-time sampler during scripted 5s pan → p95 ≥ 50fps (CI machine proxy for the Surface Pro's 60).
- **Quick-add**: scripted flow via commands → note exists + pin rendered, wall-clock < 5s.
- **Theme-follow**: `theme:set` twice → map background color equals computed `--background-primary` each time.
- **No-Node-API**: grep bundle for `require("fs")`/`node:` imports → zero.

**Tier B — human review, non-blocking.** Aesthetic judgment (F6 craft, "genre in 3s", generator beauty) queues instead of stopping: agent writes `review/NNN-<topic>.md` with screenshots + specific questions, then *continues building*. Jonah reviews asynchronously; feedback becomes new tasks. The Phase 1 "run a real session" test is Tier B: the agent ships the phase on Tier A and flags the session test as pending.

## 3. Pinned decisions (so the agent never stalls or invents)

**Fonts** (download + generate glyph PBFs via font-maker in Phase 2; all OFL-licensed): `obsidian-native` → inherit theme font, fallback Inter. `modern-clean` → Inter. `parchment` → Alegreya (labels) / Cormorant SC (regions). `ink-soot` → IBM Plex Serif / Oswald (regions). `neon-sprawl` → Rajdhani / Saira Condensed (regions).

**Theme tokens** (exact values; agent may tune ±10% L/C in OKLCH, logged, never hue):

| Token | modern-clean | parchment | ink-soot | neon-sprawl |
|---|---|---|---|---|
| land | #f8f7f2 | #f2e8cf | #22211f | #0d0d11 |
| water | #a8d0e8 | #c9d6c5 | #14181c | #101820 |
| road-major | #ffffff/#f0c948 casing | #8a6f4d | #4a4642 | #00e5ff glow |
| road-minor | #ffffff | #b09a76 | #35322e | #cc3ecf glow |
| label-major | #33322e | #4a3b28 | #c9c4bb | #eaeaea |
| label-minor | #7a786f | #7d6a4f | #7d7871 | #8a93a6 |
| accent/selection | #1a73e8 | #7d1f1f | #b8860b | #fcee0a |
| poi | #5f6368 | #5c4a2e | #948b7f | #00e5ff |

**Type taxonomy defaults** (importance 1=highest; zoom = visible range):

| type | importance | zoom | | type | importance | zoom |
|---|---|---|---|---|---|---|
| nation/region | 1 | 2–8 | | district | 4 | 11–16 |
| city | 2 | 5–12 | | street(named) | 5 | 13+ |
| town | 3 | 7–13 | | landmark | 4 | 10+ |
| village | 4 | 9–14 | | shop/tavern/venue | 6 | 14+ |
| route | 3 | 5–13 | | residence/minor | 7 | 16+ |
| water-feature | 2 | 3–12 | | custom (GM) | 5 | 12+ |

**Naming cultures** (seed profiles, one per test campaign): `fantasy-brackish` (harsh coastal: consonant clusters, -haven/-wick/-mire), `modern-anglo` (real-city overlay: person-name + generic), `neon-corpo` (portmanteau + kana-esque syllables + Inc/Corp). Profiles are phoneme tables in `src/gen/naming/cultures/` — agent authors 2 more per genre later, same format.

**Tuning ranges**: tensor-field decay 0.1–0.4, streamline dsep 20–60m-equiv, block subdivision min-area 400m², Poisson r by zoom band table in `src/gen/world/params.ts`. Agent tunes within ranges against Tier A metrics + screenshot review; out-of-range changes require a `review/` entry.

**When genuinely undecided**: pick the option closest to Google Maps behavior; log to `DECISIONS.md` (append-only: date, decision, alternatives, reversibility); never block.

## 4. Asset manifest (fetched by preflight, cached in `assets/`, attributions to `ATTRIBUTIONS.md`)

- Fonts listed above from Google Fonts (OFL) → glyph PBFs via maplibre font-maker
- Icon pool: [game-icons.net](https://game-icons.net/) SVG pack (CC-BY 3.0 — attribution file mandatory)
- Test basemap: Protomaps extract, default bbox = central London `-0.20,51.46,-0.05,51.54` (~dense, good stress test) from current daily build ([downloads](https://docs.protomaps.com/basemaps/downloads)); recorded URL + date in campaign config
- Paper/noise textures: generate procedurally (seeded) — no downloads, no license risk

## 5. Long-run state protocol (context will be lost; the repo is the memory)

- **`PROGRESS.md`** at root: phase, current gate status, next 3 actions, open blockers. Updated after every gate run. Any fresh agent session must be able to resume from CLAUDE.md + PROGRESS.md alone — write it that way.
- **`DECISIONS.md`**: append-only decision log (§3).
- **`review/`**: Tier B queue.
- **Git discipline**: commit after every green Tier A gate and every completed roadmap bullet; message format `phaseN: <what> [gate: pass|pending]`. Never commit with `dev:errors` non-empty.
- **Retry policy**: a failing Tier A assertion gets max 5 distinct fix attempts (not 5 retries of one idea); then log blocker in PROGRESS.md, switch to non-dependent work in the same phase; if the phase is fully blocked, stop and surface — that's the *only* legitimate stop.

## 6. Residual honest limits

Even with all this: (1) CLI registration + app launch need a human once per machine; (2) Obsidian must stay running and desktop unlocked for CLI-driven integration tests — a sleeping laptop pauses the run; (3) Tier B means the *final* quality claim still needs Jonah's eyes — the agent can guarantee "correct and consistent," only a human confirms "beautiful"; (4) a real-session test is irreplaceably human. None of these stop the build; they bound what "done" means without you.
