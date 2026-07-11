# Plan 017 — Distinct per-kind fabric colors + cartographic polish (VISUALS)

**Priority:** P0 (user's #1 priority: "getting the visuals good") · **Effort:** M
· **Depends on:** none · **Model:** FABLE (creative/visual work)

## The correction (user's words)
> "when im in obsidian, i can't really tell the difference between roads / walls /
> river / water / district / park / etc cleanly. they don't differentiate
> themselves on the GUI well in any theme. fix this — different colors for each.
> this is the biggest thing driving the map looking ugly."

This is the top-priority, make-or-break-the-look task. The map currently reads as
muddy because multiple fabric kinds share the same color.

## Background — current state (read + LOOK before touching anything)
Sketched/generated **fabric** kinds are: `road, wall, river, water, district,
park` (`src/model/fabric.ts` `FABRIC_KINDS`). They're painted by
`fabricLayers(tokens)` in `src/map/themes/fabricLayers.ts`. Today several kinds
**reuse the same token**, which is the whole problem:
- `water` → `tokens.water`, `river` → `tokens.water` (identical to water)
- `road` → `tokens.roadMajor`
- `wall` → `tokens.labelMinor`
- `district` → `tokens.poi`
- `park` → `tokens.roadMinor` (a road color used for greenspace)

So river == water, and park borrows a road color — nothing reads as itself.

Themes and their palettes live in `src/map/themes/`: `tokens.ts` (the
`ThemeTokens` shape + the pinned per-theme token values — parchment, ink-soot,
modern-clean, neon-sprawl) and the runtime `obsidian-native` theme
(`src/map/theme.ts`, derived from live Obsidian CSS variables). There are **five
themes total**; every one must differentiate all six kinds. The same
`fabricLayers()` is used by all themes (they pass their own tokens).

`generatedLayers.ts` also paints generated city fabric (streets/districts/
footprints) — make sure your fabric palette doesn't clash with those (roads,
districts appear in both the generated and sketched layers and should feel
consistent).

## Goal
Every fabric kind is **immediately, cleanly distinguishable by color** in **all
five themes**, and the overall map looks intentional and attractive — not muddy.
Use real cartographic intuition, tuned per theme's genre:
- **water** (bodies) and **river** (lines): both bluish but clearly distinct in
  weight/shade (a river should not vanish into a lake).
- **park / greenspace**: reads as green/open in every theme (invent a per-theme
  green token — the current "no green token" shortcut is exactly what makes parks
  look wrong; add one).
- **road**: the map's primary linework — legible, theme-appropriate (Google-gold
  casing in modern-clean, cyan glow in neon-sprawl, ink in parchment, etc.).
- **wall**: reads as masonry/boundary — stony/dark, distinct from roads (it
  already dashes; give it its own color, not a label color).
- **district**: a subtle area wash that says "neighborhood" without slabbing the
  base (keep fills low-opacity; it must not overpower streets when zoomed in —
  see the existing note in `generatedLayers.ts` about the district fill turning
  the neon base into a purple slab).

Then do a light **cartographic polish** pass toward the docs/04 screenshot test
(no muddy voids, clean separation, genre identifiable in 3s) — but keep fabric
color differentiation as the must-ship core; don't gold-plate at the expense of
shipping the palette.

## How to add colors (design decision — yours to make well)
Extend `ThemeTokens` with the fabric colors each kind needs (e.g. a small fabric
palette: `park`/green, distinct `river` vs `water`, `wall`/stone, `district`
wash), and set genre-appropriate values for all five themes (including deriving
sensible ones for `obsidian-native` from Obsidian CSS variables in `theme.ts`).
Mind the quality bar's palette discipline (docs/04 F6, ~≤8 semantic colors/theme)
— reuse where it reads fine (e.g. river can be a shade of the water hue), invent
where it doesn't (park green, wall stone). Update `fabricLayers.ts` to use the new
per-kind tokens instead of the overloaded ones.

## Non-negotiable constraints (do NOT trip these — they've blanked the map twice)
- **Themes own ALL paint; generators/features never carry color.** You only touch
  theme token values + `fabricLayers.ts` paint. Do not move color into feature
  properties.
- **Never put `zoom` in a layer `filter`.** It silently invalidates the ENTIRE
  style — blank map, no console error, `npm test` still green. Per-zoom effects go
  in a top-level paint `interpolate`/`step` or the layer's numeric `minzoom`
  (never nested inside `["*", …]`, never in a filter). See the comments in
  `fabricLayers.ts` / `generatedLayers.ts` and `src/map/styleValidation.test.ts`.
- Every built style must still pass `validateStyleMin` (there's a test:
  `src/map/styleValidation.test.ts`). Run it.
- Coordinate with plan 016 (sketch UX): **you own fabric colors**, 016 owns
  render-timing/exit/undo. Touch only paint in `fabricLayers.ts`.

## Acceptance criteria
- In every one of the five themes, all six fabric kinds render in visibly distinct
  colors; river ≠ water, park reads green, wall reads stony, road reads as road,
  district is a subtle wash.
- `npm run typecheck` + `npm test` green, including `styleValidation.test.ts`
  (spec-valid styles) and any pinned-token assertions you update.
- The map looks intentional, not muddy (judged against docs/04). No new
  label/tile-seam/void regressions.
- Docs: note the new fabric tokens in `docs/06 §3` (pinned palette) + a DECISIONS
  entry; if you keep `shots/`, add before/after screenshots.

## Verification note — VISUALS NEED EYES
This is the one plan where screenshots matter most and a background agent can't
fully self-verify. Hard-gate on typecheck + test + `validateStyleMin`, push your
branch, and write a crisp "how to see it" (which campaign, draw one of each kind,
what each should look like per theme). The orchestrator will live-verify with
screenshots across themes and merge. Leave live-gate additions written-but-unrun.

## Restart-from-scratch note
Self-contained: goal is "six fabric kinds, six distinct colors, in all five
themes, and the map looks good." Re-derive from the current-state palette-overlap
list above if the branch is lost.
