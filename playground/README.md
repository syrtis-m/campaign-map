# Procgen playground

`npm run playground` → http://localhost:8734 — a standalone browser harness that
imports `src/gen` **directly** (esbuild serve, zero Obsidian, zero build-to-vault).
The first stop for any generator work: tuning goes from minutes to milliseconds.

## Controls

- **Algorithm** — every registry algorithm (derived from the fabric-kind bindings).
- **Seed** — type, step (◀ ▶), or randomize; regenerates on change.
- **Region / spine shape** — circle, square, blob, concave-L rings for polygon
  algorithms; straight / gentle-S / zigzag spines (with the algorithm's own
  `corridorMaxOffset`) for line algorithms. Judge containment and concave behavior.
- **Params** — live knobs auto-derived from each algorithm's zod schema (enums →
  dropdowns, numbers → sliders with schema min/max, optionals get a checkbox). A new
  param appears with zero playground changes.
- **Render preset grid** — every preset side-by-side at the current seed on mini
  canvases; click one to apply it. The fastest way to check a new preset reads
  distinctly.
- Wheel = zoom around cursor, drag = pan. The status bar shows run time + feature
  count + any generator error.

## What the paint is (and is not)

The canvas renders each algorithm's **style contract** (`src/gen/procgen/
styleContract.ts`) — the same gid → mark/role/z manifest the real themes consume —
with a flat default role→color map, plus a hash-hue fallback for unknown gids. So
composition, z-order, and bucket coverage are faithful; **theme paint is not** (no
theme truth here — final paint judgment needs an in-app screenshot; per-theme values
live in `src/map/themes/roleColors.ts` and are byte-pinned by `styleGolden.test.ts`).

## What it can't do

No host code runs here: no cache, no worker, no lifecycle, no undo, no adoption.
It never substitutes for a live smoke gate. Generator work order: **playground
(tune + judge) → unit/fuzz (T0/T1) → the Obsidian loop for the host-integration
slice** (docs/05).
