# HEARTBEAT.md — overnight run: implement plans 021–025

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
`/goal implement plans 021-025 per HEARTBEAT.md — do the next unchecked box to
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
- [ ] 22-D PARK incl. japanese-garden (022 §3.3)
- [ ] 22-E WALL elaboration + raw-sketch double-wall suppression (022 §3.4)
- [ ] 22-F FARMLAND incl. outskirt-field suppression (022 §3.5) ⛳ full board

**Plan 023 — constraint fields + elevation** (`plans/023-constraint-fields-and-elevation.md`)
- [ ] 23-A `src/gen/fields/` core + BIT-EXACT interiorT/constraints retrofit
      (byte-identical city snapshot gate) (023 §2)
- [ ] 23-B elevation model + `mountain` kind + presets (heightAt untouched —
      023 §3 compatibility rule)
- [ ] 23-C contour lines (marching squares, seam gate, no new request
      surface) (023 §4.1)
- [ ] 23-D hillshade + 3D terrain (raw-lattice cache, PNG at serve; heights
      compared in gates, never PNG bytes) (023 §4.2) ⛳ full board
- [ ] 23-E paddy-terraces + river-slope coupling deferred from 022 (022 §3.1,
      §3.5)

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
- 21-D F1: plan 021 §2.4's "≥70% of live-gate assertions move headless" is NOT
  cleanly met — 34% all-in (51% of domain assertions; ~33% of live-gate checks
  are irreducible live scaffolding: plugin-load/reload/dev:errors/screenshot
  per gate). Speed goals all met. Decision taken (DECISIONS 2026-07-13): no
  retro-migration of existing gates; 022+ tests are born headless on the 21-C
  harness. Full analysis: review/021D-assertion-migration.md. OK, or do you
  want a retro-migration pass?

## Log (one line per session/kill/resume — newest first)
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
