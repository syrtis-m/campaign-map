# Plan 028 — River visual overhaul: natural meanders, banks, legible islands, junctions

**Status:** research/design DONE (2026-07-13, Opus research judged by Fable
orchestrator). Refines plan 022 §3.1's shipped river (22-B, commit 4e6d981 +
follow-ups 31e973d). Rivers are the best-looking procgen kind today; this plan
closes the remaining gap to "reads as a real river." **Depends on:** 022
complete (22-F board). NO dependency on 023 (no marching squares needed).
28-C's glyph pass can share plan 026-C's runtime-image module if 026 lands
first, else ships its own minimal icons. **Execution slot (recommended):** in
the visual-overhaul block with 026/027 (see §7); 28-B must land before or
coherently with 23-E's river-slope coupling (both touch the meander math —
never interleave them).

## 0. Context for a cold-start implementer

**What's already good (don't regress):** spine-corridor containment
(`riverMaxOffset` = params-only monotonic bound), per-segment identity
property (meander/braid hash on each ORIGINAL segment's quantized endpoints;
one-vertex edit re-meanders only adjacent segments + fillet windows —
procgen44 gate: locality 71.7% vs reroll 34.3%), windiness-scaled corner
fillets (canal keeps crisp miters), global centerline (no join notches),
downstream width growth as the ONE slowly-varying global-arc quantity.

**What's broken (diagnosed against `review/v4.5-river-windy-braided.png`):**
1. **The meander is a displacement sinusoid** (fixed 140 m wavelength,
   amplitude windiness×45 m, `sin²` envelope) — a metronomic worm-wiggle.
   Real meanders vary per bend and their bends are skewed/rounded.
2. **The channel is a chain of adjacent quads** → hairline antialiasing seams
   texture the ribbon every 6 m (same MapLibre fill behavior that plagued
   forest/park); flat single-hue fill, no banks, no depth idiom.
3. **Braid islands are thin dark slivers** — wrong shape and illegible.
4. **No junction/mouth anatomy:** two sketched rivers meeting render as
   overlapping ribbons (no Y-merge); delta preset just biases braids; no
   point bars/oxbows/rapids — the cheap "this is a river" storytelling cues.

**Binding constraints:** as plans 026/027 §0 (determinism D1–D6, NO zoom
gates, pure headless, themes own paint, Surface-Pro perf, Vespergate
byte-intact) PLUS the river-specific rules from 022 §3.1: per-segment
hashing (identity property gate must keep passing), every lateral term
bounded by a params-only constant, corridor monotonic in params, params are
the whole truth (presets are sugar — `braidBias`, never a preset-id branch).

**Research digest (2026-07-13 round; key sources):**
- **Sine-generated curve** (Langbein & Leopold 1966): natural channels vary
  their HEADING sinusoidally along arc length, `θ(s) = ω·sin(2πs/L)` — the
  minimum-variance path. Rounded, "lazy" bends; nothing like a displacement
  sine. (americanscientist.org "Up a Lazy River".)
- **Kinoshita curve**: adds a third harmonic for the upstream-skewed,
  fattened bends of real rivers — `θ(s) = θ₀[sin φ + θ₀²·(Jₛ·cos 3φ −
  J_f·sin 3φ)]`, canonical Jₛ ≈ +1/32 (upstream skew), J_f ≈ 1/192. THE
  standard realistic-meander shape in river engineering (Abad et al. WRR
  2023; arXiv 2207.11190). ⚠ verify coefficients against the Abad paper
  before hard-coding (research flag).
- **Empirical ratios** (USGS; Leopold & Wolman / Leopold–Maddock): meander
  wavelength ≈ **10–14× channel width** (default ~11 W); radius of curvature
  ≈ **2–3× width** (floor R_c ≥ 2 W doubles as a containment bound); width ∝
  √discharge → confluence rule **W₃ = √(W₁² + W₂²)** (derived, flagged) and
  distributary widths W/√N after an N-way delta split.
- **Meander trains are quasi-periodic, not periodic** (Ferguson 1975):
  per-bend wavelength/amplitude jitter of ~±25–35% is faithful, not a hack.
- **Braid bars**: lozenge/teardrop, width:length scale-invariant, split→
  rejoin unit ≈ **4–5× channel width** long, taper pointing downstream
  (Hundey & Ashmore 2009). Islands must be land-colored with a minimum
  legible width — legibility is the binding constraint.
- **Delta bifurcation angle ≈ 72°** (measured 70.4°±2.6°, Coffey & Rothman
  2017); delta planforms: arcuate / bird's-foot / cuspate — bird's-foot is
  the most legible at map scale. **Estuary flare**: W(x) = W_mouth·e^(−x/Lc).
- **Confluences**: junction angles 30–90°; render a smooth **Y, never a T**
  (blend tangents, fillet the inner corner); post-junction slightly wider.
- **Fantasy-map river rules** (profantasy "Rules of Rivers"): rivers never
  split downstream except deltas/braids; tributaries join flowing WITH the
  main stem (Y opens upstream). The generator must never emit an inland
  permanent fork.
- **Cartographic water rendering**: dark-edge + lighter-core is the depth
  idiom (casing); historic "water-lining" = parallel shore-offset lines; OSM
  Carto paints river lines and water polygons the SAME hue so overlaps never
  artifact (PR #3930) — bank casing must be a deliberate darker stroke, and
  any line/fill overlap must share the fill hue.
- **MapLibre confirmed**: `line-width` is per-feature/zoom, NEVER per-vertex
  → variable-width channels must stay polygons; `fill-outline-color` is 1 px
  max → a real casing needs a dedicated line layer; `line-gradient` needs
  `lineMetrics: true` and is incompatible with dasharray.
- **mapgen4** (Red Blob): Bézier joint-smoothing + width carried as
  (in-width, out-width) per segment — we already fillet; keep it.

**Infra pitfalls:** plan 022 §0's list applies verbatim.

## 1. Design

### 1.1 Channel body + banks (rendering-first fix)

- **Merge each ORIGINAL segment's quad chain into one polygon** (the ~dozens
  of 6 m resample quads → one ribbon polygon per spine segment, fillet
  windows welded to the neighbor at the shared quantized joint). Kills the
  every-6 m hairline texture. Per-segment feature ids keep hashing the
  segment's quantized endpoints → the identity-property gate keeps its
  feature-level meaning. Joint hairlines (one per spine vertex, not per 6 m)
  are suppressed by a deterministic ~0.5 m overlap weld at the joint window.
  - *Rejected alternative (log if revisited):* ONE polygon per reach — kills
    all hairlines but collapses edit-locality to a single always-dirty
    feature AND a casing traced from polygon outlines would stroke a bar
    across the channel at every joint.
- **Emit `river-bank` LineStrings** — left and right bank lines per segment,
  endpoints welded at shared quantized joints so casing renders continuous
  (`line-join`/`line-cap` round). Themes paint them as the dark casing UNDER
  the channel fill; channel fill goes slightly lighter → the dark-edge/
  light-core water idiom. Optional per-theme second inset "water-lining"
  stroke (parchment/ink-soot themes; the historic technique).
- **Bank hue discipline**: bank casing = deliberate darker stroke; everything
  else water-hued stays EXACTLY `fabricWater` (the OSM Carto rule) so
  fill/line overlaps never artifact.
- Optional `river-thalweg` centerline LineString (already have the global
  centerline) for themes that want a `line-gradient` source→mouth tint
  (`lineMetrics: true` on that source only; no dasharray on it).

### 1.2 Meander math (kills the worm)

Replace the displacement sinusoid inside each segment's `evalAt`:
- **Heading-domain bend shape**: lateral displacement = the integrated
  SGC/Kinoshita profile rather than `sin²`-enveloped sine. Implementation:
  closed-form displacement `D(t) = A·[sin φ + θ_k·(Jₛ·cos 3φ)]`-family with
  the same 0-derivative-at-endpoints envelope (keeps spine-vertex tangency);
  the third-harmonic skew term leans each bend upstream. `windiness` → θ₀
  (amplitude + effective ω). J_f dropped in v1 (subtle at map scale).
- **Per-bend hashed variation**: wavelength drawn per ORIGINAL segment (and
  per lobe within long segments) from `~11×width × (1 ± 0.3·hash)`, amplitude
  jitter ±25%, phase hashed — all keyed on the segment's quantized endpoints
  (identity property preserved verbatim).
- **Realism clamps as containment**: enforce R_c ≥ 2·width by capping local
  amplitude/wavelength combinations; the cap is params-only → feeds
  `riverMaxOffset` unchanged in spirit (recompute the constants; corridor
  stays a pure monotonic function of params). Self-intersection guard
  (AMP_SEG_FRAC) retained.
- Params stay additive (022 §1): `windiness/braiding/width/widthGrowth/
  braidBias` keep their meanings; new optional params only.

### 1.3 Braids, islands

Braid lens reshaped to the empirical unit: split→rejoin length ≈ 4–5×
channel width (raise `MIN_BRAID_SEG_LEN_M` accordingly), island = lozenge
tapering downstream, **minimum island width ≥ 0.4× channel width** (params-
only floor; skip the braid entirely if the segment can't afford a legible
island — degradation-ladder pattern). Island stays a land-hued polygon
(`river-island`, existing paint) ABOVE the channel.

### 1.4 Junctions + mouths (28-C)

- **Confluence**: when two sketched river spines share a quantized endpoint
  (or terminate within a hashed snap radius), emit a Y-merge: blend the two
  inflow tangents into the outflow tangent, fillet the inner corner,
  downstream width = √(W₁² + W₂²) applied to the outflow's `width` param
  contribution. Keyed on the junction point → edit-local. Never emit an
  inland downstream fork (fantasy-rule guard; braids/deltas exempt).
- **Delta** (activates on high `braidBias` at the terminal segment — no new
  preset-id branch): terminal distributaries at ≈ 72° bifurcation angle
  (±hashed 5°), each width W/√N, bird's-foot planform, 1–2 splits max at our
  scale. **Estuary** (new bool param `tidalMouth`): terminal exponential
  flare W(x) = W_mouth·e^(−x/Lc) instead of splitting.
- **Dressing** (symbol/fill pass, ordered by payoff-per-effort from the
  research): point-bar sand crescents on inner bends of high-windiness
  reaches (small land/sand-hued polygons); oxbow-lake blobs beside the
  tightest bends (hashed, sparse — the "old river" story cue); rapids tick
  marks + waterfall/ford SDF glyphs at hashed steep/narrow candidates
  (USGS-symbol style). Glyphs reuse 026-C's runtime-image module when
  present; otherwise 2–3 tiny canvas icons inline.

## 2. Phases

### 28-A — Channel body + banks + legible islands
§1.1 + §1.3. `river.ts`: per-segment polygon merge + `river-bank` lines +
island floor; `generatedLayers.ts`: bank casing under channel fill, hue
discipline, optional thalweg gradient. Snapshots updated deliberately. Live
gate (procgen49): containment, determinism, per-segment edit-locality (the
procgen44 methodology re-run — expect ≥ its 71.7 % locality), no-sliver
assertion (every island ≥ min width), screenshots (canal must stay crisp —
regression-check the canal preset explicitly), z4.5 + close zoom eyeballed.
**Gate: T1** (fast + tsc + build + procgen49 standalone + river fuzz).

### 28-B — Meander math (SGC/Kinoshita + per-bend jitter)
§1.2. Fuzz across the windiness×braiding grid (containment under the new
corridor constants; no self-intersection at extremes). Canal (windiness 0)
byte-identical before/after (the new math must be a strict no-op at zero
amplitude — that's the regression gate). Deliberate golden update for windy/
braided/delta. Screenshot judgment: bends skewed + irregular, no visible
periodicity. **Gate: T1.**

### 28-C — Junctions, mouths, dressing
§1.4. Headless tests: Y-merge tangent continuity, width rule, no inland
forks, delta angles, estuary monotone flare; edit-locality at junctions.
Live gate extends procgen49 (two-spine confluence fixture in the gate
campaign). Perf on throttled CPU (dressing adds features — budget check).
**Gate: T1 + ⛳ full board + refreshed river screenshots in review/.** (Jonah
2026-07-13: this ONE board covers plans 026+027+028 — the board-flake rule
and once-per-plan cadence apply to the block as a whole.)

## 3. Out of scope
River→city constraint cascade (024 owns it — the meandered channel
constraining bridges/streets is 024's flagship); elevation-coupled slope/
windiness (23-E; coordinate — see §7); flow animation; sediment simulation
(iterative models like Howard & Knutson violate closed-form determinism —
research-confirmed dead end for us); waterfalls as elevation features (23-E).

## 4. Open questions for Jonah
- Q1: `tidalMouth` as a param + "estuary" preset — worth the preset-list
  slot, or fold into the delta preset? (Plan default: new preset; presets
  are cheap sugar.)
- Q2: oxbow lakes — always-on at high windiness, or opt-in param `oxbows`?
  (Plan default: hashed-sparse always-on above windiness ≈ 0.7; they're the
  best story cue per pixel.)

## 5. Acceptance
Windy preset: bends irregular + upstream-skewed, no visible periodicity, no
ribbon seam texture, dark-bank/light-core depth idiom present. Canal: byte-
identical geometry to pre-plan (crisp miters, no casing regression beyond
the new bank layer). Braided: islands read as land lozenges at z4.5.
Confluence fixture: smooth Y, wider downstream. Delta: recognizable
bird's-foot. Determinism/edit-locality/seam/fuzz gates green; `rm .mapcache`
regenerates byte-identically; Vespergate byte-intact.

## 6. Research provenance
Full two-round research reports live in the 2026-07-13 orchestrator session;
§0's digest carries every load-bearing finding + source. Flagged-unverified
items to re-check during 28-B: Kinoshita Jₛ/J_f exact values (Abad WRR 2023);
W₃ confluence rule is derived (W∝√Q + additive Q), not directly cited.

## 7. Scheduling / parallelization ruling (2026-07-13)
Same ruling as plans 026 §6 / 027 §7: **no concurrent execution with the
in-flight HEARTBEAT arc** (`river.ts` is quiet post-22-B, but
`generatedLayers.ts` collides with 22-E/F, and mid-arc golden/screenshot
churn would invalidate the 22-F board). 028 has NO plan-023 dependency:
28-A/28-B may run any time after 22-F's board. Ordering constraints:
28-B before-or-with 23-E (river-slope coupling touches the same meander
math — never interleave); 28-C after 026-C if the shared glyph module is
wanted (soft dependency — inline icons otherwise); all of 028 before 024
(cascade consumes the final channel geometry). Recommended block:
023 → 026 → 027 → 028 → 024, or pull 28-A/B forward to right after 22-F if
Jonah wants the river polish sooner.
