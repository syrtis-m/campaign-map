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

**Gate execution tiers (T0–T3, plan 021).** Tier A assertions above are still the bar; what changed is *how many gates you run when*. Don't re-prove the world on every edit — run the smallest tier that covers the change and escalate toward a commit. Full protocol in docs/05 §Test tiers; the gate-relevant summary:

- **T0** (every edit): fast unit suite (`npm test`, <30 s) + `tsc`. No live gates.
- **T1** (phase checkpoint = **the per-phase commit bar**, Jonah 2026-07-13): T0 + build + `npm run perceptual` + **the phase's own gate(s), run standalone** (+ fuzz tier iff generator behavior changed). This is what a phase commits on — unchanged gates inherit the previous board's green. Commit tag: `[gate: T1 …]`.
- **T2** (optional diagnostic, never required): **change-scoped gates** — `npm run gates:changed` intersects the diff (vs `.lastgreenboard`, override `--ref=<sha>`) against `scripts/gates/coverage.json` and runs only the covering gates. Note it auto-escalates to FULL on determinism-critical paths (`src/gen/region.ts`, `src/gen/rng.ts`, any `clip.ts`, `src/model/tileCache.ts`), which is exactly why it's no longer a per-commit step.
- **T3** (**ONCE per plan, at its final ⛳ phase** — and releases): the **full board** — unit + fuzz + tsc + build + every live gate, one report. Commit tag: `[gate: full board N/M]`. Run it with the one-command **`npm run board`** runner (plan 021 §2.3, docs/05 §The board runner): one Obsidian process, a health probe between gates that relaunches + re-runs only when the renderer degrades, per-gate fixture-hygiene enforcement, and a `shots/board-report.md` artifact. **Board-flake rule:** a gate that fails in the board but passes standalone immediately after counts green (environment flake — log both results); never re-run the whole board chasing a clean sweep.

**The board runs once per plan, not per phase or commit** (Jonah 2026-07-13). Repeated ~6-min boards per phase — plus flake-chasing re-runs — measurably turned hours of dev into >24 h; the per-phase bar is T1.

Fixture hygiene is enforced by the board runner: after every gate, `git status --short dev-vault/` must be empty (§2.4b) — a gate that passes its own assertions while dirtying committed fixtures is a **red** gate, restored before the next gate. Screenshot judgment (Tier B / docs/04) stays mandatory where visual.

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

**Sketched-fabric tokens** (plan 017 — one color per fabric kind so road/wall/river/water/district/park read distinct in every theme; shades of existing hues where that reads fine, new hues only where the palette lacked one — park green, wall stone):

| Token | modern-clean | parchment | ink-soot | neon-sprawl |
|---|---|---|---|---|
| fabric-water | #a8d0e8 (=water) | #c9d6c5 (=water) | #1a2530 | #10344a |
| fabric-river | #5a9bd4 | #6f8fa0 | #4a6478 | #3a7bd5 |
| fabric-road | #f0c948 (=casing gold) | #8a6f4d (=road-major) | #4a4642 (=road-major) | #00e5ff (=road-major) |
| fabric-wall | #857a68 | #5e564a | #8a7a5f | #ff6a3d |
| fabric-park | #a8d5a2 | #9db87a | #5f7a4d | #30c85e |
| fabric-district | #e07f4f | #8f4a3d | #584a6b | #8034a8 |

`obsidian-native` derives fabric colors at runtime: road = `--text-muted`, district wash = `--interactive-accent`; water/river/park/wall are fixed neutral hues picked per background luminance (light vs dark palette in `src/map/theme.ts`). District/park fills render at low opacity (0.18 / 0.45) — the wash must never slab the base.

**Fabric has NO zoom LOD** (Jonah, 2026-07-10 — "LOD should only impact visibility of location names"): the `fabric-*` layers carry no `minzoom`; every kind renders at every zoom. Only the source `tolerance` applies (geometry simplification for perf, not hiding). Do not reintroduce per-kind fabric minzooms. Zoom-based hiding is exclusively for location-name labels (the depth-of-field model below).

**Type taxonomy defaults** (importance 1=highest; visibility-hint = the QuickAdd
pre-selection only — since plan 015 it does NOT gate labels at runtime):

| type | importance | vis-hint | | type | importance | vis-hint |
|---|---|---|---|---|---|---|
| nation/region | 1 | wide | | district | 4 | mid |
| city | 2 | wide | | street(named) | 5 | close |
| town | 3 | mid | | landmark | 4 | mid |
| village | 4 | mid | | shop/tavern/venue | 6 | close |
| route | 3 | mid | | residence/minor | 7 | close |
| water-feature | 2 | wide | | custom (GM) | 5 | mid |

*Depth-of-field label model (superseded the per-type continuous zoom range,
2026-07-10 — Jonah-authorized; see DECISIONS.md).* The map has **three focus
levels** (Wide/Mid/Close), computed per campaign from its overview zoom, not
absolute. A location's **dot always renders at every zoom**; its **explicit
`visibility` field** (plan 015 — `wide`/`mid`/`close`, mapped 1:1 to the internal
`deep`/`medium`/`shallow` bucket at the parse boundary) sets at how many focus
levels its **name** is legible — `wide` all three, `mid` from Mid inward, `close`
at Close only. **Visibility is decoupled from `type`**: `type` is semantic only
(naming, future icons); the vis-hint column above is used ONLY to pre-select the
QuickAdd picker, and the chosen value is always written explicitly to the note. A
note with no `visibility` (and no legacy `focus:` key) falls back to the single
global default **mid** — never a type-derived bucket. `importance` still drives
label size + collision priority; the old `zoomMin`/`zoomMax` are retained only for
incidental camera math (fly-to, generation-band split), never for label gating.
Reveal is per-layer `minzoom` (three bucketed label layers, still filtered on the
feature's `focus` property) — zoom is NEVER put in a filter (invalidates the whole
style; see the styleValidation test + the smokeBoot gate's live style-load checks).

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
