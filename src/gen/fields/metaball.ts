/**
 * Metaball scalar field — a sum of smooth radial bumps around a set
 * of anchor points, the classic "blobby" potential. Adding it to a density field
 * before thresholding makes an iso-contour bulge OUT toward each anchor, so a
 * forest canopy scallops around its tree-clump parents (the fantasy-map cloud
 * edge) instead of tracing raw noise.
 *
 * Pure/headless: `f(x, y)` from the anchor list alone, no neighbourhood,
 * no order dependence (summation order is the caller's fixed anchor order). Each
 * anchor contributes `strength · (1 − d²/r²)²` within its radius `r` and 0
 * outside — C¹ at the radius (no crease), compactly supported so the field stays
 * a bounded local sum.
 */
import type { Field, Pt } from "./sdf";

/**
 * Build a metaball field from `anchors` (each of radius `radius` metres,
 * peak height `strength`). Compactly supported: a sample beyond `radius` of an
 * anchor gets nothing from it. Empty anchors ⇒ constant 0.
 */
export function metaballField(anchors: readonly Pt[], radius: number, strength: number): Field {
  const r2 = radius * radius;
  return (x, y) => {
    let sum = 0;
    for (let i = 0; i < anchors.length; i++) {
      const dx = x - anchors[i][0];
      const dy = y - anchors[i][1];
      const d2 = dx * dx + dy * dy;
      if (d2 >= r2) continue;
      const t = 1 - d2 / r2; // 1 at the anchor, 0 at the radius
      sum += strength * t * t;
    }
    return sum;
  };
}
