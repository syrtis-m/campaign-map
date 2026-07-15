/**
 * Wall generator — the second LINE-kind procgen algorithm (river was the
 * first). Pure/headless (no DOM/map/Obsidian imports; reads only its
 * arguments): a sketched `wall` LINE is the SPINE; this elaborates it into a
 * masonry band, towers, gates, an optional moat and an outboard earthwork
 * glacis apron — all strictly inside the spine corridor.
 *
 * Determinism:
 *  - Closed-form arithmetic on a mm-quantized spine, seeded only by
 *    `hashSeed(seed, salt, quantized positions)`; every emitted coordinate is
 *    mm-quantized before it leaves.
 *  - Identity property (same discipline as the river meander): each ORIGINAL
 *    spine segment's tower run gets a seeded PHASE hashed on THAT segment's
 *    quantized endpoints — never global arc-length. So a single-vertex edit
 *    re-phases ONLY the two adjacent segments (their towers shift); every other
 *    segment's towers are unchanged. A re-roll (new seed) re-phases every
 *    segment (tower-bucket overlap away from an edit ≫ overlap under re-roll).
 *    Corner accents key on the vertex position, so only the moved corner's
 *    accent changes on an edit.
 *  - Gates are where a sketched ROAD crosses the spine (against
 *    `constraints.fabricFeatures` roadLines — NOT the generated city streets:
 *    reading another generator's output is forbidden here, exactly as the river
 *    defers channel→constraint). A crossing is a closed-form segment/segment
 *    solve on quantized geometry.
 *  - Containment: every lateral displacement term is bounded by a params-only
 *    constant, and `wallMaxOffset(params)` is their max + margin, so all output
 *    sits strictly within the corridor. A moat/wider-tower params change widens
 *    the corridor, never violates it.
 *  - Feature ids hash on POSITION (never emission order), integers so
 *    `clipNetworkToTile`'s `Number(id)` sort/clip stays deterministic.
 *
 * Double-wall resolution does NOT live here — wall elaboration is stage 4 (AFTER
 * the city), so its output cannot legally constrain city generation. The
 * suppression signal is the RAW wall SKETCH, read by the CITY (stage 3) via
 * `constraints.fabricFeatures`: see `buildWall` in `citynet/skeleton.ts`, which
 * drops its own wall-band segments that run alongside a sketched wall. This
 * generator just decorates the GM's line.
 */
import { hashSeed, mulberry32 } from "./rng";
import { q, quad, spanQuad } from "./waterEmit";
import { indexFabricConstraints, nearestOnLine } from "./fabricConstraints";
import { buildSettlementPayload, buildUpstreamWaterField } from "./upstream";
import type { ProcgenRegion } from "./region";
import type { GenerationConstraints } from "./types";

type Pt = [number, number];

export const WALL_STYLES = ["curtain-wall", "palisade", "bastioned"] as const;
export type WallStyle = (typeof WALL_STYLES)[number];

/** Wall params. `style` drives layout AND is carried onto every
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
const GLACIS_GAP_M = 3; // gap from the moat/band outer edge to the glacis inner edge
const GLACIS_WIDTH_M = 10; // earthwork apron width (≈1.7× the 6 m masonry band)
const GATE_HALF_M = 6; // gate opening half-length along the wall (× gatehouseScale)
const CORRIDOR_MARGIN_M = 4;
const MIN_TOWER_SPACING_M = 15; // clamp — a denser spacing would carpet the wall
const MIN_TOWER_SEG_LEN_M = 12; // segments shorter than this carry no along-run towers
// ── Settlement payload coupling (plan 037 item 4, city → wall) ────────────────
// A gate falls where a GENERATED street crosses the spine, alongside the
// sketched-road crossings. Higher street class wins a min-spacing merge; the
// gatehouse axis is the crossing street's bearing. All keyed on the generated
// geometry (`upstream.settlement`); with NO settlement the wall is byte-identical
// (sketched-road gates only). Moat + masonry gap over water (the generated
// channel + city canals) — the river-is-the-moat case.
const CANAL_HALF_M = 15; // a city canal line reads as water within this half-width
/** Street-class precedence for the gate merge (higher wins); a sketched road is
 * the floor. */
function gateRank(roadClass: string | null): number {
  switch (roadClass) {
    case "arterial":
      return 5;
    case "ring":
      return 4;
    case "boulevard":
      return 3;
    case "street":
      return 2;
    case "alley":
      return 1;
    default:
      return 0; // sketched road
  }
}

/** A candidate gate: crossing point, the crossing street's bearing (null for a
 * sketched road — keeps its marker byte-identical to today), class rank + name. */
interface WallGate {
  p: Pt;
  bearing: number | null;
  rank: number;
  roadClass: string | null;
}

/** Along-segment / gatehouse tower half-extent for `style` (0 = palisade). */
function towerHalf(params: WallParams): number {
  if (params.style === "palisade") return 0;
  return params.style === "bastioned" ? BASTION_HALF_M : TOWER_HALF_M;
}

function gatehouseHalf(params: WallParams): number {
  return TOWER_HALF_M * (0.8 + 0.6 * Math.max(0, params.gatehouseScale));
}

/**
 * Corridor half-width: a pure, monotonic function of the params.
 * Every emitted point sits at most this far from the spine, so it is a strict
 * upper bound on how far output leaves the sketched line. The outboard glacis
 * apron is the outermost band (beyond the moat where present), so it sets the
 * floor: even a palisade (no towers, no moat) reaches the glacis. Adding a moat
 * pushes the glacis — and the corridor — further out.
 */
export function wallMaxOffset(params: WallParams): number {
  const bandHalf = WALL_HALF_WIDTH_M;
  const towers = Math.max(towerHalf(params), gatehouseHalf(params));
  const moat = params.moat ? bandHalf + MOAT_GAP_M + MOAT_WIDTH_M : 0;
  // Glacis inner edge sits just outside the moat (or the band when there is no
  // moat); its outer edge is the widest point of the whole wall.
  const glacisInner = params.moat ? bandHalf + MOAT_GAP_M + MOAT_WIDTH_M : bandHalf;
  const glacis = glacisInner + GLACIS_GAP_M + GLACIS_WIDTH_M;
  return q(Math.max(bandHalf, towers, moat, glacis) + CORRIDOR_MARGIN_M);
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

/** Bisect a spine sub-segment `[p0,p1]` that straddles the channel bank (the
 * water SDF changes sign along it) to the point where the field ≈ 0 — the bank
 * crossing. Fixed 24-iteration binary search (deterministic, mm-resolvable). */
function bisectBank(field: (x: number, y: number) => number, p0: Pt, p1: Pt): Pt {
  let a = p0;
  let b = p1;
  const insideA = field(a[0], a[1]) >= 0;
  for (let it = 0; it < 24; it++) {
    const m: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if ((field(m[0], m[1]) >= 0) === insideA) a = m;
    else b = m;
  }
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

/** Bisect a segment `[dry,wet]` (dry point outside water, wet point inside) to
 * the DRY side of the water boundary — the last point just outside the bank.
 * Deterministic fixed-iteration search; returns the dry endpoint so a snapped
 * moat quad ends AT the bank without poking into the channel. */
function snapToWaterEdge(inWater: (x: number, y: number) => boolean, dry: Pt, wet: Pt): Pt {
  let d = dry;
  let w = wet;
  for (let it = 0; it < 24; it++) {
    const m: Pt = [(d[0] + w[0]) / 2, (d[1] + w[1]) / 2];
    if (inWater(m[0], m[1])) w = m;
    else d = m;
  }
  return d;
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
 * Generate a wall inside a spine corridor. `region.spine` is the
 * mm-quantized sketched polyline; output is the masonry band (`wall-quad`),
 * `wall-tower` footprints, `wall-gate` markers where a sketched road crosses,
 * an outboard earthwork `wall-glacis` apron, and (when `moat`) a `wall-moat`
 * channel — all strictly within `wallMaxOffset(params)` of the spine.
 * `constraints.fabricFeatures` (gen-space meters) supplies the crossing ROADS
 * for gates.
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

  // Settlement payload + water (plan 037 item 4). Both null with no upstream ⇒
  // the wall is byte-identical to today (sketched-road gates, left-normal moat,
  // no water gaps).
  const settlement = buildSettlementPayload(constraints.upstream);
  const waterField = buildUpstreamWaterField(constraints.upstream);
  const canalLines = settlement?.canalLines ?? [];
  const inWater = (x: number, y: number): boolean => {
    if (waterField && waterField(x, y) >= 0) return true;
    for (const c of canalLines) if (c.length >= 2 && nearestOnLine(c, x, y).dist < CANAL_HALF_M) return true;
    return false;
  };

  // ── Gates: where a sketched ROAD or a GENERATED street crosses the spine.
  //    Collect every crossing, then greedily merge within a gate width keeping
  //    the HIGHER street class (arterial > ring > … > sketched road). Processing
  //    highest-rank-first makes the merge deterministic and, when there is no
  //    settlement (all rank 0), reduces to today's sort-by-position dedupe. ──
  const idx = indexFabricConstraints(constraints.fabricFeatures);
  const raw: WallGate[] = [];
  for (const road of idx.roadLines) {
    for (let i = 0; i < road.length - 1; i++) {
      for (let k = 0; k < pts.length - 1; k++) {
        const hit = segCross(road[i], road[i + 1], pts[k], pts[k + 1]);
        if (hit) raw.push({ p: [q(hit[0]), q(hit[1])], bearing: null, rank: 0, roadClass: null });
      }
    }
  }
  for (const s of settlement?.streets ?? []) {
    const line = s.line;
    for (let i = 0; i < line.length - 1; i++) {
      for (let k = 0; k < pts.length - 1; k++) {
        const hit = segCross(line[i], line[i + 1], pts[k], pts[k + 1]);
        if (!hit) continue;
        const bearing = Math.atan2(line[i + 1][1] - line[i][1], line[i + 1][0] - line[i][0]);
        raw.push({ p: [q(hit[0]), q(hit[1])], bearing, rank: gateRank(s.roadClass), roadClass: s.roadClass });
      }
    }
  }
  // Highest rank first, then position — a total order (D2). Greedy merge keeps
  // the first (highest-class) hit in each min-spacing cluster.
  raw.sort((a, b) => b.rank - a.rank || a.p[0] - b.p[0] || a.p[1] - b.p[1]);
  const gates: WallGate[] = [];
  for (const g of raw) {
    if (gates.some((h) => Math.hypot(h.p[0] - g.p[0], h.p[1] - g.p[1]) < gateHalf)) continue;
    gates.push(g);
  }
  const nearGate = (x: number, y: number): boolean =>
    gates.some((g) => Math.hypot(g.p[0] - x, g.p[1] - y) < gateHalf);

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
      // Masonry gap over water (river-is-the-moat): drop the segment if its
      // midpoint OR either endpoint falls in the channel/canal, so the quad
      // (±half wide) never straddles the bank.
      if (inWater(mx, my) || inWater(p0[0], p0[1]) || inWater(p1[0], p1[1])) continue;
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
    const interior = settlement?.interior ?? null;
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k];
      const b = pts[k + 1];
      const segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (segLen <= 0) continue;
      const [ux, uy] = unit(b[0] - a[0], b[1] - a[1]);
      // Moat side = AWAY from the town interior (plan 037): the left normal
      // (−uy,ux) is the default (v1 arbitrary choice); when the settlement
      // payload gives an interior reference, flip to whichever side points away
      // from it. No settlement ⇒ left normal, byte-identical to today.
      let nx = -uy;
      let ny = ux;
      if (interior) {
        const mmx = (a[0] + b[0]) / 2;
        const mmy = (a[1] + b[1]) / 2;
        if (nx * (interior[0] - mmx) + ny * (interior[1] - mmy) > 0) {
          nx = -nx;
          ny = -ny;
        }
      }
      const steps = Math.max(1, Math.ceil(segLen / RESAMPLE_STEP_M));
      for (let j = 0; j < steps; j++) {
        const s0 = (j * segLen) / steps;
        const s1 = ((j + 1) * segLen) / steps;
        const c0: Pt = [a[0] + ux * s0 + nx * centerOff, a[1] + uy * s0 + ny * centerOff];
        const c1: Pt = [a[0] + ux * s1 + nx * centerOff, a[1] + uy * s1 + ny * centerOff];
        const mx = a[0] + ux * ((s0 + s1) / 2);
        const my = a[1] + uy * ((s0 + s1) / 2);
        if (nearGate(mx, my)) continue; // causeway break
        // Moat/masonry gap over water (river-is-the-moat): the moat centerline is
        // gapped over the generated channel/canal. Plan 038 item 8 — moat-END SNAP
        // TO THE BANK: a step that STRADDLES the water boundary is clipped to the
        // bank along the moat centerline (a leat junction) instead of being
        // dropped wholesale, so the moat reaches the river cleanly rather than
        // ending a resample-step short. Fully-dry ⇒ full quad; fully-wet ⇒ skip.
        // With NO water in reach `inWater` is always false ⇒ every step is dry ⇒
        // byte-identical to the uncoupled moat.
        const w0 = inWater(c0[0], c0[1]);
        const w1 = inWater(c1[0], c1[1]);
        if (w0 && w1) continue; // fully in the water — the river is the moat here
        if (!w0 && !w1) {
          out.push(spanQuad(seed, "wall-moat", c0, c1, moatHalf, { wallStyle: params.style }));
          continue;
        }
        // Straddle: snap the wet end back to the water boundary (the bank),
        // draw the dry sub-span up to it (`leat: true` marks the junction quad).
        const bank = snapToWaterEdge(inWater, w0 ? c1 : c0, w0 ? c0 : c1);
        const dryEnd = w0 ? c1 : c0;
        if (Math.hypot(bank[0] - dryEnd[0], bank[1] - dryEnd[1]) < 0.5) continue;
        out.push(spanQuad(seed, "wall-moat", dryEnd, bank, moatHalf, { wallStyle: params.style, leat: true }));
      }
    }
  }

  // ── Glacis: an outboard earthwork APRON — the last, sloping defensive band
  //    beyond the wall. It sits OUTSIDE the moat where present (else just outside
  //    the masonry band), on the SAME away-from-interior side as the moat, ~1.7×
  //    the masonry band wide. Like the band it gaps at gate openings (the road
  //    ramps through) and over GENERATED water (river-is-the-moat — the apron
  //    never spans the channel/canal). Emitted for every style (an earthwork
  //    apron is style-agnostic); its far edge is bounded by `wallMaxOffset`, so a
  //    wall with NO settlement AND no water gains ONLY this band and is otherwise
  //    byte-identical to the pre-glacis output. Side selection mirrors the moat:
  //    left normal by default, flipped away from the town interior when the
  //    settlement payload names one. ─────────────────────────────────────────────
  {
    const glacisHalf = GLACIS_WIDTH_M / 2;
    const innerBase = params.moat ? WALL_HALF_WIDTH_M + MOAT_GAP_M + MOAT_WIDTH_M : WALL_HALF_WIDTH_M;
    const centerOff = innerBase + GLACIS_GAP_M + glacisHalf;
    const interior = settlement?.interior ?? null;
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k];
      const b = pts[k + 1];
      const segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (segLen <= 0) continue;
      const [ux, uy] = unit(b[0] - a[0], b[1] - a[1]);
      let nx = -uy;
      let ny = ux;
      if (interior) {
        const mmx = (a[0] + b[0]) / 2;
        const mmy = (a[1] + b[1]) / 2;
        if (nx * (interior[0] - mmx) + ny * (interior[1] - mmy) > 0) {
          nx = -nx;
          ny = -ny;
        }
      }
      const steps = Math.max(1, Math.ceil(segLen / RESAMPLE_STEP_M));
      for (let j = 0; j < steps; j++) {
        const s0 = (j * segLen) / steps;
        const s1 = ((j + 1) * segLen) / steps;
        const c0: Pt = [a[0] + ux * s0 + nx * centerOff, a[1] + uy * s0 + ny * centerOff];
        const c1: Pt = [a[0] + ux * s1 + nx * centerOff, a[1] + uy * s1 + ny * centerOff];
        // Gate proximity is measured on the SPINE (the causeway axis), like the
        // band/moat; a straddled gate opening breaks the apron too.
        const smx = a[0] + ux * ((s0 + s1) / 2);
        const smy = a[1] + uy * ((s0 + s1) / 2);
        if (nearGate(smx, smy)) continue;
        // Skip water gaps like the band: drop a step whose apron centerline (mid
        // or either end) falls in the channel/canal, so the quad never spans the
        // bank. With NO water in reach `inWater` is always false ⇒ every step is
        // dry ⇒ the apron is a plain continuous band.
        const mx = (c0[0] + c1[0]) / 2;
        const my = (c0[1] + c1[1]) / 2;
        if (inWater(mx, my) || inWater(c0[0], c0[1]) || inWater(c1[0], c1[1])) continue;
        out.push(spanQuad(seed, "wall-glacis", c0, c1, glacisHalf, { wallStyle: params.style }));
      }
    }
  }

  // ── Towers: seeded per-segment PHASE (identity keying) — the
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
        if (inWater(cx, cy)) continue; // no tower standing in the channel
        out.push(towerFeature(seed, "wall-tower", cx, cy, ux, uy, half, diamond, params.style));
      }
    }
    // Corner accents at interior vertices: a bastion (bastioned) or a corner
    // tower (curtain) at each bend — keyed on the vertex position, so an edit
    // moves only the edited corner's accent. The angular star-fort read of a
    // bastioned trace comes from these + the GM's angular sketch.
    for (let k = 1; k < pts.length - 1; k++) {
      const v = pts[k];
      if (inWater(v[0], v[1])) continue; // no corner tower in the channel
      const [ux, uy] = unit(pts[k + 1][0] - pts[k - 1][0], pts[k + 1][1] - pts[k - 1][1]);
      const cornerHalf = diamond ? BASTION_HALF_M : CORNER_TOWER_HALF_M;
      out.push(towerFeature(seed, "wall-tower", v[0], v[1], ux, uy, cornerHalf, diamond, params.style));
    }
  }

  // ── Gate markers: a small stone dot where a road/arterial pierces the wall
  //    (never a Location pin) — mirrors the city's `gate` points. A gate from a
  //    GENERATED street additionally carries its crossing `bearing` + `roadClass`
  //    (the gatehouse axis) and grows a gatehouse tower aligned to that bearing;
  //    a sketched-road gate keeps its today-identical marker (no extra props, no
  //    gatehouse) — the no-settlement byte-identity. ────────────────────────────
  const ghHalf = gatehouseHalf(params);
  const diamond = params.style === "bastioned";
  for (const g of gates) {
    const [gx, gy] = g.p;
    const props: Record<string, unknown> = { generatorId: "wall-gate", type: "wall-gate", wallStyle: params.style };
    if (g.bearing !== null) {
      props.bearing = q(g.bearing);
      if (g.roadClass) props.roadClass = g.roadClass;
    }
    out.push({
      type: "Feature",
      id: hashSeed(seed, "wall-gate", q(gx), q(gy)),
      geometry: { type: "Point", coordinates: [q(gx), q(gy)] },
      properties: props,
    });
    // Gatehouse (generated gates only): a tower straddling the spine at the gate,
    // its axis the crossing street's bearing (the gate faces the road).
    // palisades carry no towers, so no gatehouse either.
    if (g.bearing !== null && params.style !== "palisade") {
      const gux = Math.cos(g.bearing);
      const guy = Math.sin(g.bearing);
      const f = towerFeature(seed, "wall-tower", gx, gy, gux, guy, ghHalf, diamond, params.style);
      (f.properties as Record<string, unknown>).gatehouse = true;
      out.push(f);
    }
  }

  // ── Water gates + leats (plan 038 item 8): where the spine crosses GENERATED
  //    water (the river channel or a city canal), a water-gate (sluice) marker
  //    sits at the bank crossing (`waterGate: true` — a distinct feature themes
  //    paint as a river-gate, never a road gatehouse), and — when a moat runs — a
  //    short leat quad snaps the offset moat channel to that bank crossing (the
  //    moat joins the river, the leat junction). Both are gated on upstream water:
  //    with NO channel AND no canal the whole block is skipped ⇒ byte-identical to
  //    the uncoupled wall (the band already gaps over water via `inWater`; this
  //    only ADDS the marker + leat where the spine actually crosses). ────────────
  const hasWater = waterField !== null || canalLines.length > 0;
  if (hasWater) {
    const waterGates: Pt[] = [];
    const addWaterGate = (p: Pt): void => {
      const qp: Pt = [q(p[0]), q(p[1])];
      // Dedupe among water gates AND against a road/street gate already here (a
      // road bridge over the same crossing keeps its road gate; no double marker).
      if (waterGates.some((w) => Math.hypot(w[0] - qp[0], w[1] - qp[1]) < gateHalf)) return;
      if (gates.some((h) => Math.hypot(h.p[0] - qp[0], h.p[1] - qp[1]) < gateHalf)) return;
      waterGates.push(qp);
    };
    // Channel bank crossings: resample each spine segment, detect a sign
    // transition of the water SDF (outside < 0 ⇄ inside ≥ 0), bisect the bank.
    if (waterField) {
      for (let k = 0; k < pts.length - 1; k++) {
        const a = pts[k];
        const b = pts[k + 1];
        const segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (segLen <= 0) continue;
        const steps = Math.max(1, Math.ceil(segLen / RESAMPLE_STEP_M));
        let prev: Pt = a;
        let prevIn = waterField(a[0], a[1]) >= 0;
        for (let j = 1; j <= steps; j++) {
          const t = j / steps;
          const cur: Pt = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
          const curIn = waterField(cur[0], cur[1]) >= 0;
          if (curIn !== prevIn) addWaterGate(bisectBank(waterField, prev, cur));
          prev = cur;
          prevIn = curIn;
        }
      }
    }
    // Canal crossings: proper segment/segment intersection (canals are lines).
    for (const c of canalLines) {
      for (let i = 0; i < c.length - 1; i++) {
        for (let k = 0; k < pts.length - 1; k++) {
          const hit = segCross(c[i], c[i + 1], pts[k], pts[k + 1]);
          if (hit) addWaterGate(hit);
        }
      }
    }
    // Water-gate markers (position-hashed id, like every gate).
    for (const wg of waterGates) {
      out.push({
        type: "Feature",
        id: hashSeed(seed, "wall-water-gate", wg[0], wg[1]),
        geometry: { type: "Point", coordinates: [wg[0], wg[1]] },
        properties: { generatorId: "wall-gate", type: "wall-gate", wallStyle: params.style, waterGate: true },
      });
    }
  }

  return out;
}
