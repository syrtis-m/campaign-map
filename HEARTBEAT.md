# HEARTBEAT.md — overnight run: implement plans 021–028

**Unattended driver (the one that survives kills): `scripts/heartbeat-run.sh`**
```
./scripts/heartbeat-run.sh          # start / resume the overnight loop
./scripts/heartbeat-run.sh status   # unchecked boxes + STOP state + last logs
./scripts/heartbeat-run.sh stop     # perma-cancel (survives re-invocation)
```
This bash supervisor is the **only** thing that survives a process death. It
re-invokes a fresh cold `claude -p` after every kill (usage-limit, crash, or
reboot if you wrap it in cron/launchd), runs **exactly one phase per
invocation** (docs/08 rule 2 — each process cold-reads this file, does the next
box, commits+pushes, exits), naps ~45 min on a confirmed limit-kill, and
perma-cancels the instant `grep` finds zero unchecked boxes. Completion is
decided by grep on this file, not a model.

**Why a script and not just `/goal` or `/loop`:** both are **session-scoped** —
they drive turns only while the process is alive and do **not** auto-resume a
dead process (a goal is restored only on a manual `claude --resume`). A usage
limit or reboot leaves nothing running; the supervisor is what relaunches. See
docs/08 for the full pattern.

**Attended alternative (you're watching, hands-on):** in an open session,
`/goal implement plans 021-028 per HEARTBEAT.md — do the next unchecked box to
its green T1 gate, commit+push, flip it; stop when every box is checked` keeps
turns going with no idle wait — but only while that session lives; restore with
`claude --resume` after a kill. `/loop` (self-paced) is the polling equivalent.

This file is the **single durable source of truth for run state**. Usage
limits WILL kill sessions mid-run (it happened twice on 2026-07-12); the run
must survive any kill with at most one phase of rework. Everything below
exists to make that true.

## Wake protocol (do this at the START OF EVERY `/loop` ITERATION / session resume, before any work)

1. Read this file top to bottom. The checklist (§Checklist) says what's done;
   trust it only after step 2 confirms it.
2. Verify against reality: `git log --oneline -15` (checked boxes must have
   their commit hashes on `main`) and `git status` (uncommitted work = a
   phase was interrupted).
3. If the tree is dirty: finish the interrupted phase to its green gate if
   the remaining work is clear from the diff + the plan; otherwise
   `git stash` it, note what was stashed under §Log, and restart that phase
   clean. Never commit a red gate; never discard Jonah's dev-vault data
   (see rules below).
4. If a background subagent was running when the session died, resume it
   from its transcript (SendMessage) rather than respawning cold — but if
   its transcript is gone, respawn with the phase brief from the plan.
5. Continue at the first unchecked box, in order. Do ONE phase this
   iteration, then let the loop reschedule — don't chain phases in a single
   turn (one kill = one phase of rework depends on this).
6. If every box (including the FINAL box) is checked and verified against
   `git log`, the run is done: stop the loop (`ScheduleWakeup(stop: true)`)
   instead of rescheduling, and say so.

## Execution rules (non-negotiable)

- **Lean orchestrator ingest (docs/08 rule 4):** per iteration the ORCHESTRATOR
  reads only bounded artifacts — this file, `git status`/`git log`, docs/06 (gate
  protocol), and *only the current phase's section* of the current plan (enough
  to write the brief + verify). The full plan §0 (invariants + infra pitfalls)
  and the source get read **inside the phase subagent**, whose fresh window is
  discarded after — NOT in the orchestrator's window. This keeps the
  orchestrator's context roughly flat across the whole run. (CLAUDE.md is
  already in context each session.)
- **Order is the checklist order** (021 first is deliberate: after 21-A the
  fast tier makes every later phase cheaper; after 21-C most lifecycle tests
  are headless). Dependencies are already encoded — do not resequence except:
  a BLOCKED phase may be skipped iff no later-executed box depends on it
  (note it under §Blocked and move on).
- **One phase = one green gate = one commit = one push.** Commit message
  convention: `plan02X-<phase>: <summary> [gate: <results>]`, ending with the
  Claude co-author line. Push `origin main` after every phase commit — the
  overnight machine could die too. Then flip the box here (add the commit
  hash), update PROGRESS.md, log judgment calls in DECISIONS.md, and include
  HEARTBEAT.md/PROGRESS.md/DECISIONS.md in that same commit or an immediate
  `state:` follow-up commit.
- **Subagents:** one Opus subagent per phase with a self-contained brief
  drawn from the plan (the plans' §0 sections are written for exactly this).
  Orchestrator verifies independently (fast suite + tsc minimum) before
  committing. Subagents never commit.
- **Tier discipline (TIGHTENED by Jonah live, 2026-07-13 — overrides any
  looser reading):** inner loop = fast suite; a phase COMMITS on T1 = fast
  suite + tsc + build + that phase's OWN live gate standalone (+ fuzz iff
  generator behavior changed). The full board runs ONLY at the ⛳ plan-end
  boxes below — never per phase, never per commit, and `board --changed` is
  retired as a commit step (its determinism-path escalation made it a full
  board almost every phase). Board-flake rule: a gate that fails in a board
  but passes standalone immediately after counts GREEN (environment flake,
  021-B) — log both results, do NOT re-run the board. Repeated ~6-min boards
  turned hours of dev into >24 h; that is the failure this rule kills.
- **Jonah's data:** `dev-vault/Campaigns/Vespergate` is real campaign data —
  byte-intact after every gate (git diff empty or frontmatter-formatting
  only). Gate fixtures: name-tagged, self-cleaning.
- **Open questions in plans:** decide, log decision + rationale in
  DECISIONS.md, flag under §Questions here. Never guess silently, never stall
  waiting for Jonah overnight.
- **Do not** modify plan files except status stamps; do not relitigate locked
  decisions; determinism rules D1–D6 bind every phase.

## Checklist (flip `[ ]`→`[x] <commit>` only after gate-green + committed + pushed)

**Plan 021 — fast testing** (`plans/021-fast-testing.md`)
- [x] 4adb2eb 21-A ⚡ fuzz-tier split (`test` <30 s, `test:fuzz`) + change-scoped
      gating (`coverage.json`, `board --changed`) + T0–T3 tier docs + phase1
      fixture fix (stops stripping `connections:` from Ashfall notes) (021
      §2.1, §2.4b, §2.5, §2.6)
- [x] 5030d88 21-B board runner w/ health-probed restarts (incl. per-gate
      dev-vault-clean assertion, 021 §2.4b) + renderer-degradation
      investigation, TIMEBOXED to one session — no root cause by then: document
      evidence, keep probe-restarts, move on (021 §2.2–2.3)
- [x] 62660d3 21-C MapController extraction + FakeHost harness, ZERO behavior
      change, full board green before AND after (021 §2.4) ⛳ full board
- [x] 4369db6 21-D plan-021 acceptance gate: injected determinism break caught;
      assertion-migration map written (021 §4)

**Plan 022 — algorithm suite** (`plans/022-procgen-suite-rivers-forests-parks-walls.md`)
- [x] 5d7742e 22-A preset pattern + city-profiles retrofit + additive-params
      rule (022 §1)
- [x] 4e6d981 22-B spine support + RIVER (windiness/braiding, position-keyed
      per-segment meander, corridor containment) (022 §2, §3.1)
- [x] c012975 22-C FOREST (new kind, masked-noise canopy — cell-fill fallback,
      marching squares deferred to 023; theme paint in ALL themes) (022 §3.2)
- [x] ab320f4 22-D PARK incl. japanese-garden (022 §3.3)
- [x] b119117 22-E WALL elaboration + raw-sketch double-wall suppression (022 §3.4)
- [x] 257e280 22-F FARMLAND incl. outskirt-field suppression (022 §3.5) ⛳ full board

**Plans 026–028 — visual overhaul, wave 1** (`plans/026-forest-visual-overhaul.md`,
`plans/027-park-visual-overhaul.md`, `plans/028-river-visual-overhaul.md` —
slotted by Jonah's ruling 2026-07-13; no 023 dependency, biggest visual wins
pulled forward. First box here also commits the three plan files + README rows.)
- [x] 749c74f VO-W0 prep: split `generatedLayers.ts` into per-kind modules (e.g.
      `src/map/themes/generated/{world,city,river,forest,park,wall,farm}.ts`),
      ZERO behavior change — style-JSON byte-identical gate before/after.
      This is the ONE file all three plans touch; it makes the ∥ groups below
      conflict-free
- [x] 6f9c430 26-A forest trees: hashed Thomas-cluster placement + sizeN/rank/variety
      properties; stacked shadow/base/highlight circle paint keyed on
      forestType; `fill-antialias: false` on canopy (026 §2) — ∥ group P1
- [x] cd4f52f 27-A park ground: merged single lawn polygon + two-green canopy blobs +
      cased path LINE layers + water shore casing (027 §4) — ∥ group P1
      [P1 file protocol: 27-A owns any tokens.ts edit; 26-A uses match
      expressions per 026 Q1 default; 28-A touches neither]
- [x] e514ac0 28-A river body: per-segment channel-polygon merge + `river-bank`
      casing LineStrings + braid-island legibility floor; canal preset
      regression-checked (028 §2) — ∥ group P1
- [x] cd21d30 27-B park skeletons: boundary entrances (sketched-road constraints) +
      perimeter loop + desire-line diagonals; formal axis/mirror-parterres;
      japanese circuit/rocks/lanterns/roji; wild-common restraint (027 §4)
      — ∥ group P2
- [x] 0699e01 28-B river meander math: sine-generated-curve bend shape + Kinoshita
      third-harmonic skew + per-bend hashed wavelength/amplitude jitter;
      ratio-derived defaults (λ≈11W, R_c≥2W containment clamp); canal
      (windiness 0) byte-identical gate (028 §2) — ∥ group P2 [MUST precede
      23-E: river-slope coupling builds on this math]

∥ protocol (Jonah ruling 2026-07-13): a ∥ group is CODE-parallel — the three
generators + their tests/snapshots/gates are disjoint and VO-W0 removes the
shared-paint-file collision. Under the unattended driver, run ∥ boxes as
consecutive solo phases (one phase per invocation stands — the one-kill-one-
phase-rework property is load-bearing). An ATTENDED session MAY fan a group
out as concurrent worktree subagents inside one invocation, but integration
is ALWAYS serial: merge one plan-phase at a time → that phase's own T1 →
commit → push. Live gates and boards ALWAYS serialize (single dev-vault +
one Obsidian process); subagents never commit. Board cadence (Jonah
2026-07-13): ONE board covers all three overhaul plans, at 28-C — every other
wave box commits on T1 only.

**Plan 023 — constraint fields + elevation** (`plans/023-constraint-fields-and-elevation.md`)
- [x] 725c996 23-A `src/gen/fields/` core + BIT-EXACT interiorT/constraints retrofit
      (byte-identical city snapshot gate) (023 §2)
- [x] 3aed982 23-B elevation model + `mountain` kind + presets (heightAt untouched —
      023 §3 compatibility rule)
- [x] a5d9fbf 23-C contour lines (marching squares, seam gate, no new request
      surface) (023 §4.1)
- [x] 958f263 23-D hillshade + 3D terrain (raw-lattice cache, PNG at serve; heights
      compared in gates, never PNG bytes) (023 §4.2) ⛳ full board
- [x] 38abcdd 23-E paddy-terraces + river-slope coupling deferred from 022 (022 §3.1,
      §3.5) [runs after wave-1's 28-B by checklist order — coupling builds on
      the new meander math]

**Plans 026–028 — visual overhaul, wave 2** (needs 023: 23-C marching squares
for 26-B/27-C; 26-C's glyph module feeds 27-C/28-C)
- [x] 558a8a8 26-B forest canopy: domain-warped masked-noise field + clump metaballs →
      marching squares (23-C machinery) + Chaikin → ONE multipolygon w/
      clearing holes; rim line layer; dead-wood emits no canopy; 2×2 seam gate
      (026 §2)
- [x] 1643739 26-C tree glyphs: `treeGlyphs.ts` runtime canvas/SDF glyph module +
      symbol layers (icon-allow-overlap + ignore-placement,
      symbol-z-order viewport-y, icon-translate shadow layer, per-variety
      glyph/tint, rank×zoom opacity fade); perf on throttled CPU (026 §2)
- [x] 9e510d6 27-C park organic water/canopy (marching-squares shorelines) + glyph
      dressing via treeGlyphs + karesansui texture + bridge styling (027 §4)
      — ∥ group P3
- [x] 27ca5fe 28-C river junctions/mouths/dressing: confluence Y-merge
      (W₃=√(W₁²+W₂²), no inland forks), delta ~72° distributaries, estuary
      exponential flare, point bars/oxbows/rapids-falls-ford glyphs (028 §2)
      — ∥ group P3 ⛳ full board — ONE board covers plans 026+027+028
      (Jonah 2026-07-13); 26-B/26-C/27-C commit on T1 only

**Plan 024 — cross-layer cascade** (`plans/024-cross-layer-regen-cascade.md`)
- [ ] 24-A input fingerprints on cache records + stale-replay detection
      (024 §5.1 — hardens plan 020 too)
- [ ] 24-B stage DAG + upstream-as-data worker interface + cascade regen on
      edit (024 §2–§4)
- [ ] 24-C windiness acceptance gate + cascade-order determinism + multi-
      stage rm-.mapcache byte-diff (024 §6) ⛳ full board

**Plan 025 — street-pattern presets + benchmarks** (`plans/025-street-pattern-presets-and-benchmarks.md`)
- [ ] 25-A metrics.ts + benchmark gates for 4 existing presets + PRESET
      GALLERY campaign & gate (025 §3.1, §3.5)
- [ ] 25-B width system + superblock preset (025 §3.3, §2.6)
- [ ] 25-C tartan-grid + ward-grid + eixample + chamfer operator (025 §2)
- [ ] 25-D axial-breakthrough operator → haussmann + baroque-axial (025 §3.2)
- [ ] 25-E canal-rings + radial-star + seam boulevards + growth rings +
      small wins (025 §2, §3.4) ⛳ full board + refreshed gallery contact sheet
- [ ] FINAL: plans/README.md rows → DONE w/ evidence; docs/03 updated;
      review/ notes for Jonah's morning read (esp. gallery contact sheet +
      every §Questions entry)

## Blocked
(none — add entries as `- <box-id>: <why> — <what's needed>`)

## Questions for Jonah (answered decisions logged in DECISIONS.md; morning digest)
- ~~23-D board found procgen46 genuinely RED at clean HEAD~~ **FIXED
  (77c3bdb, this session):** confirmed gate rot from 027-A/B's park rework
  (lawn now seed-independent; formal basin intrinsic) — gate retargeted to
  park-tree scatter, 11/11 twice standalone. NOTE: the task chip for this was
  also STARTED in a parallel worktree session — that session will find it
  already green on pull; reconcile/discard its worktree as appropriate.
  `.lastgreenboard` still 257e280 (the 23-D board itself was 25/27).
- 23-D judgment calls (DECISIONS): pitch-adaptive terrain toggle (maplibre
  4.7.1 misrenders hillshade+mesh together — top-down gets 2D hillshade,
  pitched gets 3D mesh); terrarium-capped K=25 vertical scale; 3D
  exaggeration 6; DEM tile fill perf on Surface Pro untested (toggle is
  default-OFF; DEM_TILE_RES=256 is the knob).
- ~~22-E: new plan files 026/027 appeared from a parallel research session —
  ratify the slot or defer?~~ **RESOLVED (Jonah via the research session,
  2026-07-13):** plans 026–028 (028 river added same day) are ratified and
  slotted into this checklist as two waves + VO-W0 prep + ∥ protocol (see
  §Checklist). Commit the three plan files + README rows with the VO-W0
  phase (or an earlier `state:` commit if one happens first).
- 22-E judgment calls (details in DECISIONS.md): wall gates key on SKETCHED
  roads pre-024 (generated-street alignment deferred to the cascade — §3.4's
  "align to stage-3 streets" is read as the 024 target state); moat/bastions
  project to the deterministic left normal of the sketched line (open lines
  have no inside); suppression corridor 28 m, drops only the city's own
  wall-band segments (ring road + gates kept).
- 21-D F1: plan 021 §2.4's "≥70% of live-gate assertions move headless" is NOT
  cleanly met — 34% all-in (51% of domain assertions; ~33% of live-gate checks
  are irreducible live scaffolding: plugin-load/reload/dev:errors/screenshot
  per gate). Speed goals all met. Decision taken (DECISIONS 2026-07-13): no
  retro-migration of existing gates; 022+ tests are born headless on the 21-C
  harness. Full analysis: review/021D-assertion-migration.md. OK, or do you
  want a retro-migration pass?

## Log (one line per session/kill/resume — newest first)
- 2026-07-14 (arc run, session 7 cont.): ∥ P3 concurrent worktrees, serial
  integration — 27-C 9e510d6 (vo27-park 23/23 after the c8 investigation
  found a REAL host bug: rebuildTheme's styledata handler missed
  refreshGeneratedSource — css-change blanked all generated fabric; fixed) +
  28-C 27ca5fe (procgen49 22 checks green across two runs w/ disjoint
  seed-luck fails — timestamp-seed fixture class; confluence gusset
  numerically exact but reads blocky, flagged). WAVE-2 BOARD 26/30 (1142s,
  0 relaunches; all four wave-2 gates green in-board): procgen41 +
  hillshade23d flakes (standalone green), procgen45 gate rot from 26-B
  (density check rewritten to canopy AREA — fixed 12/12), procgen48
  seed-luck (standalone 13/13). Every failure standalone-green same day →
  .lastgreenboard → 27ca5fe. **PLANS 026/027/028 COMPLETE (visual overhaul
  done).** Fast 714. Next: plan 024 (24-A input fingerprints).
- 2026-07-14 (arc run, session 7 cont.): 26-C via phase subagent, T1 green —
  reusable SDF glyph module (headless EDT synthesis, addImage+
  styleimagemissing lifecycle surviving setStyle; 27-C/28-C consume it);
  circle stack → two symbol layers w/ zoom-ramped fade (26-A deferral
  closed); generator untouched so goldens/fuzz pinned. procgen51-glyphs
  13/13. PERF caveat: p95 19.2ms on the unthrottled dev machine — Surface
  Pro throttled numbers still owed (flagged). Committed 1643739. Fast 681.
  Next: ∥ P3 (27-C park water/canopy + 28-C river junctions ⛳ wave-2 board).
- 2026-07-14 (arc run, session 7 cont.): 26-B via phase subagent (advisor
  BANNED after repeated fatal API stalls — decisions made inline + documented),
  T1 green — organic canopy MultiPolygon w/ holes; two integration
  catches: line-on-fill rim stroked per-tile clip edges (→ rim LineStrings),
  and clipNetworkToTile had NO MultiPolygon branch (canopy silently dropped
  from tiles; branch added + holes preserved — all pre-existing goldens
  byte-green vouch the change is additive; 28-C board exercises it fully).
  Trees pinned byte-identical. procgen50-canopy 13/13. Committed 558a8a8.
  Fast 673. Next: 26-C tree glyphs.
- 2026-07-14 (arc run, session 7 cont.): procgen46 gate-rot RED fixed as its
  own commit (77c3bdb, 11/11 twice; the parallel chip session will find it
  green — reconcile its worktree). Then 23-E via phase subagent (resumed once
  after the recurring advisor-consult API stall — advisor skipped): cross-kind
  elevation via fields/mountainField (verbatim move + elevationFieldFromFabric
  — raw-sketch legality), paddy terraces w/ marching-squares banks + flat
  fallback, river slopeSensitivity (DEFAULT-ON — flagged for Jonah; rcCap
  pinned or λ-stretch cancels damping, caught live twice). coupling23e 13/13
  twice fresh-process. Committed 38abcdd. Fast 650. **PLAN 023 COMPLETE.**
  Next: wave-2 26-B (forest canopy marching squares).
- 2026-07-14 (arc run, session 7): resumed after a user interrupt of the 23-D
  agent (partial work on tree); goal re-set to "implement heartbeat.md";
  resumed the SAME agent from transcript per wake protocol — zero rework.
  23-D T1 green (fast 630/630, hillshade23d 14/14, screenshots incl. 3D mesh
  eyeballed) + plan-023 BOARD 25/27 (863s, 0 relaunches; all 23-gates green;
  procgen48 = seed-luck fixture flake, standalone PASS, chipped; procgen46 =
  PRE-EXISTING RED at clean HEAD, flagged in §Questions + chipped —
  .lastgreenboard stays 257e280). Committed 958f263. PLAN 023 DONE except
  23-E. Next: 23-E paddy-terraces + river-slope coupling.
- 2026-07-14 (arc run, session 6 cont.): 23-C via Opus 4.8 phase subagent, T1
  green first try — reusable fields/marchingSquares (026-B will consume it) +
  mountain-contour on existing-mountain regen (no new request surface);
  additive byte-identity pinned (23-B output digests unchanged). contours23c
  11/11; mesa terracing finally visible (its 23-B flag resolves). Deferred
  per §4.1 OQ#1: major-contour TEXT labels (index+elevation props emitted;
  pure paint add later — flagged for Jonah). Committed a5d9fbf. Fast 589.
  Next: 23-D hillshade + 3D terrain (⛳ full board).
- 2026-07-14 (arc run, session 6 cont.): 23-B via Opus 4.8 phase subagent, T1
  green — elevation noise (analytic derivative + eroded fBm) + mountain kind
  end-to-end (elevation23b 13/13, screenshots eyeballed). Key judgment calls
  (DECISIONS): per-REGION seed not campaign-wide (024 stage-0 composes);
  absolute-world field scale (region-derived scale broke edit-locality at 13%,
  caught live); hachures on the smooth low-octave gradient; dark-theme relief
  subtlety + massif opacity flagged for Jonah. Committed 3aed982. Fast 575.
  Next: 23-C contour lines.
- 2026-07-14 (arc run, session 6 cont.): 23-A via Opus 4.8 phase subagent, T1
  green first try — fields SDF core + verbatim-move retrofit (bit-exactness by
  construction: character-identical arithmetic relocated, one-way import);
  city SHA-256 digest golden added pre-retrofit; fields23a 7/7 (55 records
  byte-identical across live regenerate). Judgment ratified: §2's elevation
  noise deferred to 23-B (zero consumer in A). Committed 725c996. Fast suite
  539. Next: 23-B elevation model + mountain kind.
- 2026-07-14 (arc run, session 6 cont.): ∥ group P2 (27-B cd21d30, 28-B
  0699e01) — same concurrent-worktree fan-out, serial integration. WAVE 1
  COMPLETE. 27-B: vo27-park 20/20 after one integration fix in the GATE
  (closed-loop check → endpoint-degree circuit test; per-tile clips make
  first≈last unreadable — third instance of the per-tile-clip gate-bug class)
  + park-point registry gid line; 5 screenshots eyeballed. 28-B: procgen49
  17/17 first try; canal sha byte-identical; meander deliberately calmer
  (R_c clamp) — amplitude-saturation above windiness≈0.5 flagged for Jonah.
  One mid-run push rejection: Jonah deleted GOAL.md on GitHub (3968cfb) —
  rebased cleanly. 28-B agent stalled once on the API and was resumed from
  transcript. Fast suite now 521. Next: 23-A (constraint fields core).
- 2026-07-14 (arc run, session 6 cont.): ∥ group P1 executed as three CONCURRENT
  Opus 4.8 worktree subagents per the attended fan-out clause; integration
  strictly serial in checklist order (patch → fast+tsc+build → own live gate →
  screenshots eyeballed → commit+push): 26-A 6f9c430 (procgen49-forest 13/13;
  one screenshot-timing flake retried), 27-A cd4f52f (vo27-park 14/14 in a
  FRESH Obsidian after two degraded-process eval flakes; two REAL integration
  fixes: gate now counts distinct feature ids per per-tile-clip semantics, and
  park-canopy added to PARK_TILE_GENERATOR_IDS — uncached gids are silently
  dropped), 28-A e514ac0 (procgen49 15/15 first try; canal sha-pinned
  byte-identical). Stale FOREST_LAYER_IDS pruned post-merge (7c8771d). Two
  agents were killed mid-run by transient API stalls and resumed from
  transcript with zero rework. Fast suite now 508. Next: 27-B (∥ P2).
- 2026-07-14 (arc run, session 6 cont.): VO-W0 via Opus 4.8 phase subagent, T1
  green first try — style-JSON byte-identical 6/6 themes (gate script
  scripts/gates/vo-w0-style-bytes.ts, kept), fast 484/484, live smoke
  eyeballed. One deviation, required by byte-identity: world.ts + city.ts each
  export TWO fragments (region+route / block+street) because the original emit
  order interleaves. Committed 749c74f. Next: 26-A/27-A/28-A (∥ group P1).
- 2026-07-13/14 (arc run, session 6 cont.): 22-F FARMLAND — first spawn
  user-interrupted mid-phase (its work stayed on the tree; TaskList had no
  transcript to resume), respawned an Opus 4.8 agent to FINISH it per wake
  protocol: audited the inherited generator (fixed a strip-axis edit-locality
  bug — pinned world-X), wrote farmland unit+fuzz tests, coverage block,
  procgen48. T1 green (fast 484/484, farmland fuzz 3/3, procgen48 13/13
  standalone). PLAN-022 BOARD: first run externally killed mid-phase4 (bg-task
  cancel), resumed not re-run → combined 16/16 gates + prologue 4/4; one flake
  (procgen45, standalone 12/12 right after) logged per flake rule, board NOT
  re-run. 22-F committed 257e280; .lastgreenboard → 257e280; plans/026–028 +
  README rows committed in this state commit per Jonah's resolution. PLAN 022
  COMPLETE. Next: VO-W0 (generatedLayers split).
- 2026-07-13 (research orchestrator, follow-up): Jonah collapsed the three
  wave-2 boards into ONE at 28-C (covers 026+027+028); checklist, ∥ protocol
  note, plan files 026–028 §gates, and DECISIONS.md updated to match.
- 2026-07-13 (research orchestrator, parallel session, ~22:00): plans 026–028
  (forest/park/river visual overhauls) authored from a 4-round Opus research
  pass (reports in that session; each plan §0 carries the digest + sources)
  and slotted per Jonah: wave 1 (VO-W0 + 26-A/27-A/28-A + 27-B/28-B) after
  22-F, wave 2 (26-B/26-C + 27-C/28-C) after 23-E; ∥ protocol added; title/
  goal now say 021–028; 22-E's plan-files question RESOLVED. Tree delta from
  this session: HEARTBEAT.md + plans/026–028 (untracked) + plans/README.md
  rows — NO src/ changes; this is NOT an interrupted phase. Continue at the
  next unchecked box (22-F) as normal.
- 2026-07-13 (arc run, session 6 cont.): 22-E WALL via Opus 4.8 phase subagent,
  T1 green first try (fast 454/454, wall fuzz 2/2, procgen47 13/13 standalone,
  screenshots eyeballed, dev-vault clean); orchestrator re-verified
  fast+tsc+build. Committed b119117. NOTE: plans/026 + 027 (forest/park visual
  overhauls) appeared untracked at 21:09 from a PARALLEL research session —
  left uncommitted, flagged under §Questions; not added to this checklist
  without Jonah. Next: 22-F FARMLAND (⛳ full board).
- 2026-07-13 (arc run, session 6): resumed on dirty tree — a prior session died
  mid 22-D with park.ts/waterEmit.ts code-complete but 2 tests red. Per wake
  protocol, finished via an Opus 4.8 phase subagent: degradation-ladder
  thresholds fixed (court 200/island 130), stale registry test updated, park
  theme-coverage tests + procgen46 live gate written. T1 green (fast 427/427,
  park fuzz 3/3, tsc+build, procgen46 11/11 standalone, screenshots eyeballed,
  dev-vault clean); orchestrator re-verified fast+tsc+build independently.
  22-D committed ab320f4. Next: 22-E WALL.
- 2026-07-13 (arc run, session 5): 22-B river follow-ups (Jonah live: natural
  bends via global centerline + fillets, no spine double-paint, "Remove"
  button) committed 31e973d. Then 22-C FOREST: the phase subagent died on
  Fable 5 credit exhaustion mid-brief; user switched to Opus 4.8 and had the
  orchestrator do 22-C INLINE (advisor concurred — cold respawn re-burns dead
  credits). Cell-fill canopy (marching squares deferred to 023, logged), all
  T1 gates green (fast 402, forest fuzz 2/2, procgen45 12/12), committed
  c012975. Jonah confirmed the forest kind via the real sketch GUI mid-review.
- 2026-07-13 (arc run, session 4): resumed on dirty tree — session 3's run died
  mid "board for 22-B" (its 4.5 s fuzz FAIL was the kill; fuzz re-ran 4/4).
  22-B was code-complete; re-verified fast/fuzz/tsc/build + screenshots. Two
  full boards each went 14/15 on DISJOINT env flakes (phase0 then procgen41,
  both green standalone). **Jonah intervened live mid third board**: board
  cadence tightened to ONCE per plan (see §Execution rules + DECISIONS
  2026-07-13); third board killed, its `__p41_test__` fixture strays restored.
  22-B committed 4e6d981 under the new T1 bar. Proceeding to 22-C.
- 2026-07-13 (arc run, session 3): resumed on dirty tree — session 2 died mid
  21-C with the extraction complete and an after-board at 13/15 (procgen41/43).
  Phase subagent re-verified on the UNMODIFIED tree: both gates pass
  individually AND full board 15/15 (395.9s, 0 relaunches) — prior failures
  were environment flakiness (long-lived process), zero fix-edits. 21-C
  committed 62660d3; `.lastgreenboard` → 62660d3. Proceeding to 21-D.
- 2026-07-13 (arc run, session 2): resumed on dirty tree — prior session was
  killed mid "board before 21-C" (its fuzz FAIL at 7s was the kill itself, not
  a red; fuzz re-ran 2/2). Finished the interrupted work per wake protocol:
  full board 15/15 in 341s, 0 relaunches, dev-vault clean → committed the
  found hardening (SIGKILL timeout caps in board.ts/cli.ts, phase5 exports
  hygiene) as 9548aec. That board is 21-C's required "before" board;
  `.lastgreenboard` → 9548aec. Proceeding to 21-C.
- 2026-07-12 (arc run, session 1 cont.): 21-B green (5030d88) — board.ts one-
  process runner w/ probe attribution + hygiene assertion; renderer GL-leak
  hypothesis REFUTED by 50-cycle soak, root cause NOT reproduced, evidence in
  review/021B-renderer-degradation.md, probe-restarts shipped as mitigation.
- 2026-07-12 (arc run, session 1): resumed on dirty tree (partial phase1
  fixture fix) — finished it inside 21-A per wake protocol. 21-A green +
  committed (4adb2eb): fast tier 314 tests ~14 s, fuzz 2/72 s, phase1 16/16
  w/ dev-vault byte-clean, determinism-break injection caught by fast tier.
  Green-board ref lives in `.lastgreenboard` (currently b8e6e04 = v4.3 board).
- 2026-07-12 (later): v4.3 committed — plan 020 fully DONE; arc starts clean
  at 21-A. NOTE for 21-B/21-C: renderer degraded on the 4th gate-scale
  workload in one Obsidian process (3 ran clean) — a concrete repro anchor.
- 2026-07-12: file created; arc not started.
