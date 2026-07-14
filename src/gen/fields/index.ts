/**
 * `src/gen/fields/` — reusable scalar fields over generation space (plan 023
 * §2). Distance/interiority/constraint fields today; the elevation layers
 * (gradient-damped fBm, §3) land in a later phase on this same base.
 *
 * Everything is pure/headless and point-evaluable (`f(x, y)` from durable
 * inputs only) — the property that keeps tiles seam-free and determinism cheap
 * (plan 023 §0). D1–D6 binding.
 *
 * The leaf distance/containment primitives are the bit-exact source of truth
 * for `region.ts`'s `interiorT`/`distanceToBoundary` and
 * `fabricConstraints.ts`'s `pointInRing` — see the BIT-EXACTNESS note in
 * `sdf.ts`.
 */
export type { Field, Pt } from "./sdf";
export {
  // Leaf primitives (bit-exact, imported back by region.ts / fabricConstraints.ts):
  distanceToRingBoundary,
  ringContainsEvenOdd,
  pointInRingClosed,
  distanceToPolyline,
  // Numeric signed distance (hot-path):
  signedDistancePolygon,
  signedDistancePolyline,
  // Field builders:
  sdfPolygon,
  sdfPolyline,
} from "./sdf";
export {
  fUnion,
  fIntersect,
  fSubtract,
  fSmoothUnion,
  fMask,
  fOffset,
  fScale,
  fClamp,
  fSum,
} from "./combinators";
export type { HeightSample, FbmErodedOptions, ElevationField } from "./elevation";
export {
  // Analytic-derivative noise + gradient-damped fBm (plan 023 §1.1) — the
  // elevation base, consumed first by the `mountain` generator.
  valueNoise2DWithDeriv,
  fbmEroded,
} from "./elevation";
export type { Contour, MarchingSquaresOptions } from "./marchingSquares";
export {
  // Iso-line / iso-band tracing over any scalar field (plan 023 §4.1) — the
  // reusable machinery behind mountain contours (23-C) and forest canopy (026-B).
  marchingSquares,
} from "./marchingSquares";
