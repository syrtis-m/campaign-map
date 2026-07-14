# Plan 026 — Forest visual overhaul: clumped varied trees + organic canopy

**Status:** research/design DONE (2026-07-13, two-round Opus research, judged by
Fable orchestrator; Jonah's complaint: "a mess of same-size dots and messy
grids — different trees should look different"). Fixes plan 022 §3.2's shipped
forest (commit c012975). **Depends on:** 022 complete (22-F board green) for
phase A; **23-C marching squares** for phase B. **Execution slot
(recommended):** as a block with plan 027 between 023 and 024, so 024's
vegetation cascade stage lands on the final forest, not the interim one. See
§6 for the parallelization ruling.

## 0. Context for a cold-start implementer

**What's broken (diagnosed against `review/v4.6-forest-*.png`):**
1. **Canopy** = thousands of separate 26 m cell quads (`src/gen/forest.ts`,
   `FOREST_CELL_M`, 16% vertex jitter). MapLibre draws an antialiasing hairline
   around every fill polygon, so the interior lattice is visible
   (mapbox-gl-js #4880), and the silhouette is an axis-aligned staircase.
2. **Trees** = one flat `circle-radius: 1.6` layer
   (`generated-forest-tree` in `src/map/themes/generatedLayers.ts`) on a 34 m
   grid with 34% jitter. Red Blob Games' point-set research: jitter must be
   ≥ ~0.9 of spacing to randomize angles but ≤ ~0.6 to avoid outliers — no
   value works; a low-jitter lattice ALWAYS reads as a grid. And real forests
   are clumpy (Thomas/Neyman–Scott cluster statistics), not uniform.
3. **`forestType` is emitted but no paint layer reads it** — all five
   varieties (broadleaf/conifer/mixed/swamp/dead-wood) render pixel-identically
   except density.

**Binding constraints (CLAUDE.md, do not violate):** determinism D1–D6 (every
feature a pure function of seed + absolute world position + params; ids hash
position, never emission order; mm-quantization; seeds persisted, never derived
from floats); edit-locality (vertex edit changes only boundary-adjacent
features — the procgen45 gate measures edit-overlap ≫ reroll-overlap and MUST
keep passing); NO zoom gates ever (fictional overview ≈ z4.5; density handled
by paint opacity/size ramps only); generators pure headless, themes own ALL
paint; 60 fps on a Surface Pro (perf claims need CPU-throttled numbers).

**Research digest (full reports in the 2026-07-13 research session; key
sources inline):** the convergent prior-art recipe is TWO layers —
(1) one merged organic "cloud" canopy polygon, (2) clumped size-varied tree
glyphs with south-over-north painter's order. Watabou draws forests as
noise-threshold clouds + front-edge tree sprites (itch.io MFCG devlog 817711);
Here Dragons Abound builds each tree as blob + rim + offset shadow and sorts by
lowest point (heredragonsabound.blogspot.com 2018/05 conifers post); Azgaar
scatters Poisson-disc icons per biome and y-sorts (`src/renderers/
draw-relief-icons.ts` — but its sampler uses `Math.random()`: the AESTHETIC
transfers, the algorithm does not — ours must be position-hashed). MapLibre
facts verified: `symbol-z-order: "viewport-y"` gives y-sorted overlap free;
`icon-allow-overlap: true` + `icon-ignore-placement: true` skips collision
detection (the real symbol perf cliff, maplibre #6192); SDF icons =
single tint (`icon-color`) + halo rim (`icon-halo-*`); multi-tone glyphs need
canvas-generated rasters via `map.addImage`/`updateImage` (documented, cheap —
regenerate on `css-change` exactly like the obsidian-native style JSON);
`icon-translate` on a duplicated dark layer = whole-forest drop shadow.
**Determinism traps rejected by the research:** R2/quasirandom sequences and
classic sequential Poisson dart-throwing are index/order-based → break
edit-locality. Only position-hashed samplers are legal.

**Infra pitfalls:** all of plan 022 §0's list still applies (CLI reload not
enable, headless test-API twins, fresh process per board gate, z4.5 overview,
Vespergate byte-intact, `appendCachedTile` only).

## 1. Design

### 1.1 Tree placement — hashed Thomas clusters (replaces the stipple grid)

Two-scale, all `hashSeed(seed, salt, integer indices)`-keyed:

- **Clump parents** on a coarse lattice (start 110 m; per-variety): existence
  gated by a low-frequency fBm density mask (dense patches, thin gaps — same
  `fractalNoise2D` util), offset hashed per cell. Parent id = lattice indices.
- **Offspring** per parent: count hashed from parent id (per-variety range),
  polar offsets hashed per (parent, k) with radial falloff. `sizeN` (0–1)
  sampled from a LOW-FREQ noise field at the tree position (neighbors
  correlated, like same-age stands) biased up near clump centers — never iid
  random per tree.
- **Loner lattice** between clumps: sparse, high jitter (~0.65 of spacing),
  min-distance reject against nearby clump trees (check the 3×3 parent
  neighborhood — bounded, order-free, still edit-local).
- Containment: same `distanceToBoundary ≥ margin` discipline as today.
- Per-variety placement: conifer tight/regular (weak clustering), broadleaf
  strongly clumped, mixed = two interleaved populations split by a noise
  field (no hard boundary), swamp sparse + biased to the boundary rim,
  dead-wood loners only.
- **Emitted properties:** `forestType`, `sizeN`, `rank` (0 = clump core,
  1 = clump fringe, 2 = loner — paint fades rank 2 first at low zoom),
  `variant` (0–3 hashed glyph pick, phase C).

Edit-locality argument: parents/loners key on absolute lattice indices;
offspring key on the parent; a ring vertex edit changes only which
boundary-adjacent candidates pass containment. The procgen45-style gate holds.

### 1.2 Canopy — merged organic polygon (phase B, on 23-C machinery)

Density field `F(p) = fbm(warp(p)) × interiorT(p) mask`, where
`warp(p) = p + k·fbm₂(p)` (Iñigo Quílez domain warping — the one trick that
turns geometric isolines into hand-drawn-looking edges), PLUS metaball bumps
`Σ falloff(|p − parentᵢ|)` around 1.1's clump parents so the outline scallops
like the classic fantasy cloud edge. Threshold → marching squares (23-C's
module) → 1–2 Chaikin passes → ONE multipolygon per region, clearings as
interior holes (the clearing noise subtracts from F before thresholding).
`edgeRaggedness` scales the warp amplitude near the rim; `density` moves the
threshold; `clearings` scales the subtraction — the three params keep their
meanings (additive-params rule, 022 §1).

- **Dead-wood emits NO canopy** (bare forest has no leaf mass — instant
  variety differentiation, generator-side).
- Everything is a local function of absolute position → marching-squares cells
  re-extract only where the mask changed → edit-locality preserved.
- Feature id: hash of region id + "forest-canopy" (single feature).

### 1.3 Paint (themes own all of it)

- Phase A (no geometry change yet): `fill-antialias: false` on
  `generated-forest-canopy` (kills the hairline lattice in one line); replace
  the single tree circle layer with THREE data-driven circle layers —
  shadow (dark, `circle-translate` ~[0.8, 0.8], blur), base, highlight
  (small, light, translate [-0.4, -0.4]) — with `circle-radius` interpolated
  on `sizeN` (~1.2–3.2 px) and `circle-color`/opacity via
  `["match", ["get","forestType"], …]`. Per-variety greens in every theme
  (broadleaf warm, conifer blue-green, swamp teal-muddy, dead-wood grey-brown
  — Azgaar's biome-color principle: hue carries the read before glyphs do).
  Token approach: keep `fabricForest` as the base; add per-variety `match`
  offsets in `generatedLayers.ts` (or grow tokens — implementer's call, log it).
- Phase B: canopy fill + a slightly darker `line` rim layer (dasharray in
  parchment/ink-soot for a hand-inked edge); clearing layer retires (holes).
- Phase C: symbol layers replace the circles — SDF glyphs per variety
  (broadleaf lumpy blob, conifer scalloped triangle, swamp tuft, dead-wood
  bare fork; 3–4 hashed variants each), `icon-allow-overlap: true`,
  `icon-ignore-placement: true`, `symbol-z-order: "viewport-y"`,
  `icon-size` from `sizeN` × zoom ramp, small `icon-rotate` jitter (NOT
  conifers — they read upright), `icon-color` per variety + `icon-halo` rim,
  duplicated dark layer with `icon-translate` as the shared drop shadow.
  Glyph pixels generated at runtime on a canvas (pure function of theme
  colors), registered via `addImage`, refreshed with `updateImage` on
  `css-change`. Canvas-rastered multi-tone glyphs are the stretch goal only if
  SDF+halo disappoints on screenshot review.
- Low-zoom density: `icon-opacity`/`circle-opacity` =
  `zoomRamp × ["step",["get","rank"], 1, 0.6, 0.3]` — all trees exist at every
  zoom, fringe/loner trees fade first far out. NOTE: this composition is legal
  MapLibre but has no shipping-style precedent (research-flagged) — it lives
  or dies by the z4.5 screenshot test.

## 2. Phases

### 26-A — Clumped varied trees (placement + circle paint)
No 023 dependency. `forest.ts`: replace the tree stipple loop with §1.1
(canopy cell-fill untouched); emit `sizeN`/`rank`/`variant`.
`generatedLayers.ts`: three-layer circles + per-variety match colors + rank
fade; `fill-antialias: false` on canopy. Update snapshots deliberately (log in
DECISIONS.md). Extend the forest fuzz (containment + determinism under the new
sampler). Live gate (procgen47): containment 100%, determinism byte-identical
across two runs, edit-locality overlap ≫ reroll overlap, tree-size variance > 0,
per-variety color assertion via queryRenderedFeatures paint probe, screenshots
at overview z4.5 AND close zoom, eyeballed. Vespergate byte-clean.
**Gate: T1** (fast + tsc + build + procgen47 standalone + forest fuzz).

### 26-B — Organic canopy (REQUIRES 23-C marching squares)
§1.2. Single multipolygon + holes; rim line layer; dead-wood canopy removed;
retire `forest-clearing` features (holes replace them — keep the layer for old
caches per the sketch-corridor precedent, or purge; decide + log). Seam story
unchanged (whole-artifact clip). 2×2 adjacent-tile seam test on the canopy
polygon clip. Edit-locality gate re-run. Screenshot: staircase gone, scalloped
edge visible, no interior lines. **Gate: T1.**

### 26-C — Tree glyph upgrade (symbol layers)
§1.3 phase C. New module `src/map/treeGlyphs.ts` (canvas glyph synthesis —
pure function of theme tokens, unit-testable headless by pixel-hash). Perf
gate on CPU-throttled numbers: 60 fps pan with ≥3 forest regions (~5–10 k
symbols) — if it misses, fall back per Watabou: fewer, larger "micro-grove"
glyphs (one glyph ≈ 3–5 trees), same placement math. Screenshot: five
varieties distinguishable in 3 s (docs/04 bar). **Gate: T1.** (Board: Jonah
2026-07-13 — ONE board covers plans 026+027+028, at 28-C.)

## 3. Out of scope
Forest↔city interaction (024 cascade owns it; one-direction rule stands).
Elevation-coupled tree lines (023/024). Wind/animation. Editing generated
trees directly (never — locked).

## 4. Open questions for Jonah
- Q1: per-variety greens as new theme tokens vs `match` expressions on
  `fabricForest`? (Plan default: match expressions, fewer token surface.)
- Q2: micro-grove fallback acceptable as the DEFAULT at overview zoom if perf
  is fine but visual clutter isn't? (Plan default: no — rank fade first.)

## 5. Acceptance (docs/04 screenshot test, operationalized)
At z4.5 overview AND close zoom: no visible lattice/grid in canopy or trees;
canopy edge organic (no axis-aligned staircase); trees vary in size ≥2× and
cluster visibly; each variety identifiable in 3 s side-by-side; dead-wood
reads bare; no seams at tile joins; determinism + edit-locality gates green;
`rm -rf .mapcache` regenerates byte-identically.

## 6. Scheduling / parallelization ruling (2026-07-13)
**Do NOT run concurrently with the in-flight HEARTBEAT arc.** Hot-file
collisions with 22-E/22-F (`generatedLayers.ts`, `tokens.ts`, `registry.ts`),
the wake protocol treats any dirty tree as an interrupted phase, and mid-arc
forest changes would invalidate the snapshots/screenshots the 22-F board
gates on. Earliest safe slot for 26-A: immediately after 22-F's board.
Recommended slot for the whole plan: after 23-D (26-B needs 23-C), before 024
(so the vegetation cascade stage integrates the final forest once). The only
work safe DURING the arc is new-file-only prep (e.g., `treeGlyphs.ts`
prototyping in a scratch branch) — nothing that edits shared files.
