/**
 * Elevation noise + the point-evaluable mountain height field (plan 023 §1.1 /
 * §3). These are the field entries §2 deferred out of 23-A — they land NOW with
 * their first consumer, the `mountain` region generator (DECISIONS 2026-07-14
 * "23-A"). Pure/headless, D1–D6 binding: every function answers from `(seed,
 * position)` alone — no neighborhood, no global pass — which is the property
 * (plan 023 §0) that makes tiles seam-free and determinism cheap.
 *
 * ADDITIVE, NOT a refactor of `world/noise.ts`: the existing `valueNoise2D`/
 * `fractalNoise2D` use CUBIC smoothstep (C0 derivative — fine for a plain
 * value field). The analytic-derivative noise here uses QUINTIC easing (iq
 * morenoise) so the derivative is C1-continuous — a genuinely different
 * function. `world/heightmap.ts#heightAt` (world-tier regions/biomes) keeps its
 * cubic noise UNTOUCHED (plan 023 §3 compatibility rule); a single reassociated
 * add there re-rolls every existing campaign's world tier (the 23-A bit-exact
 * lesson, now a release blocker). Nothing existing is rerouted through this
 * module — it is consumed only by NEW features.
 */
import { hashSeed, mulberry32 } from "../rng";

type Pt = [number, number];

/** A value + its analytic spatial gradient (∂/∂x, ∂/∂y), meters⁻¹ for the
 * gradient of a unit-valued noise. */
export interface HeightSample {
  /** Scalar value. */
  v: number;
  /** ∂v/∂x. */
  dx: number;
  /** ∂v/∂y. */
  dy: number;
}

/** Deterministic lattice value in [0,1) at integer cell (ix,iy). Same hashing
 * discipline as `world/noise.ts` (position + salt → mulberry32), so it is a
 * pure function of the cell — no seam handling needed. */
function latticeValue(seed: number, ix: number, iy: number, salt: string): number {
  return mulberry32(hashSeed(seed, ix, iy, salt))();
}

/**
 * Analytic-derivative value noise (iq, iquilezles.org/articles/morenoise).
 * Value noise on an integer lattice is a bilinear polynomial in the cell-local
 * coordinates, so once the corner values are known the value AND its partial
 * derivatives come from the same coefficients at ~zero extra cost — one
 * evaluation instead of the four extra a finite-difference gradient costs.
 *
 * Quintic easing `w(t) = t³(t(6t−15)+10)` (derivative `w'(t) = 30t²(t−1)²`)
 * keeps the gradient continuous across cell boundaries (cubic smoothstep's
 * second derivative jumps — visible as faint creases under hillshade).
 *
 * Returns `{ v, dx, dy }`: value in [0,1); `dx`/`dy` are the exact spatial
 * partials (the `1/cell` chain-rule factor is applied). Pure f(seed, x, y).
 */
export function valueNoise2DWithDeriv(
  seed: number,
  x: number,
  y: number,
  cell: number,
  salt: string
): HeightSample {
  const gx = x / cell;
  const gy = y / cell;
  const ix = Math.floor(gx);
  const iy = Math.floor(gy);
  const fx = gx - ix;
  const fy = gy - iy;

  const a = latticeValue(seed, ix, iy, salt); // v00
  const b = latticeValue(seed, ix + 1, iy, salt); // v10
  const c = latticeValue(seed, ix, iy + 1, salt); // v01
  const d = latticeValue(seed, ix + 1, iy + 1, salt); // v11

  // Quintic ease + its derivative (w.r.t. the cell-local coordinate).
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const du = 30 * fx * fx * (fx - 1) * (fx - 1);
  const dv = 30 * fy * fy * (fy - 1) * (fy - 1);

  // Bilinear polynomial: n = k0 + k1·u + k2·v + k3·u·v.
  const k1 = b - a;
  const k2 = c - a;
  const k3 = a - b - c + d;
  const value = a + k1 * u + k2 * v + k3 * u * v;

  // ∂n/∂fx = (k1 + k3·v)·du ; ∂n/∂fy = (k2 + k3·u)·dv ; then ·(1/cell).
  const dfx = (k1 + k3 * v) * du;
  const dfy = (k2 + k3 * u) * dv;
  return { v: value, dx: dfx / cell, dy: dfy / cell };
}

export interface FbmErodedOptions {
  octaves: number;
  /** Frequency step per octave (cell shrinks by this each octave). */
  lacunarity: number;
  /** Amplitude step per octave. */
  gain: number;
  /** Coarsest octave's lattice cell size, meters. */
  baseCell: number;
  /** Salt disambiguating this fBm from others on the same seed. */
  salt: string;
  /** Gradient-damping strength (iq's erosion trick, §1.1): each octave's
   * amplitude is scaled by `1/(1 + damping·|Σ prior octave gradients|²)`, so
   * steep areas suppress fine detail (smooth steep slopes, detailed flats /
   * ridgelines). `0` disables damping ⇒ a plain fBm whose returned gradient is
   * then EXACT (the finite-difference-testable case). */
  damping: number;
  /** Ridged transform `r = 1 − |2v − 1|` per octave — sharp crests (alpine).
   * The kink at v = 0.5 makes the gradient piecewise; callers avoid asserting
   * an exact derivative on ridged fields. */
  ridged: boolean;
}

const DEFAULT_FBM: FbmErodedOptions = {
  octaves: 4,
  lacunarity: 2,
  gain: 0.5,
  baseCell: 300,
  salt: "elev",
  damping: 0,
  ridged: false,
};

/**
 * Gradient-damped fractional Brownian motion (iq's erosion-like sum, §1.1) —
 * the chosen point-evaluable base for elevation. Accumulates per-octave
 * analytic derivatives into a running vector; each octave's amplitude is damped
 * by `1/(1 + damping·|d|²)` so steep terrain loses fine octaves.
 *
 * Returns `{ v, dx, dy }`, value normalized to ~[0,1]. **Gradient exactness:**
 * with `damping === 0` the damp factor and the amplitude-normalizer are
 * position-independent, so the returned gradient is the EXACT gradient of the
 * returned value (finite-difference-verifiable to tight tolerance — the
 * `fields/elevation.test.ts` guard). With `damping > 0` the per-octave damp is
 * frozen w.r.t. differentiation (the standard iq erosion gradient), an
 * approximation adequate for slope-direction queries (hachure orientation);
 * this is documented, not exact. Pure f(seed, x, y).
 */
export function fbmEroded(
  seed: number,
  x: number,
  y: number,
  opts: Partial<FbmErodedOptions> = {}
): HeightSample {
  const { octaves, lacunarity, gain, baseCell, salt, damping, ridged } = { ...DEFAULT_FBM, ...opts };
  let amp = 1;
  let cell = baseCell;
  let sum = 0;
  let gx = 0; // gradient of `sum` (exact at damping 0)
  let gy = 0;
  let maxAmp = 0;
  // Raw accumulated noise gradient feeding the NEXT octave's damping.
  let accGx = 0;
  let accGy = 0;
  for (let o = 0; o < octaves; o++) {
    const n = valueNoise2DWithDeriv(seed, x, y, cell, `${salt}-o${o}`);
    let val = n.v;
    let vdx = n.dx;
    let vdy = n.dy;
    if (ridged) {
      const s = 2 * val - 1;
      val = 1 - Math.abs(s);
      const sign = s >= 0 ? 1 : -1;
      vdx = -sign * 2 * n.dx;
      vdy = -sign * 2 * n.dy;
    }
    const damp = 1 / (1 + damping * (accGx * accGx + accGy * accGy));
    const w = amp * damp;
    sum += w * val;
    gx += w * vdx;
    gy += w * vdy;
    maxAmp += w;
    accGx += vdx;
    accGy += vdy;
    amp *= gain;
    cell /= lacunarity;
  }
  const inv = maxAmp > 0 ? 1 / maxAmp : 0;
  return { v: sum * inv, dx: gx * inv, dy: gy * inv };
}

/** A height field over gen-space meters: value + analytic gradient at a point.
 * This is the `elevationWithGrad(x,y)` shape plan 023 §3 names — rivers/routes
 * (plan 024) need the gradient for slope queries, and it is already computed
 * inside the fBm loop. In 23-B one field is built per sketched mountain region;
 * plan 024 stage 0 composes several (+ a campaign base, + water carve) into the
 * campaign-wide field. */
export type ElevationField = (x: number, y: number) => HeightSample;
