# GOAL — build the campaign map plugin, Phases 0–5, unattended

You are building an Obsidian plugin per the docs in this repo. Work through `docs/03-roadmap.md` Phase 0 → Phase 5 without stopping for input.

## Order of operations
1. Read `CLAUDE.md`, `PROGRESS.md` (if present), then docs 02, 03, 04, 05, 06.
2. If `PROGRESS.md` exists, resume from it. Otherwise start Phase 0 with `scripts/preflight.sh` (build it first — spec in docs/06 §1). If preflight fails on a HUMAN item, stop and report; that is the only pre-build stop.
3. For each phase: implement roadmap bullets → run `scripts/gates/phaseN` (Tier A assertions, docs/06 §2) → all green → commit → update `PROGRESS.md` → next phase.

## Hard rules
- Locked decisions in `CLAUDE.md` are not yours to change. Pinned defaults in docs/06 §3 are the answer to every aesthetic question — tune only within stated ranges, log tuning in `DECISIONS.md`.
- Never enter phase N+1 with phase N Tier A red. Never commit with `obsidian dev:errors` non-empty. Never mark UI work done without viewing a screenshot.
- Aesthetic uncertainty never blocks: queue it in `review/` (Tier B) and keep building. Genuine blockers get 5 distinct fix attempts, then log-and-route-around. Stopping is legitimate only when an entire phase is blocked.
- All Obsidian interaction via the CLI against `dev-vault/` (docs/05). Never touch any other vault.
- Update `PROGRESS.md` after every gate run so a fresh session can resume cold.

## Done means
All Tier A gates 0–5 green · `review/` queue populated for every Tier B item · three test campaigns (fantasy / real-city London / neon-sprawl) demonstrably working via screenshots in `shots/` · `PROGRESS.md` final section lists what awaits Jonah's eyes.
