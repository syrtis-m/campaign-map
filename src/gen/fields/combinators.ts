/**
 * Field combinators and transforms. All closed-form, pure, and
 * point-evaluable — a combined field is still `f(x, y)` from durable inputs
 * alone, so the seam/determinism properties compose for free.
 *
 * SDF sign convention (matches `sdf.ts`): **positive inside**, negative
 * outside, meters. Under that convention set-union is a pointwise MAX (a point
 * is inside the union iff it is inside either shape → take the more-inside,
 * i.e. larger, signed value) and intersection is a MIN. This is the mirror of
 * iq's negative-inside articles; the code below is written for our sign.
 */
import type { Field } from "./sdf";

/** Union of two SDFs (positive inside): inside either shape. */
export function fUnion(a: Field, b: Field): Field {
  return (x, y) => Math.max(a(x, y), b(x, y));
}

/** Intersection of two SDFs (positive inside): inside both shapes. */
export function fIntersect(a: Field, b: Field): Field {
  return (x, y) => Math.min(a(x, y), b(x, y));
}

/** Subtract `b` from `a` (positive inside): inside `a` and outside `b`. */
export function fSubtract(a: Field, b: Field): Field {
  return (x, y) => Math.min(a(x, y), -b(x, y));
}

/**
 * Smooth union (positive inside) blending over `k` meters — organic blends
 * (`fSmoothUnion(hillA, hillB, 40)` merges two ridges without a hard crease).
 * Implemented as `−smin(−a, −b, k)` with iq's polynomial smin, so the
 * negative-inside smin math is reused unchanged. `k ≤ 0` degrades to a hard
 * `fUnion`.
 */
export function fSmoothUnion(a: Field, b: Field, k: number): Field {
  if (k <= 0) return fUnion(a, b);
  return (x, y) => {
    // smooth-max = -smooth-min(-a,-b): work in the negated (negative-inside) space.
    const na = -a(x, y);
    const nb = -b(x, y);
    const h = Math.max(0, Math.min(1, 0.5 + (0.5 * (nb - na)) / k));
    const smin = nb + (na - nb) * h - k * h * (1 - h);
    return -smin;
  };
}

/**
 * Turn an SDF into a 0..1 mask that ramps from 0 at the boundary (and outside)
 * to 1 at `band` meters inside — `smoothstep(0, band, sdf)`. The mechanism for
 * "noise only inside a shape, fading at its edge": forest
 * density falling off at a treeline, mountain noise contained by a range
 * polygon. `band ≤ 0` gives a hard step at the boundary.
 */
export function fMask(sdf: Field, band: number): Field {
  return (x, y) => {
    const d = sdf(x, y);
    if (band <= 0) return d > 0 ? 1 : 0;
    const t = Math.max(0, Math.min(1, d / band));
    return t * t * (3 - 2 * t);
  };
}

/** Add a constant offset (meters) to a field. */
export function fOffset(f: Field, c: number): Field {
  return (x, y) => f(x, y) + c;
}

/** Scale a field by a constant. */
export function fScale(f: Field, s: number): Field {
  return (x, y) => f(x, y) * s;
}

/** Clamp a field's value to `[lo, hi]`. */
export function fClamp(f: Field, lo: number, hi: number): Field {
  return (x, y) => Math.min(hi, Math.max(lo, f(x, y)));
}

/**
 * Sum any number of fields (left-to-right, so summation order is fixed and
 * deterministic — D2). Empty → constant 0.
 */
export function fSum(...fields: Field[]): Field {
  return (x, y) => {
    let total = 0;
    for (const f of fields) total += f(x, y);
    return total;
  };
}

/**
 * Domain warp (Iñigo Quílez): sample `base` at a position displaced by the
 * offset fields `(wx, wy)` — `base(x + wx(x,y), y + wy(x,y))`. The one trick
 * that turns geometric iso-lines into hand-drawn-looking edges: warping the
 * canopy density field before thresholding scallops and
 * frays the outline. Still `f(x, y)` from durable inputs (the offset is itself a
 * field), so seam/determinism properties compose.
 */
export function fDomainWarp(base: Field, wx: Field, wy: Field): Field {
  return (x, y) => base(x + wx(x, y), y + wy(x, y));
}
