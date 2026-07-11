# Plan 016 — Sketch mode UX: reliable exit, live feedback, undo, instant result

**Priority:** P1 · **Effort:** M · **Depends on:** none · **Model:** Opus 4.8
(coordinate with plan 017, which recolors fabric — see "Interplay" below)

## The corrections (user's words)
> "when i use the GUI and click into the sketch fabric mode, i can't click out of
> that mode."
>
> "when im in sketch fabric mode, i can't tell that things have happened until i
> click generate. i also don't have an Undo function — maybe instant generation?"

## Background — current state (read before touching anything)
Sketch mode lets the GM hand-draw city fabric (road/wall/river/water/district/
park) that is either rendered literally or fed to the procedural generator. All
in `src/view/MapView.ts`:
- `toggleSketchMode()` (~line 1290): enters/exits; builds a `SketchController`
  (`src/view/sketch/` — grep) and a sub-bar (`buildSketchBar`, ~1325) with kind
  buttons, a `feed: on/off` toggle, a `build` button, a hint line, and an
  `✕ done` button. Exit paths today: the `✕ done` button, and `Escape` (only when
  NOT mid-draw). Pencil toolbar button also calls `toggleSketchMode`.
- Drawing grammar: click = vertex, dbl-click/Enter = finish, Esc = cancel draft,
  Del = delete selected. `sketchKeydown` (~1380).
- Sketched features persist to one file `Fabric.geojson` per campaign
  (`src/vault/fabricStore.ts`); rendered by `fabricLayers()`
  (`src/map/themes/fabricLayers.ts`). `generateFromSketch()` elaborates
  generate-mode road corridors into street networks (plan 014).
- Sketch add/remove already append to the mutation log
  (`src/model/mutationLog.ts` has `sketch-add`/`sketch-remove`).

## The three problems to fix
1. **Can't exit reliably.** The user clicked into sketch mode and couldn't get
   out. Diagnose why (candidates: the pencil toolbar button doesn't visibly
   toggle/highlight so re-clicking isn't discoverable; `✕ done` is easy to miss;
   Escape is swallowed while a draft is active; focus/keyboard handler edge
   cases). Fix so exit is obvious and always works:
   - The pencil toolbar button should show an active/pressed state while sketch
     mode is on, and re-clicking it exits (verify it actually does).
   - `Escape` should reliably leave sketch mode (cancel an in-progress draft on
     the first press, exit mode on the next — or make exit always reachable).
   - Keep the `✕ done` button but make it unmistakable.
2. **No feedback until "generate".** Drawn/committed fabric should render
   **immediately** as themed fabric (its own kind's line/fill), so the GM sees
   the road/wall/river the moment they finish a stroke — not only after pressing
   build. Also give lightweight in-progress feedback while drawing (the
   `SketchController` likely already draws a rubber-band; make sure committed
   features paint right away via a `fabric` source `setData`). Consider a small
   toast/notice on commit ("road added"). For **generate-mode** strokes, offer
   near-instant elaboration: either auto-run generation on commit (debounced) or
   make the result visibly appear without a separate trip to `build` — the user
   floated "maybe instant generation." Keep an explicit control too, but the
   default should feel immediate.
3. **No undo.** Add an undo within sketch mode (Cmd/Ctrl-Z and/or a toolbar
   button) that removes the last committed sketched feature, using the existing
   `sketch-add`/`sketch-remove` mutation-log entries and `fabricStore`
   remove path. Redo is a nice-to-have, not required.

## Interplay with plan 017 (fabric recolor)
017 gives each fabric kind a distinct color across all themes. This plan makes
committed strokes render immediately; 017 makes them look distinct. They compose
and shouldn't fight, but you BOTH may touch `fabricLayers.ts`. To minimize
conflict: **do not change fabric paint/colors in this plan** — only the
render-timing, mode-exit, feedback, and undo behavior. Leave all per-kind color
work to 017. If you need a preview layer, keep it paint-minimal and let 017 own
the palette.

## Non-negotiable constraints
- **Never put `zoom` in a layer `filter`** (silently blanks the whole style; see
  `canonLayers.ts` / `fabricLayers.ts` comments + `styleValidation.test.ts`).
- A theme switch (`setStyle`) wipes every source; anything you render must be
  re-applied on `styledata` like the existing `refreshFabric()` does.
- Vault-APIs-only, determinism, canon=notes (CLAUDE.md).

## Acceptance criteria
- From a cold open: click pencil → draw a couple of features → exit via each of
  (pencil re-click, Escape, ✕ done). All three exit cleanly; the pencil shows an
  active state while on.
- A committed stroke renders as themed fabric immediately (no need to press
  build). Generate-mode strokes produce their elaborated result without a
  hidden manual step (or with an obvious, immediate one).
- Undo removes the last committed sketched feature and updates both the map and
  `Fabric.geojson`.
- `npm run typecheck` + `npm test` green (unit-test the undo/remove path and any
  new pure logic; the mutation-log round-trip).

## Verification note
Live sketch interaction is hard for a background agent to verify; hard-gate on
typecheck + test, push your branch, and describe exactly what to click to verify.
The orchestrator will drive it live (draw → see it → undo → exit three ways) and
merge. Leave live-gate additions written-but-unrun.

## Restart-from-scratch note
Self-contained: goal is "sketch mode is exitable three ways, shows committed
fabric immediately, supports undo, and elaborates generate-mode strokes without a
hidden step." Re-derive from the current-state map above if the branch is lost.
