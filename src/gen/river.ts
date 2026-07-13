/**
 * River generator (plan 022 §3.1) — the first LINE-kind procgen algorithm.
 * Pure/headless (no DOM/map/Obsidian imports; reads only its arguments, D6):
 * a sketched river LINE is the SPINE; this elaborates it into channel + island
 * polygons that stay strictly inside the spine corridor.
 *
 * Determinism argument (procgen_v3_design.md §4):
 *  - D4/D6: closed-form arithmetic + trig sampling on a mm-quantized spine,
 *    seeded only by `hashSeed(seed, "…", quantized positions)`.
 *  - D5: every emitted coordinate is mm-quantized before it leaves.
 *  - Identity property (plan 020 §gate-b, plan 022 deliverable 4): the meander
 *    of each ORIGINAL spine segment, AND its braid placement, hash on THAT
 *    segment's quantized endpoints — NOT on global arc-length. Resampling is
 *    also per-segment (0→segLen anchored at the segment's own start), so a
 *    single-vertex edit re-meanders ONLY the two adjacent segments; every other
 *    segment's output is byte-identical. Global arc-length (`cumLen`) feeds only
 *    the smooth downstream width growth, whose sub-meter drift a bucket grid
 *    absorbs.
 *  - Containment: each lateral displacement term is bounded by a params-only
 *    constant, and `riverMaxOffset(params)` is their sum + a margin, so all
 *    output sits strictly within the corridor `distanceToBoundary` measures
 *    (plan 022 §2). A windiness/width/braiding increase widens the corridor.
 *  - Feature ids hash the quad's centerline endpoints (position, never emission
 *    order), integers so `clipNetworkToTile`'s `Number(id)` sort/clip stays
 *    deterministic.
 */
import { hashSeed, mulberry32 } from "./rng";
import type { ProcgenRegion } from "./region";
import type { GenerationConstraints } from "./types";

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
}

// Params-only lateral-budget constants (meters). maxOffset sums their scaled
// maxima, so the corridor is a pure function of the params.
export const BASE_MEANDER_AMP_M = 45; // meander amplitude at windiness = 1
const MEANDER_WAVELENGTH_M = 140; // ~1 lobe per this much spine length
export const BASE_BRAID_OFFSET_M = 55; // braid lens bulge at braiding = 1 —
// large enough that the secondary channel clears both banks and opens an island
// even on a wide (delta) river.
const CORRIDOR_MARGIN_M = 6;
const RESAMPLE_STEP_M = 6; // centerline sampling step
const SECONDARY_WIDTH_FRAC = 0.5; // braid side-channel width vs main
const AMP_SEG_FRAC = 0.35; // per-segment amplitude cap (self-intersection guard)
const BRAID_SUB0 = 0.15; // braid occupies [BRAID_SUB0, 1-BRAID_SUB0] of a segment
const MIN_BRAID_SEG_LEN_M = 60;

function q(v: number): number {
  return Math.round(v * 1000) / 1000;
}

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
  // Worst case at a braid: main meander + lens bulge + (main + secondary) banks.
  const banks = maxHalfWidth(params) * (1 + SECONDARY_WIDTH_FRAC);
  return q(meander + braid + banks + CORRIDOR_MARGIN_M);
}

interface CenterPoint {
  x: number;
  y: number;
  /** Downstream fraction 0..1 (global arc), for width growth. */
  f: number;
}

/** A meandered centerline sample plus enough per-segment context to build banks
 * and (optionally) a braid. */
interface SampledSegment {
  center: CenterPoint[];
  /** Whether this ORIGINAL segment carries a braid, and its params. */
  braid: { side: number; amp: number } | null;
  /** Local unit left-normal of the ORIGINAL segment (braid displaces along it). */
  leftN: Pt;
  /** Segment-local arc position (meters from segment start) for each center pt. */
  localS: number[];
  segLen: number;
}

function unit(dx: number, dy: number): Pt {
  const l = Math.hypot(dx, dy) || 1;
  return [dx / l, dy / l];
}

/** Per-segment meander offset function, keyed on the segment's quantized
 * endpoints (identity property). Envelope `sin²(πt)` is 0 with zero derivative
 * at both ends, so the centerline passes through each spine vertex tangentially
 * — C1 at the joins w.r.t. the meander, and self-contained per segment. */
function meanderSegment(seed: number, a: Pt, b: Pt, windiness: number): {
  offset: (localS: number) => number;
  segLen: number;
  leftN: Pt;
} {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const segLen = Math.hypot(dx, dy);
  const [ux, uy] = unit(dx, dy);
  const leftN: Pt = [-uy, ux];
  const rng = mulberry32(hashSeed(seed, "meander", a[0], a[1], b[0], b[1]));
  const phi = rng() * Math.PI * 2;
  const sign = rng() < 0.5 ? -1 : 1;
  const nWaves = Math.max(0.5, segLen / MEANDER_WAVELENGTH_M);
  const amp = Math.min(windiness * BASE_MEANDER_AMP_M, AMP_SEG_FRAC * segLen);
  const offset = (localS: number): number => {
    if (segLen <= 0) return 0;
    const t = localS / segLen;
    const env = Math.sin(Math.PI * t) ** 2;
    return sign * amp * env * Math.sin(2 * Math.PI * nWaves * t + phi);
  };
  return { offset, segLen, leftN };
}

/** Sample one original segment independently (0→segLen), anchored at its own
 * start vertex. Skips the join vertex for k>0 (it duplicates the previous
 * segment's tail; both sit at offset 0 on the spine vertex). */
function sampleSegment(
  seed: number,
  params: RiverParams,
  a: Pt,
  b: Pt,
  arcStart: number,
  totalLen: number,
  includeStart: boolean
): SampledSegment {
  const { offset, segLen, leftN } = meanderSegment(seed, a, b, params.windiness);
  const [ux, uy] = unit(b[0] - a[0], b[1] - a[1]);
  const steps = Math.max(1, Math.ceil(segLen / RESAMPLE_STEP_M));
  const center: CenterPoint[] = [];
  const localS: number[] = [];
  for (let j = includeStart ? 0 : 1; j <= steps; j++) {
    const s = (j * segLen) / steps;
    const off = offset(s);
    const bx = a[0] + ux * s;
    const by = a[1] + uy * s;
    center.push({
      x: bx + leftN[0] * off,
      y: by + leftN[1] * off,
      f: totalLen > 0 ? (arcStart + s) / totalLen : 0,
    });
    localS.push(s);
  }
  // Braid decision, keyed on the segment endpoints (per-segment, not global).
  let braid: { side: number; amp: number } | null = null;
  if (params.braiding > 0 && segLen >= MIN_BRAID_SEG_LEN_M) {
    const brng = mulberry32(hashSeed(seed, "braid", a[0], a[1], b[0], b[1]));
    const roll = brng();
    const fMid = totalLen > 0 ? (arcStart + segLen / 2) / totalLen : 0;
    const bias = (1 - params.braidBias) + params.braidBias * fMid;
    const prob = params.braiding * bias;
    if (roll < prob) {
      const side = brng() < 0.5 ? -1 : 1;
      const amp = Math.min(params.braiding * BASE_BRAID_OFFSET_M, AMP_SEG_FRAC * segLen);
      braid = { side, amp };
    }
  }
  return { center, braid, leftN, localS, segLen };
}

/** Local unit left-normal of a centerline, by central difference. */
function centerlineNormal(center: CenterPoint[], i: number): Pt {
  const prev = center[Math.max(0, i - 1)];
  const next = center[Math.min(center.length - 1, i + 1)];
  const [ux, uy] = unit(next.x - prev.x, next.y - prev.y);
  return [-uy, ux];
}

function quad(seed: number, gid: string, a: Pt, b: Pt, c: Pt, d: Pt): GeoJSON.Feature {
  const ring: Pt[] = [
    [q(a[0]), q(a[1])],
    [q(b[0]), q(b[1])],
    [q(c[0]), q(c[1])],
    [q(d[0]), q(d[1])],
    [q(a[0]), q(a[1])],
  ];
  return {
    type: "Feature",
    // Position-hashed integer id (the quad's two centerline endpoints) — never
    // emission order; integer so clipNetworkToTile's Number(id) is stable.
    id: hashSeed(seed, gid, q(a[0]), q(a[1]), q(c[0]), q(c[1])),
    geometry: { type: "Polygon", coordinates: [ring] },
    properties: { generatorId: gid, type: gid },
  };
}

/**
 * Generate a river inside a spine corridor (plan 022 §3.1). `region.spine` is
 * the mm-quantized sketched polyline; output is river-channel (+ river-island)
 * polygons, all strictly within `riverMaxOffset(params)` of the spine.
 * `constraints` are accepted for signature parity but not consumed in v1 — the
 * spine (not the generated channel) still feeds the city as a constraint
 * (RIVER_HALF_WIDTH); the channel→constraint cascade is plan 024, elevation
 * coupling is plan 023 (both intentional seams).
 */
export function generateRiver(
  seed: number,
  region: ProcgenRegion,
  params: RiverParams,
  _constraints: GenerationConstraints
): GeoJSON.Feature[] {
  const spine = region.spine;
  if (!spine || spine.points.length < 2) return [];
  const pts = spine.points;
  const totalLen = spine.totalLen;

  const out: GeoJSON.Feature[] = [];
  for (let k = 0; k < pts.length - 1; k++) {
    const a = pts[k];
    const b = pts[k + 1];
    const seg = sampleSegment(seed, params, a, b, spine.cumLen[k], totalLen, k === 0);
    const c = seg.center;
    if (c.length < 2) continue;

    // Precompute banks along this segment's centerline.
    const leftBank: Pt[] = [];
    const rightBank: Pt[] = [];
    const normals: Pt[] = [];
    for (let i = 0; i < c.length; i++) {
      const n = centerlineNormal(c, i);
      normals.push(n);
      const hw = halfWidthAt(params, c[i].f);
      leftBank.push([c[i].x + n[0] * hw, c[i].y + n[1] * hw]);
      rightBank.push([c[i].x - n[0] * hw, c[i].y - n[1] * hw]);
    }
    // Main channel: one quad per centerline sub-segment (robust tile clipping,
    // no self-intersecting ribbon; adjacent quads share bank vertices exactly).
    for (let i = 0; i < c.length - 1; i++) {
      out.push(quad(seed, "river-channel", leftBank[i], leftBank[i + 1], rightBank[i + 1], rightBank[i]));
    }

    // Braid: a secondary channel bulging to one side over the mid sub-interval,
    // with an island filling the gap between the two channels. Collect the
    // sub-interval banks first, then emit quads over consecutive pairs.
    if (seg.braid) {
      const { side, amp } = seg.braid;
      const s0 = BRAID_SUB0 * seg.segLen;
      const s1 = (1 - BRAID_SUB0) * seg.segLen;
      const span = s1 - s0;
      const mainSide: Pt[] = []; // main bank on `side`
      const secInner: Pt[] = []; // secondary bank facing main
      const secOuter: Pt[] = []; // secondary bank away from main
      const gap: boolean[] = []; // is there real open land (island) here?
      for (let i = 0; i < c.length && span > 0; i++) {
        const s = seg.localS[i];
        if (s < s0 || s > s1) continue;
        const env = Math.sin(Math.PI * ((s - s0) / span)) ** 2;
        const lens = amp * env; // lateral bulge of the secondary centerline
        const n = normals[i];
        const hw = halfWidthAt(params, c[i].f);
        const secHw = hw * SECONDARY_WIDTH_FRAC;
        mainSide.push([c[i].x + n[0] * side * hw, c[i].y + n[1] * side * hw]);
        secInner.push([c[i].x + n[0] * side * (lens - secHw), c[i].y + n[1] * side * (lens - secHw)]);
        secOuter.push([c[i].x + n[0] * side * (lens + secHw), c[i].y + n[1] * side * (lens + secHw)]);
        gap.push(lens - hw - secHw > 0);
      }
      for (let i = 0; i < mainSide.length - 1; i++) {
        out.push(quad(seed, "river-channel", secInner[i], secInner[i + 1], secOuter[i + 1], secOuter[i]));
        // Island only where the lens clears both banks at BOTH ends of the quad.
        if (gap[i] && gap[i + 1]) {
          out.push(quad(seed, "river-island", mainSide[i], mainSide[i + 1], secInner[i + 1], secInner[i]));
        }
      }
    }
  }
  return out;
}
