# Plan 006 — Per-type location icons: decision writeup

Spike branch: `advisor/006-per-type-icons-spike`. Prototype scope: `obsidian-native`
theme only, canon locations only (generated-settlement parity is explicitly
deferred — see "Generated-layer parity" below).

## What was built

- `src/map/icons.ts` — a `type -> category` lookup (`TYPE_ICON_CATEGORY`,
  `iconCategoryFor`) collapsing the 12-entry `TYPE_TAXONOMY`
  (`src/model/locationNote.ts`) into 6 icon categories (`settlement`, `water`,
  `region`, `landmark`, `venue`, `route`) plus a `generic` fallback; a MapLibre
  `match`-expression form of the same lookup (`iconCategoryExpression`) for use
  directly in style JSON; and `registerTypeIcons(map, {fill, stroke})`, which
  draws each category's glyph on an offscreen `<canvas>` (rounded square,
  droplet, hexagon, star, dot-in-circle, diamond, plain circle) and
  `map.addImage`s it as `type-${category}`, guarded by `map.hasImage`.
- `src/map/themes/canonLayers.ts` — a new opt-in `canon-point-icon` symbol
  layer, added only when `canonLayers({icons: true})`. It sits *above*
  `canon-point` (the existing circle) rather than replacing it, so a missing
  icon image degrades to "just the circle, like before" rather than a blank
  spot. `icon-image` reads `["concat", "type-", iconCategoryExpression()]`;
  `icon-size` scales 1.0→0.6 by importance (base canvas is 24px, so
  importance-1 features render at a full 24px glyph); `icon-allow-overlap` is
  `true` for importance ≤ 2 (nations/regions/cities never collide-hide).
- `src/map/theme.ts` — `obsidianNativeStyle` now passes `icons: true` to
  `canonLayers`. **This file was not in the plan's listed in-scope set**, but
  wiring `icons: true` somewhere is unavoidable to scope the feature to
  obsidian-native without touching the four handcrafted themes
  (`src/map/themes/index.ts`'s `buildThemeStyle`, which still calls
  `canonLayers({...})` with no `icons` key, is untouched — confirmed by
  `git diff` below). Flagging this deviation explicitly per executor
  instructions.
- `src/view/MapView.ts` — a new private `registerIconsIfNeeded()`, called from
  all three places a style gets (re)built: the initial `map.on("load")`,
  `setCampaign`'s `styledata` handler, and `rebuildTheme`'s `styledata`
  handler (the `css-change` path). It's a no-op for handcrafted themes.
- `src/map/icons.test.ts` — pure unit tests for the type→category map and the
  match-expression builder (12/12 taxonomy types covered, unknown types fall
  back to `generic`, expression shape sanity-checked).

Files touched: `src/map/icons.ts` (new), `src/map/icons.test.ts` (new),
`src/map/themes/canonLayers.ts`, `src/map/theme.ts`, `src/view/MapView.ts`,
this file. `git diff --stat main` confirms no other files changed.

`plans/README.md` was **intentionally not updated** — the executor
instructions for this run explicitly overrode the plan's own "update your
status row" done-criterion and said not to touch it. Flagging that here so it
isn't mistaken for an oversight.

## What was actually verified vs. reasoned about

This is the important caveat for the whole document. The environment this
spike was built in has no Obsidian and no browser — `npm run typecheck`,
`npm test`, and `npm run build` are the only things that ran. That means:

- **Verified**: the TypeScript compiles, the pure `type→category` logic is
  correct and covers the full taxonomy, the style JSON that `canonLayers`
  emits is structurally what's described above, and the production esbuild
  bundle builds clean (no import-resolution or bundling surprises beyond what
  `tsc --noEmit` alone would catch).
- **Not verified — reasoned about only**: whether `map.addImage`'d `ImageData`
  actually survives the real MapLibre style lifecycle in a running Obsidian
  window. STOP condition 1 asks specifically whether this can be made robust
  "in ≤2 attempts" — that framing presumes an environment where you can
  attempt it and watch it fail or succeed. That environment wasn't available
  here, so this spike cannot claim STOP condition 1 was cleared. What it can
  claim: `registerIconsIfNeeded()` is wired into every code path that calls
  `map.setStyle` (confirmed by reading `setCampaign`/`rebuildTheme`/the initial
  `onOpen` load handler), which is the documented MapLibre contract for when
  runtime `addImage` images get wiped. **The honest status is "reasoned to
  survive, not run."**

If a human/CLI-enabled follow-up picks this up, the first thing to do is
exactly the manual test plan already in the plan file: open Ashfall on
obsidian-native, switch away and back to obsidian-native (exercises
`rebuildTheme`'s `css-change` path and `setCampaign`'s theme-switch path), and
confirm icons are present and not console-erroring both times.

### The fragile seam, concretely

The `hasImage` existence guard only does the right thing *because*
`map.setStyle` empties the image registry first. The guard's logic is: "if the
image is already there, skip; otherwise draw and add." On a `styledata` that
follows `setStyle`, `hasImage` correctly returns `false` (wiped), so the guard
redraws with the *current* `fill`/`stroke` tokens — which is also how
`css-change` gets picked up (new Obsidian CSS vars → new tokens → redrawn
icons with the new theme's colors). But this is incidental, not guaranteed by
the guard's own logic: if a future MapLibre version stopped wiping images on
`setStyle` (or if `registerIconsIfNeeded` were ever called from a non-`setStyle`
`styledata` event), `hasImage` would return `true` for the old images and the
guard would skip re-adding them — silently keeping stale colors after a theme
change, with no error to signal it. The hardening path if this bites in
practice: use `map.updateImage`/`map.removeImage` on token-relevant callers
instead of relying on the wipe-then-guard pattern, or track the last-registered
token values and compare instead of just checking existence.

## Approach comparison (why runtime canvas glyphs, not a sprite sheet or the sigil generator)

Three candidates were in scope to evaluate per the plan:

1. **External SVG/PNG sprite sheet.** Rejected for this spike: it's an asset
   pipeline (files to draw/export/ship in the plugin bundle), and CLAUDE.md's
   "full function offline" + "inspired-by, never copy game assets" bars mean
   any sprite sheet has to be hand-drawn in-house anyway — that's real design
   effort, better spent once the *category set* is validated than spent before
   it. It's also the most template-proof option long-term (a designer can
   iterate the actual art without touching layer code), which is why it's
   still the right recommendation for a *polished* v2 if design bandwidth
   shows up — see "Rollout recommendation."
2. **Seeded sigil generator (`src/gen/sigil/sigil.ts`).** This is the more
   interesting alternative and worth being explicit about. It's already pure,
   deterministic, seed-driven, and snapshot-tested — architecturally the
   nicest fit with this codebase's "generators are pure `(seed, ...) =>
   output` functions" convention. But it solves a different problem: it
   composes a **unique-looking sigil per location** (frame shape × charge ×
   palette, keyed by a seed) for docs/03 Phase 3a's "location art" tier —
   i.e., *distinguishing individual locations from each other*. This spike
   needs the opposite: **one consistent, instantly-recognizable glyph per
   *category*** (so a GM's eye learns "star = landmark" once and it holds
   everywhere), not a different-every-time sigil per note. Using the sigil
   generator here would mean either (a) pinning it to a fixed seed per
   category, which throws away everything that makes it a *seeded* generator
   and just leaves an oddly roundabout way to draw six fixed SVGs, or (b)
   letting it vary per-location, which actively defeats the "identical glyphs
   = fast visual grammar" goal. Recommendation: keep the sigil generator for
   its intended job (canonized-location flavor art / detail-tier icons at
   high zoom) rather than repurpose it for the type-category glyphs this plan
   is about.
3. **Runtime canvas → `map.addImage` (what was built).** Chosen because it's
   dependency-free, needs no asset pipeline or build step, is trivially
   themeable (glyphs are drawn with the theme's own fill/stroke tokens at
   registration time, so they never go stale relative to a color palette the
   way a pre-baked PNG sprite sheet would), and is a pure function of
   (category, size, tokens) — deterministic in the sense this codebase cares
   about (no per-run randomness), even though "determinism" here is a weaker
   claim than the seeded generators' hash-stable-forever guarantee. Its
   real cost is exactly the STOP-1 lifecycle risk discussed above, which is
   why this whole plan exists as a spike rather than a straight rollout.

## Offline & determinism properties

- Offline: yes — no network fetch, no external file load; canvas primitives
  only.
- Determinism: `drawIcon(ctx, category, size, tokens)` is a pure function of
  its three inputs (no `Math.random`, no `Date.now`, no seed at all) — same
  category + size + tokens always produces the same pixels. This is different
  in kind from the generators' `hash(seed, tile, zoom, generatorId)` contract
  (CLAUDE.md: "same input = same map forever") since there's no seed to vary
  by campaign — that's intentional, because the whole point is that "landmark"
  looks the same glyph in every campaign, not a campaign-flavored variant.
  Nothing here is written to `.mapcache/`, so the "deleting `.mapcache/` is
  harmless" release-blocker bar doesn't apply to icons at all — they're
  regenerated in memory every time `registerIconsIfNeeded()` runs, with
  nothing to delete.

## Generated-layer parity — the headline rollout risk (F2)

**This is the most important thing in this document.** The prototype only
touches `canonLayers.ts` / the `canon` source. `generatedLayers.ts`
(`generated-point`/`generated-point-far`, the settlement circles for the
`generated` source) was explicitly left as plain circles, per the plan's scope.

Quality-bar F2 is "provenance invisible": a GM should not be able to eyeball
canon vs. generated content, only distinguish them through the "Canonize"
action. **Right now, on this branch, that invariant is temporarily broken**:
canon locations show category icons, generated settlements still show bare
circles. That's sanctioned by this plan's explicit scope note ("Out of
scope... generatedLayers.ts parity... but NOTE the parity requirement in the
writeup"), but it means **this prototype must not ship to `main` on its own** —
the rollout plan has to land the `generatedLayers.ts` mirror in the same
release, not as a follow-up sprint, or there's a shipped provenance leak on
every fictional/world-generation campaign in between.

## Rollout recommendation

1. **Mirror `canon-point-icon` onto `generatedLayers.ts`'s settlement points
   in the same change that ships icons to `main`** — not a later ticket. This
   is the F2 fix above, and it's mechanical: same `icon-image` expression,
   same category map, filtered to `generatorId == "world-settlement"` like
   `generated-point` already is.
2. **Apply the opt-in flag to all four handcrafted themes** once the
   obsidian-native prototype has had one real (Obsidian-CLI-driven) pass
   through the manual test plan — i.e., don't roll out further until STOP-1 is
   actually cleared empirically, not just reasoned about (see above).
   Handcrafted themes will need their own `fill`/`stroke` token choices per
   theme (parchment vs. neon-sprawl icons shouldn't look identical) —
   `HANDCRAFTED_THEMES[id]`'s existing `ThemeTokens` (`accent`/`land` or
   similar) are the natural source, mirroring what `obsidianNativeStyle`
   already does.
3. **Per-type `icon-size` tuning**: right now every category shares one
   importance→size curve. Once real content is on screen, some types will
   likely want their own curve (e.g., a landmark star may need to read bigger
   than a residence dot at the same importance tier to feel proportionate).
4. Consider hardening the `addImage` re-registration per the "fragile seam"
   note above (`updateImage`/`removeImage`, or token-diffing) rather than
   relying on "setStyle happens to wipe images" as an implicit contract.

## Open questions for the maintainer

1. **Combined icon+label layer vs. two separate symbol layers.** This
   prototype adds `canon-point-icon` as a second symbol layer on the `canon`
   source, distinct from `canon-label`. Both now compete for the same
   collision index. I could not measure whether this raises label-suppression
   counts (STOP condition 2, "collision-count regressions") without a running
   map to actually pan/zoom and count suppressed labels. Worth having the
   rollout plan explicitly measure this (docs/04's F1 collision-count check)
   before wider rollout — and if it does regress, consider merging icon +
   label into one symbol layer (MapLibre supports both `icon-image` and
   `text-field` on the same symbol layer) so they share one collision box
   instead of two.
2. **Icon color legibility.** `registerIconsIfNeeded()` currently colors every
   glyph `tokens.interactiveAccent` (the same `accent` color `canon-point`'s
   circle already uses), stroked in `backgroundPrimary`. Since the icon sits
   on top of a same-colored circle, the glyph reads via *shape* silhouette
   more than color contrast — it works (shapes are distinguishable), but it's
   not the crisp "white knockout icon on a colored pin" look Google Maps uses.
   Worth deciding whether a knockout glyph (background-colored icon punched
   out of the accent-colored circle) is worth the extra draw complexity for
   the real rollout, versus keeping the current monochrome-on-accent look.
3. **Should the tap target literally grow, or stay circle-sized?** Right now
   `canon-point-icon` is deliberately absent from all three `pickFeatureNear`
   layer lists (`hitTestCanonAt`, `handleClick`, `handleDragStart` in
   `MapView.ts`) — clicks/drags still resolve against `canon-point`'s circle
   geometry (same coordinates, so functionally nothing broke), meaning the
   effective tap target is unchanged from plan 001's circle + 8px tolerance,
   not enlarged by the new 24px icon rendering. Adding `"canon-point-icon"` to
   those three arrays is a one-line change per call site if the rollout wants
   the visually-larger icon footprint to also be the literally-clickable
   footprint — flagging as a deliberate no-op in this spike rather than an
   oversight, since the plan's tap-target bar is about visual/hover
   affordance more than the exact hit-test polygon.

## STOP conditions hit

None hit outright — the layer/lifecycle work is code-complete and
typecheck/test/build-clean — but see "What was actually verified vs. reasoned
about" above: STOP condition 1 (the `addImage`-survives-the-lifecycle check)
could not be empirically exercised in this environment and should be treated
as **open, not cleared**, until someone runs the manual test plan against a
live Obsidian window. STOP condition 2 (collision with `canon-label`) is
likewise unmeasured; flagged as open question 1 above. STOP condition 3
(don't touch all five themes) was honored — only `theme.ts`'s obsidian-native
builder passes `icons: true`; `themes/index.ts`'s handcrafted-theme builder is
untouched.
