/**
 * Simplified tensor field for street generation (Wonka 2008 / phiresky survey
 * lineage). A field is a pure function of world coordinates only — never of
 * any other point or generation order — so it can be sampled identically by
 * any tile that needs it. Combination of basis fields:
 *  - one global "grid" basis (roughly axis-aligned street grid, seeded angle)
 *  - N radial basis fields at seeded singularities (roundabouts / squares —
 *    streets curve to converge on them, the classic "radial district" look)
 * Basis tensors are summed with distance-based decay and eigen-decomposed to
 * the major (street) eigenvector direction at each sample point.
 */
import { hashSeed, mulberry32 } from "../rng";
import type { BBox } from "../spatialHash";

export interface Tensor2 {
  // symmetric 2x2 tensor [[a, b], [b, -a]] — the standard "line field" tensor
  // representation where eigenvectors are direction-only (no polarity), which
  // avoids the discontinuity of picking +/- streamline direction per sample.
  a: number;
  b: number;
}

interface RadialBasis {
  cx: number;
  cy: number;
  decay: number; // 0.1-0.4 per docs/quality-bar.md tuning range
}

export interface TensorFieldParams {
  gridAngle: number;
  radials: RadialBasis[];
}

const DEFAULT_DECAY_MIN = 0.1;
const DEFAULT_DECAY_MAX = 0.4;

/**
 * Builds field params from a seed + the campaign's fixed world bounds — pure,
 * deterministic, no I/O.
 *
 * `worldBounds` must be the campaign's constant bounds (its `.map.md` bbox),
 * NEVER the bbox of the tile currently being generated. Two adjacent tiles
 * would otherwise derive singularity positions from two different rectangles
 * and produce two entirely different fields, breaking seams before
 * streamlines are even traced — the field must be identical everywhere a
 * tile could ask about it.
 */
export function buildTensorField(campaignSeed: number, worldBounds: BBox): TensorFieldParams {
  const rng = mulberry32(hashSeed(campaignSeed, "tensorfield"));
  const gridAngle = rng() * Math.PI;

  const w = worldBounds.maxX - worldBounds.minX;
  const h = worldBounds.maxY - worldBounds.minY;
  const radialCount = 2 + Math.floor(rng() * 2); // 2-3 singularities: plausible district centers
  const radials: RadialBasis[] = [];
  for (let i = 0; i < radialCount; i++) {
    radials.push({
      cx: worldBounds.minX + rng() * w,
      cy: worldBounds.minY + rng() * h,
      decay: DEFAULT_DECAY_MIN + rng() * (DEFAULT_DECAY_MAX - DEFAULT_DECAY_MIN),
    });
  }
  return { gridAngle, radials };
}

function gridTensor(angle: number): Tensor2 {
  // Line-field tensor for a straight direction `angle`: R(2*angle) form.
  return { a: Math.cos(2 * angle), b: Math.sin(2 * angle) };
}

function radialTensor(px: number, py: number, basis: RadialBasis): { t: Tensor2; weight: number } {
  const dx = px - basis.cx;
  const dy = py - basis.cy;
  const dist = Math.hypot(dx, dy) || 1e-6;
  // Direction tangent to the radial (streets curve around the center, like a
  // town square) — angle of the vector rotated 90deg.
  const angle = Math.atan2(dy, dx) + Math.PI / 2;
  const weight = Math.exp(-basis.decay * (dist / 100));
  return { t: gridTensor(angle), weight };
}

/** Samples the combined field at a world point, returns the major (street) direction angle. */
export function sampleFieldAngle(field: TensorFieldParams, x: number, y: number): number {
  let a = gridTensor(field.gridAngle).a;
  let b = gridTensor(field.gridAngle).b;
  for (const basis of field.radials) {
    const { t, weight } = radialTensor(x, y, basis);
    a += t.a * weight;
    b += t.b * weight;
  }
  // Eigenvector angle of [[a,b],[b,-a]] is atan2(b,a)/2 (line-field convention).
  return Math.atan2(b, a) / 2;
}
