# Plan 006: Per-type location icons (SPIKE + first-theme prototype)

> **Executor instructions**: This is a **spike/prototype plan**, not a
> ship-everything plan. Its deliverable is a working prototype for ONE theme plus
> a short decision writeup, so the maintainer can choose the icon pipeline before
> it's rolled across all five themes. Honor STOP conditions; update the row in
> `plans/README.md` when done.
>
> **Drift check**: `git diff --stat 3783bf9..HEAD -- src/map/themes/canonLayers.ts src/view/MapView.ts`
> (plans 001/003/004/005 also touch `MapView.ts`; locate by symbol name.)

## Status

- **Priority**: P2
- **Effort**: M (spike)
- **Risk**: MED (touches the shared canon render recipe + per-theme style rebuild
  lifecycle; that's exactly why it's a spike first, not a blind rollout)
- **Depends on**: none, but **merge after 001/003/004/005** if they're in flight
  (shared `MapView.ts`).
- **Category**: direction (craft) — addresses the "dots are indistinct / too
  small" pain point and the doc'd "hover targets ≥24px" bar (docs/02 §3b).
- **Planned at**: commit `3783bf9`, 2026-07-09

## Why this matters

Every canon and generated location renders as the **same bare circle**, sized
only by importance (`src/map/themes/canonLayers.ts:33-44`). A tavern, a city, a
lake, and a mountain are visually identical — the map can't be read at a glance,
and small circles are hard to hit (see plan 001). The type taxonomy already
exists (`src/model/locationNote.ts:14-27`) and each feature already carries its
`type` — so the data for per-type icons is present; only the render is missing.

But *how* to draw icons is a real, load-bearing decision (external SVG sprite
sheet vs. runtime-generated canvas images via `map.addImage` vs. the existing
seeded sigil generator in `src/gen/sigil/`), each with different offline,
determinism, theming, and asset-pipeline consequences. Guessing wrong means
redoing it across five themes. **This spike builds one working approach for the
`obsidian-native` theme, then documents the tradeoffs so the rollout plan is
informed.** It also standardizes the clickable/hover target to ≥24px.

## Current state

- `src/map/themes/canonLayers.ts` — `canonLayers({pointColor, ...})` returns
  `canon-point-far` (circle), `canon-point` (circle, radius by importance),
  `canon-label` (symbol). Shared by all themes.
- `src/map/themes/generatedLayers.ts` — mirror layers for the `generated` source
  (settlements). Provenance must stay invisible (F2) — whatever canon points get,
  generated settlement points must get identically.
- `src/model/locationNote.ts:14-27` — `TYPE_TAXONOMY` keys:
  `nation/region, city, town, village, route, water-feature, district,
  street(named), landmark, shop/tavern/venue, residence/minor, custom`. Group
  these into a small set of **icon categories** (e.g. settlement, water, region,
  landmark, venue, route, generic) — a `type → category` map is the right
  granularity (12 types → ~6 icons), not one icon per type.
- Style rebuild lifecycle: `MapView.setState`/`setCampaign`/`rebuildTheme` call
  `map.setStyle(...)` then `map.once("styledata", ...)`. Any runtime-registered
  images (`map.addImage`) are **wiped by `setStyle`** and must be re-registered
  on every `styledata` — this is the main lifecycle hazard the spike must prove
  out.
- `src/gen/sigil/sigil.ts` — an existing seeded SVG sigil generator (snapshot
  tested). A candidate icon source worth evaluating in the writeup.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Unit tests | `npm test` | all pass |

## Scope

**In scope:**
- `src/map/icons.ts` (create) — the prototype icon module: a `type→category` map
  and a `registerTypeIcons(map, tokens)` that draws a small set of category icons
  to an offscreen canvas and `map.addImage`s them.
- `src/map/themes/canonLayers.ts` — add a symbol variant of `canon-point` using
  `icon-image` keyed by category (behind the prototype; keep the circle as
  fallback for categories without an icon and for `canon-point-far`).
- `src/view/MapView.ts` — call `registerTypeIcons` on `styledata` (and initial
  load) so icons survive theme switches.
- `plans/006-NOTES.md` (create) — the decision writeup (see Step 4).

**Out of scope:** rolling icons across all four handcrafted themes (that's the
follow-up rollout plan the writeup informs); `generatedLayers.ts` parity (do it
in the rollout once the approach is chosen — but NOTE the parity requirement in
the writeup); external sprite-sheet asset fetching.

## Git workflow

- Branch: `advisor/006-per-type-icons-spike`. Conventional commits ending with
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Push; no merge.

## Steps

### Step 1: Category map + runtime icon generation

Create `src/map/icons.ts`:
- `TYPE_ICON_CATEGORY: Record<string, string>` mapping each taxonomy type to one
  of ~6 categories.
- `registerTypeIcons(map, opts: { fill: string; stroke: string })`: for each
  category, draw a **24×24 (× devicePixelRatio)** icon on an
  `OffscreenCanvas`/`document.createElement("canvas")` using canvas primitives
  (e.g. settlement = filled rounded square; water = droplet; region = hex;
  landmark = star; venue = filled circle w/ dot; route = diamond), colored from
  `opts.fill`/`opts.stroke`. Convert to `ImageData` and
  `map.addImage(`type-${category}`, imageData, { pixelRatio: devicePixelRatio })`
  with an existence guard (`if (!map.hasImage(name)) map.addImage(...)`).

Keep the drawing code small and dependency-free (no external icon libs — offline
bar). Determinism: pure function of category + tokens, no randomness.

**Verify**: `npm run typecheck` → exit 0.

### Step 2: Symbol layer in canonLayers (obsidian-native path)

Add a `canon-point-icon` symbol layer to `canonLayers` output that uses
`icon-image: ["concat", "type-", ["match", ["get","type"], ...category expr...]]`
(or a precomputed `iconCategory` property — simpler: compute category in
`locationToFeature` and read `["get","iconCategory"]`). Set `icon-size` by
importance, `icon-allow-overlap: true` for the highest-importance tiers, and
`icon-anchor: "center"`. Keep `canon-point` circle as the fallback under it (or
switch the circle to only render for `custom`/uncategorized) so nothing
regresses if an icon is missing. Ensure the **effective tap target is ≥24px**
(icon size + plan 001's click tolerance).

Only wire this for the `obsidian-native` theme in this spike (the handcrafted
themes keep circles for now) — that's what makes it a scoped prototype.

**Verify**: `npm run typecheck` → exit 0; `npm test` → all pass (add a unit test
for the `type→category` map if you compute category in the model).

### Step 3: Register icons across the style-rebuild lifecycle

In `MapView`, call `registerTypeIcons(this.map, {...tokens})` inside the
`styledata` callbacks after `setStyle` (in `setCampaign`, `rebuildTheme`) and in
the initial `map.on("load")`. Confirm (by reasoning + a typecheck-clean build)
that switching themes and back re-registers icons rather than losing them.

**Verify**: `npm run typecheck` → exit 0.

### Step 4: Decision writeup (the real deliverable)

Write `plans/006-NOTES.md` covering: which approach you prototyped and why; how
it behaves across `setStyle`/theme-switch (the addImage lifecycle); offline &
determinism properties; whether the seeded **sigil generator** (`src/gen/sigil`)
is a better long-term source than hand-drawn canvas glyphs; the **generated-layer
parity** work the rollout must include (F2); and a concrete recommendation for
the rollout plan (all themes + generated settlements + per-type sizing). Include
2–3 open questions for the maintainer.

**Verify**: file exists and is complete.

## Test plan

- **Unit**: the `type→category` map (pure) if computed in the model.
- **Manual/visual (if drivable)**: open Ashfall on `obsidian-native`; confirm
  different types show different glyphs, targets feel clickable, and a
  theme-switch round-trip keeps icons.
- This being a spike, the primary "test" is the writeup + a typecheck-clean,
  unit-green prototype — not a full gate.

## Done criteria

- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0 (+ any new pure-map test)
- [ ] `src/map/icons.ts` exists with `registerTypeIcons` + category map
- [ ] `canonLayers.ts` has an `icon-image`-based symbol layer for obsidian-native
- [ ] `plans/006-NOTES.md` exists with the approach comparison + rollout recommendation
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row for 006 updated

## STOP conditions

- `map.addImage` with runtime `ImageData` doesn't survive the style lifecycle in
  a way you can make robust in ≤2 attempts — STOP, write up the failure in
  `006-NOTES.md`, and recommend the sprite-sheet or sigil alternative instead of
  forcing it.
- The symbol layer collides badly with existing `canon-label` (double glyphs, F1
  collision-count regressions) — document it and recommend the label/icon offset
  fix for the rollout.
- Making it work requires editing all five themes — that's the rollout, not the
  spike; STOP at obsidian-native.

## Maintenance notes

- The follow-up rollout plan (write it after this spike) must: apply the chosen
  approach to all four handcrafted themes, mirror it on `generatedLayers.ts`
  (provenance parity F2), and add per-type `icon-size`/importance tuning.
- Reviewer: watch the `addImage` re-registration on `css-change`/theme switch —
  that's the fragile seam.
