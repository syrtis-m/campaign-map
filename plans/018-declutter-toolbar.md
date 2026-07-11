# Plan 018 — Declutter the on-map toolbar (move generate/export into settings)

**Priority:** P2 · **Effort:** S–M · **Depends on:** none · **Model:** Opus 4.8
(touches `MapView.ts` toolbar region + `main.ts`; coordinate merge with 016)

## The correction (user's words)
> "the generate export etc stuff should be in the settings menu, not main items."

## Background — current state (read before touching anything)
The on-map toolbar (top-left) is built in `src/view/MapView.ts` `buildToolbar()`
(~line 470). Current buttons, in order:
1. ➕ Add location at center
2. 🪄 Generate fabric here
3. 🔖 Canonize nearest generated feature
4. ✏️ Sketch fabric
5. 🔍 Search locations
6. 🎨 Switch map theme
7. 🖼️ Export map poster
8. 📖 Export campaign atlas (PDF)
9. ⚙️ Campaign settings → `plugin.openControlPanel()`

There's also a separate settings surface: `CampaignControlModal` (the "Campaign
settings" command; grep `openControlPanel` / `CampaignControlModal`), and all
actions also exist as command-palette commands in `src/main.ts`.

## Goal
The toolbar should hold only the **frequent, in-the-moment** builder actions; the
occasional/heavy actions (generate, canonize, both exports, and similar) move
into the **settings menu** (the control panel modal / a menu), so the map surface
is clean and fast to read.

## Approach (recommended)
- **Keep on the toolbar** the high-frequency actions a GM reaches for constantly:
  Add location, Sketch fabric, Search, and the settings entry point. (Theme
  switch is borderline — your call; leaning keep, it's quick and visual.)
- **Move into settings** (the `CampaignControlModal` / control panel — add a
  clearly-labeled section, e.g. "Generate & export"): Generate fabric here,
  Canonize nearest, Export poster, Export atlas. Anything that's a batch/heavy or
  once-in-a-while action belongs here.
  - Note: "Generate fabric here" and "Canonize nearest" are **location-dependent**
    (they act at the map center / nearest feature). When invoked from a modal,
    make sure they still operate on the current map viewport/center (they read
    `map.getCenter()` / zoom today) — the modal just triggers the same method;
    don't break the "here" semantics. If acting-at-center from a modal is
    confusing, keep a minimal affordance or a right-click map-menu entry instead —
    but the toolbar should no longer carry them as top-level buttons.
- Keep all command-palette commands in `main.ts` working (don't remove commands;
  this is about the toolbar surface, not removing functionality).
- Preserve discoverability: the settings button/tooltip should make clear that
  generate/export live inside.

## Non-negotiable constraints
- Don't regress any existing functionality — every action still reachable (via
  settings and/or command palette).
- `MapView.ts` is also edited by plan 016 (sketch UX). You touch the **toolbar
  builder** region (~470–495) + `main.ts` + the control-panel modal; 016 touches
  the **sketch-mode** region (~1290–1400). Keep your diff to the toolbar/settings
  surface so the two merge cleanly.
- CLAUDE.md invariants unchanged.

## Acceptance criteria
- Toolbar shows only the frequent actions; generate/canonize/poster/atlas live in
  the settings/control panel (or an equivalent non-top-level surface).
- Every moved action still works from its new home and from the command palette.
- The "generate/canonize here" actions still act on the current viewport.
- `npm run typecheck` + `npm test` green.
- Docs: update the README toolbar table (`README.md`) to match the new layout.

## Verification note
Hard-gate on typecheck + test; push your branch. Describe the new toolbar + where
each moved action now lives. The orchestrator live-verifies (open map, confirm
toolbar contents, trigger a moved action from settings) and merges. Leave
live-gate additions written-but-unrun.

## Restart-from-scratch note
Self-contained: goal is "toolbar = frequent actions only; generate/export/etc.
live in settings; nothing removed, everything still reachable." Re-derive from the
button list above if the branch is lost.
