# Quality bar — failure modes, acceptance criteria, pinned aesthetic defaults

*The premise: quick-add tools drift toward mess. A map built up over 30 sessions in
5-second bursts ends up looking like a corkboard rather than an atlas unless the
defaults do the cartographic work. This doc is acceptance criteria: the failure
modes the design must defend against (F1–F8), the screenshot test that judges any
build, and the pinned aesthetic defaults agents work within. It was written as a
red-team pass in July 2026 and is kept current; where a countermeasure names a
mechanism, the code is the truth for how it works.*

## The acceptance bar (the screenshot test)

A cold screenshot of any campaign at any zoom should pass, every time:

- no colliding labels;
- no visible tile seams;
- no blank voids (unexplored space looks intentional, per theme);
- no default-font text anywhere;
- a stranger can identify the genre from the map alone in 3 seconds.

This is a release judgment a human (or an agent actually reading the png) makes;
the per-commit visual net is the playground + perceptual goldens + `citynet/metrics.ts`
(which turns chunks of this test numeric — intersection density, street linear
density, land share, width histograms, calibrated against Salat's figure-ground
research).

## Failure modes and their standing countermeasures

### F1. The corkboard problem
Thirty sessions of quick-adds = 200 pins of equal weight, colliding labels, a tavern
as prominent as a nation.

**Countermeasure.** The map curates itself: every location type carries an
**importance rank** (label size, halo, collision priority derive from it — the GM
never sets font sizes). Name reveal is the explicit per-note `visibility` field
(wide/mid/close) against the campaign's three focus levels — set once in the
quick-add dialog, changeable from the right-click menu, defaulting to `mid`. The
5-second flow stays 5 seconds; the cartographic discipline comes from defaults.
**The dot always renders at every zoom** — only names reveal progressively (the
zoom-LOD locked decision).

### F2. Provenance seams
Sketched and generated fabric of the same kind reading as two different tools — a
hand-drawn road in one hue and weight, a generated street in another. It reads as
layers of software instead of a single map.

**Countermeasure.** One legend per kind; provenance stays invisible. Sketched and
generated fabric of the same kind share theme tokens; generators emit typed
features only (never styles), and all generated paint derives from the style
contract × per-theme role maps, so generated and manual content are
indistinguishable in render. Generation is *reactive to* the GM's hand (sketches
are constraints), so generated streets stop at sketched shorelines instead of
crossing them. Locations always render above all fabric (the z-order invariant).

### F3. Tile seams and LOD pops
Per-tile deterministic generation is prone to streets that dead-end at
tile boundaries; zoom transitions that pop content look broken.

**Countermeasure.** World tier: order-free construction (position-hashed seeding,
halo generation, fields-not-neighbors, bit-identical clipping — docs/procgen-design.md
§3). Region tier: the whole network is computed once per region and every tile
clips the same bytes — seams impossible by construction. 2×2 adjacent-tile seam
tests are mandatory for every generator. No detail band ever pops in via zoom
gates (fabric renders at every zoom; density is handled by theme paint).

### F4. Blank-void mid-zoom
Ungenerated fictional space reads as "broken," not "unexplored."

**Countermeasure.** Unexplored space gets a deliberate per-theme treatment (sepia
wash on `parchment`, smog gradient on `ink-soot`, light gray on `modern-clean`)
rather than reading as empty, plus the campaign-wide base terrain so a fictional
viewport is never featureless.

### F5. Name mishmash
Seeded name generators without a shared culture model produce "Grimhold" next to
"Zyx'thara" next to "Steve's Tavern."

**Countermeasure.** **Naming cultures as regions** (Azgaar's proven model): each
region carries a phoneme/style profile (`src/gen/naming/cultures/`); all
generators in a region draw from it, and the quick-add flow offers three
culture-consistent suggestions (tab to accept), so cohesion is the default rather
than something the GM maintains by hand. Shipped cultures pair contrast within each genre
(fantasy-brackish/-sunlit, modern-anglo/-mediterranean, neon-corpo/-street).

### F6. Programmer-art themes
The biggest risk to "premium feel." A parchment-colored background with default
fonts is a Google Maps clone in a costume.

**Countermeasure.** This is where the craft budget goes. Typography is 80% of map feel:
per-theme font stacks with real cartographic conventions (letter-spaced small-caps
for regions, italic serif for water, weight-by-importance). Texture and edge
treatments (paper grain, coastline double-strokes, rivers tapering by flow order,
hatch fills on ink-soot). Map furniture (compass rose, scale bar, neatline) per
theme. ≤8 semantic color tokens per theme; everything draws from them. MapLibre's
realistic ceiling is fine stylized vector, not Inkarnate; within that ceiling,
typography, texture, and furniture carry the feel.

### F7. Vault pollution
The tool writes into a real campaign vault. Failure mode: frontmatter bloat on
human notes, orphan sidecars, cache noise, other plugins mangling geometry fields.

**Countermeasure.** Frontmatter stays minimal; complex geometry in sidecars;
`.mapcache/` is regenerable and sync/search-excludable; zod validation at
reconcile with visible warning badges, never silent drops; the note body is the
human's — the plugin never writes below the frontmatter fence.

### F8. Update jank
Naive whole-source refreshes on every edit cause label flicker and re-layout churn
across a session's many small edits.

**Countermeasure.** Stable feature ids + staged, region-scoped `updateData` diffs
(never whole-collection `setData` on a routine edit); debounced commit paths with
cheap per-frame previews (ARCHITECTURE §13 is the authoritative map); generation
and terrain sampling in the worker so the map thread never stutters; eased `flyTo`
for camera moves.

## The keepsake bar

The real bar is *the output after a campaign* — product features, not style tweaks,
all fed by data the system already keeps:

1. **Poster export** — high-res render of any viewport; the thing that gets framed.
2. **Campaign replay** — scrub the mutation log; watch the map grow session by
   session.
3. **Atlas export** — PDF: overview + per-region spreads + gazetteer (the location
   notes ARE the gazetteer).
4. **Session paths** — per-session travel lines, styled per theme.

## Pinned aesthetic defaults (agents work within these)

The exact values live in code — `src/map/themes/tokens.ts` (theme + per-fabric-kind
colors), `src/model/locationNote.ts` (type taxonomy: importance ranks +
visibility hints), `src/gen/world/params.ts` and generator param schemas (tuning
ranges), `src/gen/naming/cultures/` (phoneme tables). The standing rules:

- **Theme tokens are pinned.** Agents may tune ±10% lightness/chroma in OKLCH —
  logged in DECISIONS.md — but never hue, and never invent new tokens casually
  (≤8 semantic colors per theme).
- **Fonts per theme** (all OFL, glyph PBFs shipped in assets): obsidian-native →
  inherit/Inter · modern-clean → Inter · parchment → Alegreya / Cormorant SC ·
  ink-soot → IBM Plex Serif / Oswald · neon-sprawl → Rajdhani / Saira Condensed.
- **Type taxonomy defaults do the discipline**: importance 1 (nation) … 7 (minor
  residence); the per-type visibility *hint* only pre-selects the quick-add picker
  — the stored explicit `visibility` field is the sole runtime gate.
- **Tuning stays in range**: generator param schemas define the sanctioned ranges;
  out-of-range retunes need a `review/` entry (and byte-affecting changes a
  version bump per plan 029).
- **When genuinely undecided**: pick the option closest to Google Maps behavior,
  log it in DECISIONS.md, never block.
- Inspired-by aesthetics only — never copy game assets or trade dress. Third-party
  assets (fonts, icons) are recorded in `ATTRIBUTIONS.md`.
