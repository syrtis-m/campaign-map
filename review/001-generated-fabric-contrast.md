# 001 — obsidian-native road contrast (fixed; flagging the remaining subtlety)

**Status:** root-cause bug fixed and verified; residual craft question below is genuinely Tier B (aesthetic judgment, not correctness).

## What was found

While verifying Phase 4's viewport dispatcher, screenshots of generated city fabric in the default `obsidian-native` theme looked essentially blank — see `shots/gate-phase3-ashfall-generated.png` (pre-fix) vs `shots/phase4-contrast-fix2.png` (post-fix).

Root cause (`src/map/theme.ts`): `roadMinor` and `water` both resolved to the same CSS token, `--background-secondary`:

```ts
water: tokens.backgroundSecondary,
roadMinor: tokens.backgroundSecondary,   // same token as water — literal color collision
```

Generated streets were rendering in the *exact same color* as water bodies, both close to `--background-primary` on the stock dark theme — a near-zero-contrast line on a near-identical background.

## Fix applied

`roadMinor` now reads `--background-modifier-border` instead — Obsidian's own "visible divider against either background" variable:

```ts
roadMinor: tokens.backgroundModifierBorder,
```

Verified live (screenshot comparison, `shots/phase4-contrast-fix2.png`): streets and district edges are now clearly visible as thin lines, distinct from water/background. No unit test covers CSS-derived color values (by design — they're read from `getComputedStyle` at runtime); this was caught by viewing an actual screenshot per docs/05's discipline, not by an automated check.

## Remaining Tier B question for Jonah

`--background-modifier-border` is Obsidian's *subtle divider* variable — appropriate for its native use (line between two UI panes) but still fairly low-contrast by design (that's what makes it a "divider" and not an "emphasis" color). Post-fix, roads read as thin, quiet lines — deliberately unobtrusive, consistent with the minimalist obsidian-native aesthetic, but worth your eyes on whether that's *enough* presence for the "genre identifiable in 3s" bar (docs/04), especially on light variants of the default theme or third-party Obsidian themes where this variable's actual contrast is unverified (only tested against the stock dark theme in dev-vault).

If it reads as too subtle once you look at it: the next lever is `roadMajor`/`roadMinor` line-width tuning in `src/map/themes/generatedLayers.ts` and `src/map/themes/basemapLayers.ts` (currently 0.5–3px interpolated by zoom) rather than another color swap — width is a safer knob than color since it doesn't touch the "match the user's live theme" contract Phase 1 established for obsidian-native specifically. Not chased further here per docs/06 §2 Tier B discipline: it's a real judgment call about how much visual weight a "generated, not yet canon" element should carry, not a bug.
