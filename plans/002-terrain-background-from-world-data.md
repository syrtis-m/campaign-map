# Plan 002: Paint the fictional-world background from generated biome/height data

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan in
> `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 3783bf9..HEAD -- src/map/themes/generatedLayers.ts src/gen/world/regions.ts`
> If either file changed since this plan was written, compare the "Current
> state" excerpts below against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW-MED (render-only; risk is purely aesthetic + keeping existing
  gates green)
- **Depends on**: none
- **Category**: direction / tech-debt (unused data model)
- **Planned at**: commit `3783bf9`, 2026-07-09

## Why this matters

A generated fictional world currently renders as a **flat themed rectangle**
with a few faint region tints, settlement dots, and dashed routes. The world
generator already computes a full terrain model — per-region `biome` (ocean,
coast, plains, forest, hills, mountains, desert, tundra), `height`, and
`moisture` — and **attaches all of it to every `world-region` feature's
properties** (`src/gen/world/regions.ts:25`). But the render layer throws it all
away: `generated-region` paints every region the same flat `t.water` color at
6% opacity (`src/map/themes/generatedLayers.ts:22-24`), so oceans, mountains,
and plains are indistinguishable and the "background" reflects nothing about the
world.

This is the "blank void" the quality bar (docs/04) explicitly warns against, and
it's the core of the "the background isn't generated from map data" pain point.
Because the data is **already on the features**, painting it is a **pure
render-layer change** — no generator edits, and therefore no new 2×2 seam
snapshot tests (CLAUDE.md's seam mandate applies to `src/gen/` changes; this
plan touches none). The single highest-leverage change, and the whole of this
plan: paint ocean/coast regions as water and land regions as land so the world
has actual seas and coastlines (a Voronoi-cell coastline, blocky but
recognizable — the difference between "flat rectangle" and "a world with land
and sea"). This uses **only** the `t.water` / `t.land` tokens, so it is
theme-safe in all five themes by construction.

**Explicitly deferred (do NOT build here): height-driven relief / hillshade.**
It sounds like an obvious add, but a single overlay color cannot express
"elevated" across these themes: a *dark* overlay reads as relief on the light
themes (modern-clean, parchment) but on the dark themes (ink-soot land
`#22211f`, neon-sprawl `#0d0d11`, obsidian-native) it's invisible, and a *light*
overlay inverts the meaning. Correct relief needs a per-theme `reliefColor`
token, which spends the ≤8-color budget and touches all five themes — a separate
plan. Do not approximate it with an existing token; their luminance flips
between themes.

## Current state

- `src/gen/world/regions.ts:10-35` — `generateWorldRegions(...)`. Each region
  feature already carries the terrain model (do not change this file):
  ```ts
  properties: { generated: true, generatorId: "world-region", type: "nation/region", biome, height: h, moisture: m },
  ```
  `biome` is one of `"ocean" | "coast" | "plains" | "forest" | "hills" |
  "mountains" | "desert" | "tundra"` (`src/gen/world/biomes.ts:1`). `height` and
  `moisture` are numbers roughly in `[0,1]` (value-noise output).
- `src/map/themes/generatedLayers.ts:14` — `generatedLayers(t: ThemeTokens)`
  returns the layer list. The current region layer (lines 18-24):
  ```ts
  {
    id: "generated-region",
    type: "fill",
    source: "generated",
    filter: ["==", ["get", "generatorId"], "world-region"],
    paint: { "fill-color": t.water, "fill-opacity": 0.06 },
  } as unknown as LayerSpecification,
  ```
  This is the only line that needs to change — from a flat fill to a biome
  `match`. No new layers.
- `src/map/themes/tokens.ts:5-18` — `ThemeTokens` provides `land` and `water`
  (among others). The four handcrafted themes set these explicitly;
  `obsidian-native` derives `land` from `--background-primary` and `water` from
  `--background-secondary` (`src/map/theme.ts:42-60`). **Both paths call
  `generatedLayers(t)` with a `ThemeTokens`** (`src/map/themes/index.ts:38` and
  `src/map/theme.ts:82`), so a fill keyed on `t.land` / `t.water` works for all
  five themes with zero per-theme edits. (Note: do **not** reach for
  `t.labelMajor` or any other token for a "darkening" effect — its luminance
  flips between light and dark themes; that's the whole reason relief is
  deferred.)
- The theme's base `background` layer already paints the whole canvas in the
  theme's land color, so painting land regions as `t.land` is intentionally
  redundant — the point is that **ocean** regions override to `t.water`,
  producing visible land/sea coastlines out of the region tessellation.

**Repo conventions to match:**
- Layers in this file are object literals cast `as unknown as LayerSpecification`
  (MapLibre's TS types are stricter than the runtime accepts for data-driven
  expressions). Match that exact cast style.
- Data-driven paint uses MapLibre expression arrays: `["get","biome"]`,
  `["match", input, label, value, ..., fallback]`,
  `["interpolate", ["linear"], ["get","height"], stop, val, ...]`.
- `t.*` tokens are the only color source — never hardcode hex in a layer
  (CLAUDE.md: "themes own ALL paint; generators emit typed features only, never
  styles").

## Commands you will need

| Purpose    | Command                              | Expected on success |
|------------|--------------------------------------|---------------------|
| Typecheck  | `npm run typecheck`                  | exit 0              |
| Unit tests | `npm test`                           | all pass            |
| World gate | `npx tsx scripts/gates/phase3.ts`    | all pass (11/11) — asserts world fabric generates + renders |
| LOD gate   | `npx tsx scripts/gates/phase4.ts`    | all pass (11/11) — asserts world-tier dispatch renders + provenance |

> The gates drive a live Obsidian via the official CLI. If that isn't available
> here, typecheck + unit tests must still pass; see STOP conditions.

## Scope

**In scope** (the only file you should modify for the feature):
- `src/map/themes/generatedLayers.ts` — **only** the `generated-region` layer's
  `paint`. Add no new layers.

Optionally, if you add a screenshot/assertion check:
- `scripts/gates/phase3.ts` — *add* a check that biome fills exist; do not
  weaken existing checks.

**Out of scope** (do NOT touch):
- `src/gen/world/**` — the generators. The data is already correct and on the
  features; changing generators would trigger the mandatory seam-test regime and
  is unnecessary. If you find yourself wanting to edit a generator, STOP.
- `src/map/themes/tokens.ts` and the theme definitions — v1 uses existing
  tokens only. Adding new per-biome tokens is a documented follow-up, not this
  plan (it would mean editing all five themes and spending the ≤8-color budget;
  out of scope here).
- `canonLayers.ts`, `basemapLayers.ts` — real-city basemaps and canon points are
  unaffected.

## Git workflow

- Branch: `advisor/002-terrain-background`
- Commit message style (conventional, per `git log`): e.g.
  `feat: paint generated world background from biome + height data`.
- Do NOT push or open a PR unless the operator instructs it.

## Steps

### Step 1: Make the region fill biome-aware (ocean vs. land)

Replace the `generated-region` layer's flat paint with a `match` on `biome`.
Ocean → `t.water`; every land biome → `t.land`; both at high opacity so the
land/sea boundary reads as a real coastline instead of a faint wash:

```ts
{
  id: "generated-region",
  type: "fill",
  source: "generated",
  filter: ["==", ["get", "generatorId"], "world-region"],
  paint: {
    "fill-color": [
      "match",
      ["get", "biome"],
      "ocean", t.water,
      "coast", t.water,
      // all land biomes fall through to land — ocean vs. land is the whole
      // win here (it produces the coastline); per-biome hues are a follow-up.
      t.land,
    ],
    "fill-opacity": 0.9,
  },
} as unknown as LayerSpecification,
```

`"coast"` is grouped with ocean deliberately (it's the wet edge). If you prefer
coast as land, that's an acceptable judgment call — but keep ocean as `t.water`.

**Verify**: `npm run typecheck` → exit 0; `npm test` → all pass.

### Step 2: Confirm layer order and provenance

The returned array order is the draw order (earlier = lower). `generated-region`
stays where it already is — first in the list, below the existing
`generated-district`, `generated-footprint`, `generated-route`,
`generated-street`, and the point/label layers (points must stay on top). You
are only changing the `generated-region` layer's `paint`; do **not** add,
remove, or reorder any other layer.

Provenance rule (quality-bar F2): these are *world-region* fills only. Canon
locations are points on the `canon` source and are unaffected — a GM still can't
tell canon from generated points apart. Good.

**Verify**: `npm run typecheck` → exit 0.

### Step 3: (Optional but recommended) add a gate assertion + screenshot

In `scripts/gates/phase3.ts`, after the existing world-generation check that
populates `world-region` features, add a check that the biome-aware fill is
live. Follow the file's existing `evalJs` idiom. Assert:

```js
var map = app.plugins.plugins['campaign-map'].map;
JSON.stringify({
  hasRegion: !!map.getLayer('generated-region'),
  // paint is now an expression (array), not a flat string, proving it's data-driven
  fillIsExpression: Array.isArray(map.getPaintProperty('generated-region', 'fill-color')),
});
```

Assert both are true. If `phase3.ts` already takes a screenshot at the end,
that screenshot now shows the terrain — no extra screenshot code needed; just
confirm it looks like land+sea, not a flat rectangle, when you view it.

**Verify**: `npx tsx scripts/gates/phase3.ts` → all pass including the new check.

### Step 4: Re-run the LOD gate for regressions

The world-tier dispatcher (Phase 4) renders these same `world-region` features
on a bare pan. Confirm nothing broke:

**Verify**: `npx tsx scripts/gates/phase4.ts` → all pass (11/11). No layers were
added or removed (only `generated-region`'s paint changed), so a clean pass is
expected; if it fails, the biome fill is interacting with an assertion that
inspects region paint — report it (see STOP conditions), don't paper over it.

## Test plan

- **Unit**: none required — this is declarative style config with no new pure
  logic. The generator's biome/height output is already unit-tested
  (`src/gen/world/world.test.ts`). Existing `npm test` must stay green.
- **App gates**: `phase3.ts` (with the Step 3 check) is the regression test —
  it proves the region fill is biome-aware and data-driven. `phase4.ts` proves
  the world-tier dispatch still renders after the paint change.
- **Visual check (if a human/agent can view the app)**: generate a world
  (`command id=campaign-map:generate-world-here` on a fictional campaign, e.g.
  Ashfall or Nightreach), zoom out to world scale, and confirm you can see
  distinct seas and land masses with coastlines — not a flat colored box. Switch
  themes (parchment ↔ ink-soot ↔ obsidian-native) and confirm each still reads
  correctly (on the dark themes, ocean should be visibly different from land).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0 (existing suite unchanged, still green)
- [ ] `grep -n '"fill-opacity": 0.06' src/map/themes/generatedLayers.ts` returns
      **no matches** (the flat faint region fill is gone)
- [ ] `grep -n '"match"' src/map/themes/generatedLayers.ts` returns a match
      inside the `generated-region` layer (the fill is now biome-driven)
- [ ] `grep -n 'generated-relief' src/map/themes/generatedLayers.ts` returns
      **no matches** (relief is deferred, not built here)
- [ ] `npx tsx scripts/gates/phase3.ts` passes (incl. the Step 3 check, if
      added), and `npx tsx scripts/gates/phase4.ts` passes — or, if the app/CLI
      is unavailable, that is a STOP condition, not something to skip silently
- [ ] No file outside the in-scope list is modified (`git status`) — in
      particular `src/gen/**` is untouched
- [ ] `plans/README.md` status row for 002 updated

## STOP conditions

Stop and report back (do not improvise) if:

- `world-region` features no longer carry `biome` / `height` in their
  properties (the excerpt at `regions.ts:25` drifted) — the whole plan assumes
  this data is present.
- Making this work appears to require editing anything under `src/gen/**` — it
  should not; the data is already on the features.
- A phase-3 or phase-4 assertion fails because it inspects the
  `generated-region` layer's paint expecting the old flat `t.water` string —
  report the exact assertion so the maintainer can update the gate expectation
  to the biome `match` (this is a legitimate gate/feature interaction, not a bug
  to hide).
- The app gates cannot run because the dev-vault Obsidian / official CLI is
  unavailable. Report that typecheck + unit tests pass and the render change is
  written but the live gates are unrun; hand back for a human to run them.
- A verification fails twice after a reasonable fix attempt.

## Maintenance notes

- **Deferred follow-ups (intentionally not in this plan, each a separate plan):**
  (1) **height relief / hillshade** — requires a per-theme `reliefColor` token
  because a single overlay color's luminance flips between the light and dark
  themes (see "Why this matters"); (2) **per-biome hues** (forest green, desert
  tan, tundra pale) via an optional `biomeColors` token on `ThemeTokens` —
  touches all five themes and spends the ≤8-color budget; (3) a **true dissolved
  coastline** stroke — the current land/sea fill contrast reads as a coast, but
  a crisp shoreline needs polygon dissolution (drawing region ring outlines
  would show ugly internal cell borders).
- A reviewer should confirm ocean reads as clearly distinct from land in every
  theme — especially the dark ones (ink-soot land `#22211f` vs. water `#14181c`
  is a *subtle* difference; if it's too subtle to read as coastline, that's a
  signal the follow-up per-biome/relief work is needed, not a defect in this
  plan).
- If a future plan adds new biomes to `biomes.ts`, extend the `match` in Step 1
  (new biomes fall through to `t.land` by default, which is a safe fallback, but
  ocean-like biomes must be added to the ocean/coast arm explicitly).
