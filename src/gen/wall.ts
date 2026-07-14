/**
 * Wall generator (plan 022 §3.4) — the second LINE-kind procgen algorithm
 * (river was the first). Pure/headless (no DOM/map/Obsidian imports; reads only
 * its arguments, D6): a sketched `wall` LINE is the SPINE; this elaborates it
 * into a masonry band, towers, gates and an optional moat — all strictly inside
 * the spine corridor.
 *
 * Determinism argument (procgen_v3_design.md §4):
 *  - D4/D6: closed-form arithmetic on a mm-quantized spine, seeded only by
 *    `hashSeed(seed, salt, quantized positions)`.
 *  - D5: every emitted coordinate is mm-quantized before it leaves.
 *  - Identity property (plan 022 §3.4, same discipline as the river meander
 *    §3.1): each ORIGINAL spine segment's tower run gets a seeded PHASE hashed
 *    on THAT segment's quantized endpoints — never global arc-length. So a
 *    single-vertex edit re-phases ONLY the two adjacent segments (their towers
 *    shift); every other segment's towers are byte-identical. A re-roll (new
 *    seed) re-phases every segment (measured in the gate: tower-bucket overlap
 *    away from an edit ≫ overlap under re-roll). Corner accents key on the
 *    vertex position, so only the moved corner's accent changes on an edit.
 *  - Gates are where a sketched ROAD crosses the spine (plan-020 gate-at-
 *    crossing logic against `constraints.fabricFeatures` roadLines — NOT the
 *    generated city streets: reading another generator's output is the plan-024
 *    cascade, forbidden here, exactly as the river defers channel→constraint).
 *    A crossing is a closed-form segment/segment solve on quantized geometry.
 *  - Containment: every lateral displacement term is bounded by a params-only
 *    constant, and `wallMaxOffset(params)` is their max + margin, so all output
 *    sits strictly within the corridor (plan 022 §2). A moat/wider-tower params
 *    change widens the corridor, never violates it.
 *  - Feature ids hash on POSITION (never emission order), integers so
 *    `clipNetworkToTile`'s `Number(id)` sort/clip stays deterministic.
 *
 * Double-wall resolution (plan 022 §3.4) does NOT live here — wall elaboration
 * is stage 4 (AFTER the city), so its output cannot legally constrain city
 * generation. The suppression signal is the RAW wall SKETCH, read by the CITY
 * (stage 3) via `constraints.fabricFeatures`: see `buildWall` in
 * `citynet/skeleton.ts`, which drops its own wall-band segments that run
 * alongside a sketched wall. This generator just decorates the GM's line.
 */
import { hashSeed, mulberry32 } from "./rng";
import { q, quad, spanQuad } from "./waterEmit";
import { indexFabricConstraints } from "./fabricConstraints";
import type { ProcgenRegion } from "./region";
import type { GenerationConstraints } from "./types";

type Pt = [number, number];

export const WALL_STYLES = ["curtain-wall", "palisade", "bastioned"] as const;
export type WallStyle = (typeof WALL_STYLES)[number];

/** Wall params (plan 022 §3.4). `style` drives layout AND is carried onto every
 * feature for theme tinting (like the park `variety` / city `profile`), never a
 * preset-id branch. `towerSpacing` is meters between towers along a segment;
 * `moat` toggles the outboard channel; `gatehouseScale` widens gate openings +
 * their markers. */
export interface WallParams {
  style: WallStyle;
  towerSpacing: number;
  moat: boolean;
  gatehouseScale: number;
}

// Params-only lateral-budget constants (meters). `wallMaxOffset` takes their
// max, so the corridor is a pure function of the params.
const WALL_HALF_WIDTH_M = 3; // masonry band half-width
const RESAMPLE_STEP_M = 5; // band + moat sampling step (fine enough for gate gaps)
const TOWER_HALF_M = 5; // curtain tower half-size (a square straddling the spine)
const CORNER_TOWER_HALF_M = 5.5; // corner tower at an interior vertex (curtain)
const BASTION_HALF_M = 9; // bastion (bastioned) half-size at each corner — the star-fort protrusion
const MOAT_GAP_M = 5; // gap from the wall outer face to the moat inner edge
const MOAT_WIDTH_M = 12; // moat channel width
const GATE_HALF_M = 6; // gate opening half-length along the wall (× gatehouseScale)
const CORRIDOR_MARGIN_M = 4;
const MIN_TOWER_SPACING_M = 15; // clamp — a denser spacing would carpet the wall
const MIN_TOWER_SEG_LEN_M = 12; // segments shorter than this carry no along-run towers

/** Along-segment / gatehouse tower half-extent for `style` (0 = palisade). */
function towerHalf(params: WallParams): number {
  if (params.style === "palisade") return 0;
  return params.style === "bastioned" ? BASTION_HALF_M : TOWER_HALF_M;
}

function gatehouseHalf(params: WallParams): number {
  return TOWER_HALF_M * (0.8 + 0.6 * Math.max(0, params.gatehouseScale));
}

/**
 * Corridor half-width (plan 022 §2): a pure, monotonic function of the params.
 * Every emitted point sits at most this far from the spine, so it is a strict
 * upper bound on how far output leaves the sketched line. Adding a moat or a
 * larger tower/gatehouse widens it; a palisade (no towers, no moat) is the
 * tightest corridor.
 */
export function wallMaxOffset(params: WallParams): number {
  const bandHalf = WALL_HALF_WIDTH_M;
  const towers = Math.max(towerHalf(params), gatehouseHalf(params));
  const moat = params.moat ? bandHalf + MOAT_GAP_M + MOAT_WIDTH_M : 0;
  return q(Math.max(bandHalf, towers, moat) + CORRIDOR_MARGIN_M);
}

function unit(dx: number, dy: number): Pt {
  const l = Math.hypot(dx, dy) || 1;
  return [dx / l, dy / l];
}

/** Proper segment/segment intersection point (null when parallel or disjoint).
 * Endpoint-grazing counts (t/u in [0,1]) — a road that ends exactly on the wall
 * still opens a gate. Closed-form, deterministic. */
function segCross(a: Pt, b: Pt, c: Pt, d: Pt): Pt | null {
  const rx = b[0] - a[0];
  const ry = b[1] - a[1];
  const sx = d[0] - c[0];
  const sy = d[1] - c[1];
  const denom = rx * sy - ry * sx;
  if (denom === 0) return null;
  const t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / denom;
  const u = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return [a[0] + t * rx, a[1] + t * ry];
}

/** A tower footprint: a square (curtain) or diamond (bastioned) straddling the
 * spine at (cx,cy), oriented to the wall direction (ux,uy). Straddling keeps
 * containment side-agnostic (reach = `half`, both sides symmetric). */
function towerFeature(
  seed: number,
  gid: string,
  cx: number,
  cy: number,
  ux: number,
  uy: number,
  half: number,
  diamond: boolean,
  style: WallStyle
): GeoJSON.Feature {
  const nx = -uy;
  const ny = ux;
  const corners: [Pt, Pt, Pt, Pt] = diamond
    ? [
        [cx + ux * half, cy + uy * half],
        [cx + nx * half, cy + ny * half],
        [cx - ux * half, cy - uy * half],
        [cx - nx * half, cy - ny * half],
      ]
    : [
        [cx + ux * half + nx * half, cy + uy * half + ny * half],
        [cx + ux * half - nx * half, cy + uy * half - ny * half],
        [cx - ux * half - nx * half, cy - uy * half - ny * half],
        [cx - ux * half + nx * half, cy - uy * half + ny * half],
      ];
  const f = quad(seed, gid, corners[0], corners[1], corners[2], corners[3]);
  (f.properties as Record<string, unknown>).wallStyle = style;
  return f;
}

/**
 * Generate a wall inside a spine corridor (plan 022 §3.4). `region.spine` is the
 * mm-quantized sketched polyline; output is the masonry band (`wall-quad`),
 * `wall-tower` footprints, `wall-gate` markers where a sketched road crosses,
 * and (when `moat`) a `wall-moat` channel — all strictly within
 * `wallMaxOffset(params)` of the spine. `constraints.fabricFeatures` (gen-space
 * meters) supplies the crossing ROADS for gates.
 */
export function generateWall(
  seed: number,
  region: ProcgenRegion,
  params: WallParams,
  constraints: GenerationConstraints
): GeoJSON.Feature[] {
  const spine = region.spine;
  if (!spine || spine.points.length < 2) return [];
  const pts = spine.points;
  const out: GeoJSON.Feature[] = [];
  const gateHalf = GATE_HALF_M * Math.max(0.2, params.gatehouseScale);

  // ── Gates: where a sketched ROAD crosses the spine (deterministic order:
  //    collect every crossing, sort by position, dedupe within a gate width) ──
  const idx = indexFabricConstraints(constraints.fabricFeatures);
  const rawGates: Pt[] = [];
  for (const road of idx.roadLines) {
    for (let i = 0; i < road.length - 1; i++) {
      for (let k = 0; k < pts.length - 1; k++) {
        const hit = segCross(road[i], road[i + 1], pts[k], pts[k + 1]);
        if (hit) rawGates.push([q(hit[0]), q(hit[1])]);
      }
    }
  }
  rawGates.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const gates: Pt[] = [];
  for (const g of rawGates) {
    if (gates.some(([gx, gy]) => Math.hypot(gx - g[0], gy - g[1]) < gateHalf)) continue;
    gates.push(g);
  }
  const nearGate = (x: number, y: number): boolean =>
    gates.some(([gx, gy]) => Math.hypot(gx - x, gy - y) < gateHalf);

  // ── Masonry band: per-segment resampled quads, gapped at gate openings ─────
  for (let k = 0; k < pts.length - 1; k++) {
    const a = pts[k];
    const b = pts[k + 1];
    const segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (segLen <= 0) continue;
    const [ux, uy] = unit(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(1, Math.ceil(segLen / RESAMPLE_STEP_M));
    for (let j = 0; j < steps; j++) {
      const s0 = (j * segLen) / steps;
      const s1 = ((j + 1) * segLen) / steps;
      const p0: Pt = [a[0] + ux * s0, a[1] + uy * s0];
      const p1: Pt = [a[0] + ux * s1, a[1] + uy * s1];
      const mx = (p0[0] + p1[0]) / 2;
      const my = (p0[1] + p1[1]) / 2;
      if (nearGate(mx, my)) continue; // gate opening — a break in the wall
      out.push(spanQuad(seed, "wall-quad", p0, p1, WALL_HALF_WIDTH_M, { wallStyle: params.style }));
    }
  }

  // ── Moat: an outboard channel offset to the spine's left normal, gapped at
  //    gates (where a causeway/bridge crosses). One side only — an open line
  //    has no inside/outside, so the left normal is the deterministic choice
  //    (a v1 judgment call, logged). Offset per-segment, matching the band. ──
  if (params.moat) {
    const centerOff = WALL_HALF_WIDTH_M + MOAT_GAP_M + MOAT_WIDTH_M / 2;
    const moatHalf = MOAT_WIDTH_M / 2;
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k];
      const b = pts[k + 1];
      const segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (segLen <= 0) continue;
      const [ux, uy] = unit(b[0] - a[0], b[1] - a[1]);
      const nx = -uy;
      const ny = ux;
      const steps = Math.max(1, Math.ceil(segLen / RESAMPLE_STEP_M));
      for (let j = 0; j < steps; j++) {
        const s0 = (j * segLen) / steps;
        const s1 = ((j + 1) * segLen) / steps;
        const c0: Pt = [a[0] + ux * s0 + nx * centerOff, a[1] + uy * s0 + ny * centerOff];
        const c1: Pt = [a[0] + ux * s1 + nx * centerOff, a[1] + uy * s1 + ny * centerOff];
        const mx = (a[0] + ux * ((s0 + s1) / 2));
        const my = (a[1] + uy * ((s0 + s1) / 2));
        if (nearGate(mx, my)) continue; // causeway break
        out.push(spanQuad(seed, "wall-moat", c0, c1, moatHalf, { wallStyle: params.style }));
      }
    }
  }

  // ── Towers: seeded per-segment PHASE (identity keying, plan 022 §3.4) — the
  //    along-run field a re-roll must shift but an edit must keep off the two
  //    adjacent segments. Palisades carry no towers. ────────────────────────
  if (params.style !== "palisade") {
    const spacing = Math.max(MIN_TOWER_SPACING_M, params.towerSpacing);
    const half = towerHalf(params);
    const diamond = params.style === "bastioned";
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k];
      const b = pts[k + 1];
      const segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (segLen < MIN_TOWER_SEG_LEN_M) continue;
      const [ux, uy] = unit(b[0] - a[0], b[1] - a[1]);
      // Seeded phase in [0, spacing), keyed on THIS segment's quantized
      // endpoints — the meander-identity trick applied to tower placement.
      const rng = mulberry32(hashSeed(seed, "wall-tower-phase", a[0], a[1], b[0], b[1]));
      const phase = rng() * spacing;
      for (let s = phase; s < segLen - MIN_TOWER_SEG_LEN_M / 2; s += spacing) {
        if (s <= 0) continue;
        const cx = a[0] + ux * s;
        const cy = a[1] + uy * s;
        if (nearGate(cx, cy)) continue; // no tower blocking a gate
        out.push(towerFeature(seed, "wall-tower", cx, cy, ux, uy, half, diamond, params.style));
      }
    }
    // Corner accents at interior vertices: a bastion (bastioned) or a corner
    // tower (curtain) at each bend — keyed on the vertex position, so an edit
    // moves only the edited corner's accent. The angular star-fort read of a
    // bastioned trace comes from these + the GM's angular sketch.
    for (let k = 1; k < pts.length - 1; k++) {
      const v = pts[k];
      const [ux, uy] = unit(pts[k + 1][0] - pts[k - 1][0], pts[k + 1][1] - pts[k - 1][1]);
      const cornerHalf = diamond ? BASTION_HALF_M : CORNER_TOWER_HALF_M;
      out.push(towerFeature(seed, "wall-tower", v[0], v[1], ux, uy, cornerHalf, diamond, params.style));
    }
  }

  // ── Gate markers: a small stone dot where an arterial pierces the wall
  //    (never a Location pin) — mirrors the city's `gate` points. ───────────
  for (const [gx, gy] of gates) {
    out.push({
      type: "Feature",
      id: hashSeed(seed, "wall-gate", q(gx), q(gy)),
      geometry: { type: "Point", coordinates: [q(gx), q(gy)] },
      properties: { generatorId: "wall-gate", type: "wall-gate", wallStyle: params.style },
    });
  }

  return out;
}
