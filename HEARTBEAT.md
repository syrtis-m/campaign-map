# HEARTBEAT.md — overnight run: implement plans 021–025

**Suggested goal command:**
`/goal implement plans 021-025 per HEARTBEAT.md — resume from its checklist on every start, use opus subagents per phase, stop when all boxes are checked`

This file is the **single durable source of truth for run state**. Usage
limits WILL kill sessions mid-run (it happened twice on 2026-07-12); the run
must survive any kill with at most one phase of rework. Everything below
exists to make that true.

## Wake protocol (do this at EVERY session start / resume, before any work)

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
5. Continue at the first unchecked box, in order.

## Execution rules (non-negotiable)

- **Read first, once per session:** CLAUDE.md; the CURRENT plan file in full
  (its §0 carries the invariants + infra pitfalls); docs/06 (gate protocol).
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
- **Tier discipline** (from plan 021 §2.6, once 21-A lands): inner loop = fast
  suite; full board ONLY at arc milestones marked ⛳ below — not per phase.
  Until 21-A lands, phases 21-A/21-B use today's protocol.
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
- [ ] 21-C MapController extraction + FakeHost harness, ZERO behavior change,
      full board green before AND after (021 §2.4) ⛳ full board
- [ ] 21-D plan-021 acceptance gate: injected determinism break caught;
      assertion-migration map written (021 §4)

**Plan 022 — algorithm suite** (`plans/022-procgen-suite-rivers-forests-parks-walls.md`)
- [ ] 22-A preset pattern + city-profiles retrofit + additive-params rule
      (022 §1)
- [ ] 22-B spine support + RIVER (windiness/braiding, position-keyed per-
      segment meander, corridor containment) (022 §2, §3.1)
- [ ] 22-C FOREST (new kind, masked-noise canopy w/ interiorT fallback,
      theme paint in ALL themes) (022 §3.2)
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
(none yet)

## Log (one line per session/kill/resume — newest first)
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
