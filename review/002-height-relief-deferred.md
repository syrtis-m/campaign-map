# Tier B — height relief / hillshade deferred (plan 002)

**Status:** deferred, not a blocker.

Plan 002 paints the fictional-world background from generated biome data
(ocean/coast → water, land → land), which gives real coastlines. It intentionally
does NOT add height relief, because a single overlay color can't express
"elevated" across all five themes: a dark overlay reads as relief on the light
themes (modern-clean, parchment) but is invisible on the dark themes (ink-soot,
neon-sprawl, obsidian-native), and a light overlay inverts the meaning. The token
whose luminance would be needed (`labelMajor`) flips between themes.

**To do it right:** add a per-theme `reliefColor` token (spends part of the ≤8-color
budget, touches all five themes) OR a hillshade/hatch treatment per theme.

**Awaiting Jonah:** whether flat biome fills read well enough, or relief is wanted.
Especially check ink-soot land `#22211f` vs water `#14181c` — a subtle difference;
if too subtle to read as coastline, that's the signal to do the per-biome/relief work.
