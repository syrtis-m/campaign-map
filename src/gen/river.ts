/**
 * River generator (plan 022 §3.1; channel body overhauled per plan 028 §1.1 +
 * §1.3, box 28-A; meander math overhauled per plan 028 §1.2, box 28-B).
 * Pure/headless (no DOM/map/Obsidian imports; reads only its arguments, D6):
 * a sketched river LINE is the SPINE; this elaborates it into per-segment
 * merged channel polygons, `river-bank` casing LineStrings, and legible
 * braid-island lozenges, all strictly inside the spine corridor.
 *
 * Meander shape (plan 028 §1.2 — kills the metronomic worm-wiggle):
 *  - Each ORIGINAL segment's lateral profile is a quasi-periodic train of
 *    half-wave "lobes" (one lobe = one bend). Lobe length targets the
 *    empirical ratio λ ≈ MEANDER_WAVELENGTH_WIDTHS × channel width (USGS /
 *    Leopold–Wolman 10–14 W), jittered ±30% per lobe; per-lobe amplitude is
 *    jittered too (Ferguson 1975: meander trains are quasi-periodic, never
 *    periodic).
 *  - The bend shape carries a Kinoshita third-harmonic skew,
 *    `P(φ) = sin φ − skew·cos 3φ`, `skew = θ₀²·Jₛ`, `θ₀ = KINOSHITA_THETA0_MAX
 *    · windiness`, canonical `Jₛ = 1/32` (plan 028 §0 digest; J_f dropped in
 *    v1 — subtle at map scale). Every full bend's apex leans UPSTREAM (apex
 *    arc-position < bend midpoint). The profile is normalized by its exact
 *    bound max|P| ≤ 1 + skew, so the amplitude budget stays exact.
 *  - Phase is the integral of a piecewise-LINEAR ω(s) interpolated between
 *    per-lobe rates at lobe midpoints (piecewise-quadratic phase ⇒ C1
 *    centerline), and per-lobe amplitudes interpolate linearly at the same
 *    midpoints — per-bend wavelength/amplitude jitter without kinks.
 *  - Realism clamp AS containment (plan 028 §1.2): per-lobe amplitude is
 *    capped so bend curvature radius R_c ≥ RC_MIN_WIDTHS × width (empirical
 *    R_c ≈ 2–3 W): the small-slope bound |D″| ≤ A·ω²·max|P″|/(1+skew) is
 *    inverted for A, with max|P″| evaluated on a fixed deterministic grid.
 *    The cap only SHRINKS amplitudes below the windiness budget, so
 *    `riverMaxOffset` and the corridor argument are unchanged.
 *  - λ and the R_c clamp read `params.width` (BASE width, not the grown
 *    downstream width) — a deliberate deviation from local-width realism so
 *    the meander stays a pure per-segment function of params: zero global-arc
 *    coupling, identity property preserved verbatim. (The braid path's fMid
 *    precedent exists, but the meander is kept stricter.)
 *  - SLOPE COUPLING (box 23-E, the plan 022 §3.1 deferral): the sketch-derived
 *    elevation field (fields/mountainField.ts — a pure function of the durable
 *    mountain sketches on the constraints) modulates each segment's meander:
 *    amplitude ×(1−0.85·k), wavelength ×(1+0.6·k), k = slopeSensitivity ·
 *    sat(mean |∇h| along the segment). Steep ground ⇒ straighter, longer
 *    reaches; flat ⇒ full meander. Sampled at five fixed along-segment positions (position-
 *    derived, zero rng draws) so identity keying and the containment bound are
 *    untouched (amplitude only shrinks); no mountain ⇒ multipliers exactly 1 ⇒
 *    byte-identical to 28-B. Braids are deliberately NOT slope-coupled in v1.
 *  - windiness = 0 (canal) zeroes every amplitude cap, so the lateral offset
 *    is EXACTLY 0 through the same arithmetic — canal output is byte-identical
 *    to 28-A (the sha-pinned regression fixture must never change).
 *
 * Emission shape (plan 028 §1.1 — kills the every-6 m quad hairline texture):
 *  - `river-channel`: ONE ribbon Polygon per ORIGINAL spine segment (the old
 *    per-6 m quad chain merged; left bank forward + right bank reversed). At
 *    each interior spine vertex the downstream segment's ribbon extends
 *    ~0.5 m upstream along both banks (`JOINT_WELD_M`) so adjacent ribbons
 *    OVERLAP instead of abutting — the one remaining per-vertex antialiasing
 *    hairline is painted over. (Rejected: one polygon per reach — kills
 *    edit-locality and strokes a casing bar across every joint; plan 028 §1.1.)
 *  - `river-bank`: left + right bank LineStrings per segment, endpoints landing
 *    exactly on the shared quantized joint samples so round line-joins render
 *    the casing continuous across spine vertices. Braid side-channels emit
 *    their two bank lines too; a braid lens is 0 at both ends, so its casing
 *    tips tuck INSIDE the main channel and never dangle on land.
 *  - `river-island`: ONE lozenge Polygon per braid (plan 028 §1.3), emitted
 *    only over the sub-span where the open ground between main and secondary
 *    channels is ≥ `MIN_ISLAND_WIDTH_FRAC ×` the LOCAL channel width. If no
 *    legible island fits, the whole braid is skipped (degradation ladder) —
 *    no more sliver islands. The braid unit is sized to the empirical
 *    split→rejoin length (~4–5× channel width, Hundey & Ashmore 2009) and its
 *    lens envelope is skewed upstream so the island tapers downstream.
 *
 * Determinism argument (procgen_v3_design.md §4):
 *  - D4/D6: closed-form arithmetic + trig sampling on a mm-quantized spine,
 *    seeded only by `hashSeed(seed, "…", quantized positions)`.
 *  - D5: every emitted coordinate is mm-quantized before it leaves.
 *  - Identity property (plan 020 §gate-b, plan 022 deliverable 4): the meander
 *    of each ORIGINAL spine segment, AND its braid placement, hash on THAT
 *    segment's quantized endpoints — NOT on global arc-length. Resampling is
 *    also per-segment (0→segLen anchored at the segment's own start), so a
 *    single-vertex edit re-meanders ONLY the two adjacent segments plus the
 *    corner-fillet windows (≤FILLET_MAX_M of arc) reaching into their
 *    neighbors' tails; everything further is byte-identical. Global arc-length
 *    (`cumLen`) feeds only the smooth downstream width growth, whose sub-meter
 *    drift a bucket grid absorbs. The joint weld reads ONE sample of the
 *    upstream neighbor's tail — the same blast radius the central-difference
 *    bank normals already have.
 *  - Containment: each lateral displacement term is bounded by a params-only
 *    constant, and `riverMaxOffset(params)` is their sum + a margin, so all
 *    output sits strictly within the corridor `distanceToBoundary` measures
 *    (plan 022 §2). A windiness/width/braiding increase widens the corridor.
 *    A weld point sits ≤ JOINT_WELD_M from a contained bank sample (distance
 *    to the spine is 1-Lipschitz), well inside CORRIDOR_MARGIN_M.
 *  - Feature ids hash the ORIGINAL segment's quantized endpoints plus a small
 *    role discriminant (position, never emission order), integers so
 *    `clipNetworkToTile`'s `Number(id)` sort/clip stays deterministic.
 */
import { hashSeed, mulberry32 } from "./rng";
import { q } from "./waterEmit";
import type { ProcgenRegion } from "./region";
import type { GenerationConstraints } from "./types";
import { elevationFieldFromFabric } from "./fields/mountainField";
import type { ElevationField } from "./fields/elevation";

type Pt = [number, number];

/** River params (plan 022 §3.1). `windiness`/`braiding`/`braidBias` are 0–1;
 * `width` is base channel width in meters; `widthGrowth` widens downstream. */
export interface RiverParams {
  windiness: number;
  braiding: number;
  width: number;
  widthGrowth: number;
  /** 0 = braids uniformly along the river; 1 = braids weighted toward the end
   * (the `delta` preset). Params are the whole truth (determinism), so the
   * "toward the end" behavior is a param, never a preset-id branch. */
  braidBias: number;
  /** Slope coupling strength, 0–1 (box 23-E, the plan 022 §3.1 deferral):
   * local terrain slope — read from the elevation field the SKETCHED MOUNTAINS
   * define (fields/mountainField.ts, a pure function of the durable sketch
   * layer) — damps meander amplitude and stretches wavelength, so a river
   * crossing steep ground runs straighter (flat → full meander, steep →
   * straight; the empirical low-sinuosity-on-gradient signature). 0 disables
   * coupling entirely. OPTIONAL, additive (plan 022 §1): absent ⇒ 1, and with
   * no mountain sketch the multipliers are EXACTLY 1 through the same
   * arithmetic, so every no-mountain river is byte-identical to pre-23-E. */
  slopeSensitivity?: number;
}

// Params-only lateral-budget constants (meters). maxOffset sums their scaled
// maxima, so the corridor is a pure function of the params.
export const BASE_MEANDER_AMP_M = 45; // meander amplitude at windiness = 1
// ── Meander-shape constants (plan 028 §1.2, box 28-B) ────────────────────────
/** Target meander wavelength in channel widths (USGS/Leopold–Wolman: 10–14). */
export const MEANDER_WAVELENGTH_WIDTHS = 11;
/** Per-lobe wavelength jitter, ± fraction (Ferguson quasi-periodicity). */
const WAVELENGTH_JITTER = 0.3;
/** Per-lobe amplitude jitter: A ∈ [1−AMP_JITTER, 1]×cap (±25% around mean). */
const AMP_JITTER = 0.4;
/** Kinoshita heading amplitude θ₀ at windiness 1 (rad, ~109°: a well-developed
 * meander train; plan 028 §0 flags exact coefficients for later verification
 * vs Abad WRR 2023 — Jₛ is the canonical 1/32). */
const KINOSHITA_THETA0_MAX = 1.9;
const KINOSHITA_JS = 1 / 32;
/** Curvature-radius floor in channel widths (empirical R_c ≈ 2–3 W; doubles as
 * the bank self-intersection guard: R_c ≥ 2W ≫ half-width). */
export const RC_MIN_WIDTHS = 2;
// ── Slope coupling (box 23-E; plan 022 §3.1 "modulated by local slope") ───────
// Slope is the mean |∇h| (m/m) of the sketch-derived elevation field over
// five fixed positions along the segment — a pure function of the segment's
// own endpoints + the durable
// mountain sketches, so the per-segment identity keying is untouched (an edit
// re-meanders only the adjacent segments, exactly as before). The response is
// a saturating curve s/(s+HALF) (the wave-1 P2 idiom: smooth saturation, no
// cliffs): HALF is the half-effect slope, calibrated against measured field
// gradients (alpine median ≈ 2.8 m/m, rolling-hills ≈ 1.1 at default params).
// Amplitude is only ever SHRUNK (mA ≤ 1) and wavelength only ever STRETCHED
// (mH ≥ 1 ⇒ fewer, longer lobes), so `riverMaxOffset` and the containment
// proof are byte-untouched. Zero slope (or no mountain sketch) yields mA = mH
// = 1 EXACTLY, so uncoupled rivers/segments multiply by 1 — byte-identical.
const SLOPE_HALF_MPM = 1.2;
/** Max fraction of the meander amplitude a fully steep slope removes. */
const SLOPE_AMP_KILL = 0.85;
/** Max fractional wavelength stretch on a fully steep slope. */
const SLOPE_LAMBDA_STRETCH = 0.6;
// ─────────────────────────────────────────────────────────────────────────────
export const BASE_BRAID_OFFSET_M = 55; // braid lens bulge at braiding = 1 —
// large enough that the secondary channel clears both banks and opens an island
// even on a wide (delta) river.
const CORRIDOR_MARGIN_M = 6;
const RESAMPLE_STEP_M = 6; // centerline sampling step
/** Half-wavelength floor: ≥4 centerline samples per bend (anti-aliasing guard
 * for pathologically narrow widths; params-only). */
const MIN_HALF_WAVELENGTH_M = 4 * RESAMPLE_STEP_M;
const SECONDARY_WIDTH_FRAC = 0.5; // braid side-channel width vs main
const AMP_SEG_FRAC = 0.35; // per-segment amplitude cap (self-intersection guard)
const BRAID_SUB0 = 0.15; // braid unit sits inside [BRAID_SUB0, 1-BRAID_SUB0] of a segment
const MIN_BRAID_SEG_LEN_M = 60; // absolute floor; the width-relative rule below dominates
// Braid unit + island legibility (plan 028 §1.3, Hundey & Ashmore 2009):
// the split→rejoin unit is ~4–5× channel width long, and an island must be
// wide enough to READ as land — otherwise the braid is skipped entirely.
const BRAID_LEN_WIDTHS = 4.5; // target braid-unit length, in local channel widths
const BRAID_MIN_LEN_WIDTHS = 4; // skip the braid if the affordable unit is shorter
export const MIN_ISLAND_WIDTH_FRAC = 0.4; // island floor vs the LOCAL channel width
// Lens-envelope skew: sin²(π·t^p) keeps 0-value/0-derivative endpoints but puts
// the widest point upstream of the middle (t ≈ 0.5^(1/p)), so the island tapers
// downstream — the empirical bar/teardrop orientation. p ∈ (0.5, 1].
const BRAID_TAPER_POW = 0.75;
// Joint overlap weld (plan 028 §1.1): the downstream segment's channel ribbon
// extends this far upstream along both banks, past the shared joint
// cross-section, so adjacent ribbons overlap and the per-vertex antialiasing
// hairline is painted over. Must stay ≪ CORRIDOR_MARGIN_M (containment).
const JOINT_WELD_M = 0.5;
// Corner fillet (Jonah 2026-07-13: sharp spine bends must curve naturally).
// Radius scales with windiness so a canal (windiness 0) keeps its engineered
// crisp corners while a natural river rounds its bends; the quadratic-Bezier
// blend deviates from the spine corner by at most R/2, so the corridor grows
// by windiness·FILLET_MAX_M/2 — still a pure, monotonic function of params.
const FILLET_MAX_M = 60;
const FILLET_FRAC = 0.35; // ≤ this fraction of each adjacent segment
const FILLET_ALLOWANCE_M = FILLET_MAX_M / 2;

/** Base channel half-width at downstream fraction `f` (0 = source, 1 = mouth).
 * The ONE global-arc quantity (plan 022 §3.1); its sub-meter drift on an
 * upstream edit is bucket-absorbed. */
function halfWidthAt(params: RiverParams, f: number): number {
  return (params.width / 2) * (1 + params.widthGrowth * f);
}

function maxHalfWidth(params: RiverParams): number {
  return halfWidthAt(params, 1);
}

/**
 * Corridor half-width (plan 022 §2): a pure function of the params. Every
 * lateral displacement term is individually clamped ≤ its scaled constant, so
 * their sum + margin is a strict upper bound on how far output leaves the
 * spine. Monotonic increasing in windiness, braiding, width, widthGrowth.
 */
export function riverMaxOffset(params: RiverParams): number {
  const meander = params.windiness * BASE_MEANDER_AMP_M;
  const braid = params.braiding * BASE_BRAID_OFFSET_M;
  const fillet = params.windiness * FILLET_ALLOWANCE_M;
  // Worst case at a braid: main meander + lens bulge + (main + secondary) banks.
  const banks = maxHalfWidth(params) * (1 + SECONDARY_WIDTH_FRAC);
  return q(meander + braid + fillet + banks + CORRIDOR_MARGIN_M);
}

interface CenterPoint {
  x: number;
  y: number;
  /** Downstream fraction 0..1 (global arc), for width growth. */
  f: number;
}

/** Per-original-segment generation context: an analytic evaluator for the
 * meandered position at any segment-local arc `s` (fillets need off-sample
 * points), plus the segment's braid decision. */
interface SegmentCtx {
  evalAt: (s: number) => Pt;
  segLen: number;
  /** Whether this ORIGINAL segment carries a braid, and its params: the side
   * the secondary channel bulges to, the lens amplitude, and the braid unit's
   * segment-local arc interval `[s0, s1]` (plan 028 §1.3: ~4–5× channel width
   * long, hashed placement inside the segment's interior window). */
  braid: { side: number; amp: number; s0: number; s1: number } | null;
}

function unit(dx: number, dy: number): Pt {
  const l = Math.hypot(dx, dy) || 1;
  return [dx / l, dy / l];
}

/** Exact worst-case |P″(φ)|/ω² of the skewed profile `sin φ − skew·cos 3φ`,
 * by deterministic grid maximization (720 fixed samples — closed-form
 * arithmetic, no data dependence, D4). Used to invert the R_c clamp. */
function maxProfileCurvature(skew: number): number {
  if (skew <= 0) return 1;
  let m = 0;
  for (let i = 0; i < 720; i++) {
    const phi = (i / 720) * Math.PI * 2;
    m = Math.max(m, Math.abs(-Math.sin(phi) + 9 * skew * Math.cos(3 * phi)));
  }
  return m;
}

/** Per-segment meander offset function (plan 028 §1.2), keyed on the segment's
 * quantized endpoints (identity property). Envelope `sin²(πt)` is 0 with zero
 * derivative at both ends, so the centerline passes through each spine vertex
 * tangentially — self-contained per segment. Inside: a lobe train with hashed
 * per-lobe half-wavelengths (target λ/2 = 11·width/2, ±30%) and amplitudes
 * (±25% around mean), C1-interpolated at lobe midpoints; the Kinoshita
 * third-harmonic term skews every bend's apex upstream. Amplitude caps
 * (windiness budget, AMP_SEG_FRAC self-intersection guard, R_c ≥ 2W realism
 * clamp) are all params-only, so |offset| ≤ windiness·BASE_MEANDER_AMP_M and
 * the corridor bound is untouched. windiness 0 ⇒ every cap 0 ⇒ offset ≡ 0
 * exactly (canal byte-identity). */
function meanderSegment(seed: number, a: Pt, b: Pt, params: RiverParams, elev: ElevationField | null): {
  offset: (localS: number) => number;
  segLen: number;
  leftN: Pt;
} {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const segLen = Math.hypot(dx, dy);
  const [ux, uy] = unit(dx, dy);
  const leftN: Pt = [-uy, ux];
  if (segLen <= 0) return { offset: () => 0, segLen, leftN };
  const rng = mulberry32(hashSeed(seed, "meander", a[0], a[1], b[0], b[1]));
  const phi0 = rng() * Math.PI * 2;
  const sign = rng() < 0.5 ? -1 : 1;
  const W = params.width; // BASE width: params-only (see header — identity)
  // ── Slope coupling (box 23-E): the mean sketch-derived |∇h| over five fixed
  //    interior positions along THIS segment (i/6, i = 1..5 — position-derived
  //    from the segment's own endpoints, so identity keying is untouched, and
  //    NO rng draws, so the stream below is bit-for-bit the 28-B stream). A
  //    single midpoint sample proved luck-hostage on a live gate run — one
  //    ridge-top/valley-floor sample (∇ ≈ 0) switched a mountain crossing's
  //    coupling off; the along-segment mean reads the terrain the reach
  //    actually runs through. Steep ⇒ amplitude damped + wavelength stretched
  //    (straighter); flat or uncoupled ⇒ both multipliers EXACTLY 1 (the mask
  //    is exactly 0 outside every mountain ring, so every sample — hence the
  //    mean — is exactly 0 and far-from-mountain segments stay byte-identical).
  let slopeAmpMul = 1;
  let slopeLambdaMul = 1;
  if (elev) {
    let s = 0;
    for (let i = 1; i <= 5; i++) {
      const t = i / 6;
      const g = elev(a[0] + dx * t, a[1] + dy * t);
      s += Math.hypot(g.dx, g.dy);
    }
    s /= 5;
    const k = (params.slopeSensitivity ?? 1) * (s / (s + SLOPE_HALF_MPM));
    slopeAmpMul = 1 - SLOPE_AMP_KILL * k;
    slopeLambdaMul = 1 + SLOPE_LAMBDA_STRETCH * k;
  }
  // Kinoshita skew: θ₀ scales with windiness, so a near-straight river is
  // near-symmetric and a canal is exactly zero.
  const theta0 = KINOSHITA_THETA0_MAX * params.windiness;
  const skew = theta0 * theta0 * KINOSHITA_JS;
  const pNorm = 1 + skew; // exact bound: |sin φ − skew·cos 3φ| ≤ 1 + skew
  // Lobe layout: half-wave lobes targeting λ/2, hashed relative lengths.
  // (×1 is exact in IEEE 754, so the uncoupled value is bit-unchanged.)
  const H = Math.max(MIN_HALF_WAVELENGTH_M, (MEANDER_WAVELENGTH_WIDTHS * W) / 2) * slopeLambdaMul;
  const nLobes = Math.max(1, Math.round(segLen / H));
  const rel: number[] = [];
  let relSum = 0;
  for (let i = 0; i < nLobes; i++) {
    const r = 1 + WAVELENGTH_JITTER * (2 * rng() - 1);
    rel.push(r);
    relSum += r;
  }
  // Per-lobe midpoints, angular rates, and clamped+jittered amplitudes.
  const ampBudget = Math.min(params.windiness * BASE_MEANDER_AMP_M, AMP_SEG_FRAC * segLen);
  const curvFactor = maxProfileCurvature(skew) / pNorm; // |D″| ≤ A·ω²·curvFactor
  const mids: number[] = [];
  const omega: number[] = [];
  const hs: number[] = [];
  let cursor = 0;
  for (let i = 0; i < nLobes; i++) {
    const h = (segLen * rel[i]) / relSum;
    hs.push(h);
    mids.push(cursor + h / 2);
    omega.push(Math.PI / h);
    cursor += h;
  }
  const amps: number[] = [];
  for (let i = 0; i < nLobes; i++) {
    // R_c ≥ RC_MIN_WIDTHS·W: invert |D″| ≤ A·(π/h)²·curvFactor ≤ 1/(RC·W).
    // The cap uses the NEIGHBORHOOD's shortest half-wavelength: between two
    // midpoints, ω(s) ≤ max(ωᵢ, ωᵢ₊₁) while A(s) ≤ max(Aᵢ, Aᵢ₊₁), so capping
    // every lobe against its worst adjacent rate keeps A(s)·ω(s)² within the
    // budget POINTWISE (a lobe-local cap alone lets the interpolation pair a
    // long lobe's amplitude with a short neighbor's rate — ~30% overshoot at
    // ±30% jitter).
    const hMin = Math.min(hs[Math.max(0, i - 1)], hs[i], hs[Math.min(nLobes - 1, i + 1)]);
    // Box 23-E: rcCap is PINNED at its unstretched value (÷ mH²; hMin carries
    // the λ stretch, so rcCap ∝ h² would otherwise grow by mH² and cancel the
    // amplitude damping almost exactly in the R_c-bound regime — the common
    // one per 28-B's saturation note; caught live twice). Dividing only ever
    // SHRINKS the cap below the physically-allowed bound (longer bends at
    // capped amplitude sit ABOVE the R_c floor), so realism + containment
    // hold, and the slope damping applies AFTER the min so it is never masked.
    // ÷1 and ×1 are exact in IEEE 754 — the uncoupled stream is bit-unchanged.
    const rcCap =
      (hMin * hMin) / (Math.PI * Math.PI * RC_MIN_WIDTHS * W * curvFactor) / (slopeLambdaMul * slopeLambdaMul);
    const cap = Math.min(ampBudget, rcCap) * slopeAmpMul;
    amps.push(cap * (1 - AMP_JITTER * rng()));
  }
  // Cumulative phase at lobe midpoints (trapezoid integrals of the
  // piecewise-linear ω) — closed form, C1 phase.
  const phiMid: number[] = [phi0 + omega[0] * mids[0]];
  for (let i = 1; i < nLobes; i++) {
    phiMid.push(phiMid[i - 1] + ((omega[i - 1] + omega[i]) / 2) * (mids[i] - mids[i - 1]));
  }
  const last = nLobes - 1;
  const offset = (localS: number): number => {
    if (ampBudget <= 0) return 0; // canal: exact zero, byte-identical
    const t = localS / segLen;
    const env = Math.sin(Math.PI * t) ** 2;
    let phi: number;
    let A: number;
    if (localS <= mids[0]) {
      phi = phi0 + omega[0] * localS;
      A = amps[0];
    } else if (localS >= mids[last]) {
      phi = phiMid[last] + omega[last] * (localS - mids[last]);
      A = amps[last];
    } else {
      let j = 0;
      while (localS > mids[j + 1]) j++;
      const span = mids[j + 1] - mids[j];
      const ds = localS - mids[j];
      phi = phiMid[j] + omega[j] * ds + (0.5 * (omega[j + 1] - omega[j]) * ds * ds) / span;
      // Smoothstep (C1) amplitude blend: A′ = 0 at the midpoints, so per-bend
      // amplitude changes add no derivative kink (a linear blend's A′ jump
      // reads as a curvature spike against the R_c floor).
      const u = ds / span;
      A = amps[j] + (amps[j + 1] - amps[j]) * u * u * (3 - 2 * u);
    }
    const prof = (Math.sin(phi) - skew * Math.cos(3 * phi)) / pNorm;
    return sign * A * env * prof;
  };
  return { offset, segLen, leftN };
}

/** Build one original segment's generation context: the analytic meandered
 * evaluator (identity-keyed on the segment's quantized endpoints) and the
 * braid decision (same keying). */
function segmentCtx(
  seed: number,
  params: RiverParams,
  a: Pt,
  b: Pt,
  arcStart: number,
  totalLen: number,
  elev: ElevationField | null
): SegmentCtx {
  const { offset, segLen, leftN } = meanderSegment(seed, a, b, params, elev);
  const [ux, uy] = unit(b[0] - a[0], b[1] - a[1]);
  const evalAt = (s: number): Pt => {
    const off = offset(s);
    return [a[0] + ux * s + leftN[0] * off, a[1] + uy * s + leftN[1] * off];
  };
  // Braid decision, keyed on the segment endpoints (per-segment, not global).
  // Legibility gate (plan 028 §1.3, degradation ladder): a braid happens only
  // if the segment can afford a split→rejoin unit ≥ BRAID_MIN_LEN_WIDTHS
  // channel-widths long AND the lens peak opens an island at least
  // MIN_ISLAND_WIDTH_FRAC channel-widths wide. Both checks use the channel
  // width at the segment's midpoint — the same (sole) global-arc quantity the
  // braidBias weighting already reads.
  let braid: { side: number; amp: number; s0: number; s1: number } | null = null;
  if (params.braiding > 0 && segLen >= MIN_BRAID_SEG_LEN_M) {
    const brng = mulberry32(hashSeed(seed, "braid", a[0], a[1], b[0], b[1]));
    const roll = brng();
    const side = brng() < 0.5 ? -1 : 1;
    const place = brng(); // braid-unit placement inside the interior window
    const fMid = totalLen > 0 ? (arcStart + segLen / 2) / totalLen : 0;
    const bias = (1 - params.braidBias) + params.braidBias * fMid;
    const prob = params.braiding * bias;
    const w = 2 * halfWidthAt(params, fMid); // local channel width
    const amp = Math.min(params.braiding * BASE_BRAID_OFFSET_M, AMP_SEG_FRAC * segLen);
    const peakIsland = amp - w / 2 - (w / 2) * SECONDARY_WIDTH_FRAC;
    const window = (1 - 2 * BRAID_SUB0) * segLen;
    const unitLen = Math.min(window, BRAID_LEN_WIDTHS * w);
    const legible = peakIsland >= MIN_ISLAND_WIDTH_FRAC * w && unitLen >= BRAID_MIN_LEN_WIDTHS * w;
    if (roll < prob && legible) {
      const s0 = BRAID_SUB0 * segLen + place * (window - unitLen);
      braid = { side, amp, s0, s1: s0 + unitLen };
    }
  }
  return { evalAt, segLen, braid };
}

/** Local unit left-normal of a centerline, by central difference. */
function centerlineNormal(center: CenterPoint[], i: number): Pt {
  const prev = center[Math.max(0, i - 1)];
  const next = center[Math.min(center.length - 1, i + 1)];
  const [ux, uy] = unit(next.x - prev.x, next.y - prev.y);
  return [-uy, ux];
}

/** Position-hashed integer feature id (plan 028 §1.1): keyed on the ORIGINAL
 * segment's quantized endpoints + a small role discriminant (main channel /
 * braid channel / left bank / right bank / …), so ids survive emission-order
 * changes and the identity property keeps its feature-level meaning. */
function segFeatureId(seed: number, gid: string, a: Pt, b: Pt, role: number): number {
  return hashSeed(seed, gid, q(a[0]), q(a[1]), q(b[0]), q(b[1]), role);
}

/** One merged ribbon Polygon: `left` chain forward, `right` chain reversed,
 * closed; every coordinate mm-quantized (D5). */
function ribbonFeature(seed: number, gid: string, a: Pt, b: Pt, role: number, left: Pt[], right: Pt[]): GeoJSON.Feature {
  const ring: Pt[] = [];
  for (const p of left) ring.push([q(p[0]), q(p[1])]);
  for (let i = right.length - 1; i >= 0; i--) ring.push([q(right[i][0]), q(right[i][1])]);
  ring.push([ring[0][0], ring[0][1]]);
  return {
    type: "Feature",
    id: segFeatureId(seed, gid, a, b, role),
    geometry: { type: "Polygon", coordinates: [ring] },
    properties: { generatorId: gid, type: gid },
  };
}

/** One bank-casing LineString, mm-quantized (D5). */
function bankFeature(seed: number, a: Pt, b: Pt, role: number, line: Pt[]): GeoJSON.Feature {
  return {
    type: "Feature",
    id: segFeatureId(seed, "river-bank", a, b, role),
    geometry: { type: "LineString", coordinates: line.map((p) => [q(p[0]), q(p[1])]) },
    properties: { generatorId: "river-bank", type: "river-bank" },
  };
}

/** `from` nudged `JOINT_WELD_M` toward `toward` (clamped) — the joint overlap
 * weld. Pure arithmetic on two contained bank samples, so the result stays
 * within JOINT_WELD_M of contained output (distance to the spine is
 * 1-Lipschitz) — covered by CORRIDOR_MARGIN_M. */
function weldToward(from: Pt, toward: Pt): Pt {
  const dx = toward[0] - from[0];
  const dy = toward[1] - from[1];
  const l = Math.hypot(dx, dy);
  if (l <= 1e-9) return from;
  const t = Math.min(1, JOINT_WELD_M / l);
  return [from[0] + dx * t, from[1] + dy * t];
}

/**
 * Generate a river inside a spine corridor (plan 022 §3.1 / plan 028 §1.1).
 * `region.spine` is the mm-quantized sketched polyline; output is per-segment
 * merged river-channel polygons + river-bank casing LineStrings (+ braid
 * river-island lozenges), all strictly within `riverMaxOffset(params)` of the
 * spine.
 * `constraints` feed ONE thing (box 23-E): the sketched MOUNTAIN features, from
 * which the elevation field is composed for slope coupling — reading the raw
 * sketch layer, never another generator's output. The spine (not the generated
 * channel) still feeds the city as a constraint (RIVER_HALF_WIDTH); the
 * channel→constraint cascade remains plan 024 (an intentional seam).
 */
export function generateRiver(
  seed: number,
  region: ProcgenRegion,
  params: RiverParams,
  constraints: GenerationConstraints
): GeoJSON.Feature[] {
  const spine = region.spine;
  if (!spine || spine.points.length < 2) return [];
  const pts = spine.points;
  const totalLen = spine.totalLen;

  // Slope coupling input (box 23-E): the elevation field composed from the
  // SKETCHED mountain features on the constraints — the raw sketch layer, the
  // one cross-feature surface every stage may read (never another generator's
  // OUTPUT; that is plan 024's cascade). `null` when no mountain sketch exists
  // or coupling is off ⇒ the pre-23-E code path, byte-identical. windiness 0
  // (canal) has zero meander amplitude through the same arithmetic regardless.
  const slopeSens = params.slopeSensitivity ?? 1;
  const elev = slopeSens > 0 && params.windiness > 0 ? elevationFieldFromFabric(constraints.fabricFeatures) : null;

  // 1. Per-segment meandered samples (identity-keyed per segment), concatenated
  //    into ONE global centerline. The join vertex appears exactly once (as the
  //    tail sample of the previous segment), so banks and quads bridge every
  //    spine vertex seamlessly — the per-segment emission of v1 left a gap and
  //    a normal mismatch at each vertex (the "sharp bend" notch,
  //    Jonah 2026-07-13).
  const center: CenterPoint[] = [];
  const sampleSeg: number[] = []; // per-sample original-segment index
  const sampleS: number[] = []; // per-sample segment-local arc (m)
  const segs: SegmentCtx[] = [];
  for (let k = 0; k < pts.length - 1; k++) {
    const seg = segmentCtx(seed, params, pts[k], pts[k + 1], spine.cumLen[k], totalLen, elev);
    segs.push(seg);
    const steps = Math.max(1, Math.ceil(seg.segLen / RESAMPLE_STEP_M));
    for (let j = k === 0 ? 0 : 1; j <= steps; j++) {
      const s = (j * seg.segLen) / steps;
      const [x, y] = seg.evalAt(s);
      center.push({ x, y, f: totalLen > 0 ? (spine.cumLen[k] + s) / totalLen : 0 });
      sampleSeg.push(k);
      sampleS.push(s);
    }
  }
  if (center.length < 2) return [];

  // 2. Corner fillets: near each interior spine vertex, blend the centerline
  //    toward a quadratic Bezier (entry point, vertex, exit point) so bends
  //    curve naturally instead of kinking. Radius scales with windiness (a
  //    canal keeps engineered corners) and is capped per adjacent segment; the
  //    cos² blend is 1 at the vertex and 0 at the window edges, so the curve
  //    stays continuous where it rejoins the meander. Identity: a fillet
  //    depends only on its two adjacent segments, so an edit's blast radius is
  //    the adjacent segments plus ≤FILLET_MAX_M into their neighbors' tails.
  const filletMax = params.windiness * FILLET_MAX_M;
  if (filletMax > RESAMPLE_STEP_M) {
    for (let k = 1; k < pts.length - 1; k++) {
      const prev = segs[k - 1];
      const next = segs[k];
      const R = Math.min(FILLET_FRAC * prev.segLen, FILLET_FRAC * next.segLen, filletMax);
      if (R <= RESAMPLE_STEP_M) continue;
      const A = prev.evalAt(prev.segLen - R);
      const B = next.evalAt(R);
      const V = pts[k];
      for (let i = 0; i < center.length; i++) {
        let u: number | null = null;
        if (sampleSeg[i] === k - 1 && sampleS[i] >= prev.segLen - R) u = sampleS[i] - prev.segLen;
        else if (sampleSeg[i] === k && sampleS[i] <= R) u = sampleS[i];
        if (u === null) continue;
        const t = (u + R) / (2 * R);
        const bx = (1 - t) * (1 - t) * A[0] + 2 * t * (1 - t) * V[0] + t * t * B[0];
        const by = (1 - t) * (1 - t) * A[1] + 2 * t * (1 - t) * V[1] + t * t * B[1];
        const w = Math.cos((Math.PI * u) / (2 * R)) ** 2;
        center[i].x += (bx - center[i].x) * w;
        center[i].y += (by - center[i].y) * w;
      }
    }
  }

  // 3. Global banks, then ONE merged channel ribbon + two bank casing lines
  //    per ORIGINAL segment (plan 028 §1.1). Normals by central difference over
  //    the WHOLE centerline (miter-consistent across joins); the joint sample
  //    is shared by both adjacent segments' emissions, and the downstream
  //    ribbon's head is weld-extended past it so the ribbons overlap.
  const out: GeoJSON.Feature[] = [];
  const normals: Pt[] = [];
  const leftBank: Pt[] = [];
  const rightBank: Pt[] = [];
  for (let i = 0; i < center.length; i++) {
    const n = centerlineNormal(center, i);
    normals.push(n);
    const hw = halfWidthAt(params, center[i].f);
    leftBank.push([center[i].x + n[0] * hw, center[i].y + n[1] * hw]);
    rightBank.push([center[i].x - n[0] * hw, center[i].y - n[1] * hw]);
  }
  // Last sample index of each original segment; segment k's emission covers
  // samples [segEnd[k-1] .. segEnd[k]] — the joint sample appears in BOTH.
  const segEnd: number[] = [];
  for (let i = 0; i < sampleSeg.length; i++) segEnd[sampleSeg[i]] = i;
  for (let k = 0; k < segs.length; k++) {
    const i0 = k === 0 ? 0 : segEnd[k - 1];
    const i1 = segEnd[k];
    if (i1 === undefined || i0 === undefined || i1 <= i0) continue;
    const left = leftBank.slice(i0, i1 + 1);
    const right = rightBank.slice(i0, i1 + 1);
    if (k > 0 && i0 > 0) {
      // Joint overlap weld: extend this ribbon's head one hair upstream along
      // both banks so it overlaps the previous segment's ribbon.
      left.unshift(weldToward(leftBank[i0], leftBank[i0 - 1]));
      right.unshift(weldToward(rightBank[i0], rightBank[i0 - 1]));
    }
    out.push(ribbonFeature(seed, "river-channel", pts[k], pts[k + 1], 0, left, right));
    // Bank casing lines: exact joint endpoints (NOT weld-extended) so adjacent
    // segments' casings share the quantized joint vertex and join round.
    out.push(bankFeature(seed, pts[k], pts[k + 1], 0, leftBank.slice(i0, i1 + 1)));
    out.push(bankFeature(seed, pts[k], pts[k + 1], 1, rightBank.slice(i0, i1 + 1)));
  }

  // 4. Braids: per-original-segment decision (identity keying unchanged). The
  //    secondary channel is ONE ribbon bulging to one side over the braid unit
  //    [s0, s1] with a downstream-tapered lens envelope; the island is ONE
  //    lozenge over the sub-run where the open ground is legible (plan 028
  //    §1.3) — and if no legible island fits, the braid emits NOTHING at all.
  //    Banks come from the GLOBAL centerline/normals so braids follow the
  //    filleted curve.
  for (let k = 0; k < segs.length; k++) {
    const braidCtx = segs[k].braid;
    if (!braidCtx) continue;
    const { side, amp, s0, s1 } = braidCtx;
    const span = s1 - s0;
    if (span <= 0) continue;
    const mainSide: Pt[] = []; // main bank on `side` (island's main-channel edge)
    const secInner: Pt[] = []; // secondary bank facing main
    const secOuter: Pt[] = []; // secondary bank away from main
    const islandOk: boolean[] = []; // open ground ≥ the legibility floor here?
    for (let i = 0; i < center.length; i++) {
      if (sampleSeg[i] !== k) continue;
      const s = sampleS[i];
      if (s < s0 || s > s1) continue;
      // Skewed lens envelope: widest upstream of the middle, island tapers
      // downstream. 0 value + 0 derivative at both ends (tangent entry/exit).
      const t = (s - s0) / span;
      const env = Math.sin(Math.PI * Math.pow(t, BRAID_TAPER_POW)) ** 2;
      const lens = amp * env; // lateral bulge of the secondary centerline
      const n = normals[i];
      const hw = halfWidthAt(params, center[i].f);
      const secHw = hw * SECONDARY_WIDTH_FRAC;
      mainSide.push(side > 0 ? leftBank[i] : rightBank[i]);
      secInner.push([center[i].x + n[0] * side * (lens - secHw), center[i].y + n[1] * side * (lens - secHw)]);
      secOuter.push([center[i].x + n[0] * side * (lens + secHw), center[i].y + n[1] * side * (lens + secHw)]);
      islandOk.push(lens - hw - secHw >= MIN_ISLAND_WIDTH_FRAC * 2 * hw);
    }
    // The island is the longest contiguous legible run (the envelope is
    // unimodal, so ties/splits only arise from width growth; longest-run pick
    // is deterministic: strictly-longer wins, first run wins ties).
    let best: [number, number] | null = null;
    let runStart = -1;
    for (let i = 0; i <= islandOk.length; i++) {
      if (i < islandOk.length && islandOk[i]) {
        if (runStart < 0) runStart = i;
      } else if (runStart >= 0) {
        if (!best || i - 1 - runStart > best[1] - best[0]) best = [runStart, i - 1];
        runStart = -1;
      }
    }
    // Degradation ladder: no legible island ⇒ no braid at all.
    if (!best || best[1] - best[0] < 1) continue;
    out.push(ribbonFeature(seed, "river-channel", pts[k], pts[k + 1], 1, secOuter, secInner));
    out.push(bankFeature(seed, pts[k], pts[k + 1], 2, secOuter));
    out.push(bankFeature(seed, pts[k], pts[k + 1], 3, secInner));
    out.push(
      ribbonFeature(
        seed,
        "river-island",
        pts[k],
        pts[k + 1],
        0,
        mainSide.slice(best[0], best[1] + 1),
        secInner.slice(best[0], best[1] + 1)
      )
    );
  }
  return out;
}
