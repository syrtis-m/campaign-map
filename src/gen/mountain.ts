/**
 * Mountain generator (plan 023 §3) — wires up the new `mountain` polygon kind.
 * Pure/headless (no DOM/map/Obsidian imports; reads only its arguments, D6): a
 * sketched `mountain` polygon is the region; this fills it with cartographic
 * relief derived from a point-evaluable elevation field (the gradient-damped
 * fBm of `fields/elevation.ts`, masked to the sketched ring):
 *
 *  - `mountain-massif`  — the sketched ring as a rocky-ground base wash (one
 *                         polygon; contained by construction).
 *  - `mountain-hachure` — short downslope tick marks on an absolute-world
 *                         lattice, ORIENTED by the field's analytic gradient
 *                         (the load-bearing consumer of `valueNoise2DWithDeriv`
 *                         — the derivative earns its place this phase) and
 *                         LENGTH ∝ local slope. Classic relief hachures.
 *  - `mountain-peak`    — summit markers at lattice local-maxima of the field
 *                         above a per-terrain threshold (elevation + sizeN).
 *  - `mountain-contour` — topographic iso-lines (marching squares, plan 023
 *                         §4.1) traced over the SAME elevation field on a
 *                         world-aligned lattice, clipped to the ring. Emitted
 *                         when an EXISTING mountain (re)generates — NO new
 *                         request surface, no contour-only trigger: contours
 *                         derive from the mountain region's elevation field.
 *                         The campaign-base field is deferred to plan 024, so a
 *                         sketched mountain is the only elevation source in
 *                         23-C; §4.1's field-tier world-manifest contours
 *                         generalize there once that field exists.
 *
 * DEM/hillshade/3D (§4.2) are a LATER phase; the mountain kind renders
 * self-contained relief + contours now.
 *
 * Three terrain types (a `terrain` param, never a presetId — mirrors the city
 * algorithm's `profile` / park's `variety` / farmland's `fieldType`): `alpine`
 * (ridged, steep, many sharp peaks), `mesa` (terraced — flat tops, cliff
 * risers), `rolling-hills` (low octaves, gentle, few rounded summits). `terrain`
 * is carried onto every feature for theme tinting, never a runtime branch in the
 * paint.
 *
 * Determinism (procgen_v3_design.md §4):
 *  - The elevation field is `f(regionSeed, position)` — the persisted procgen
 *    seed drives the fBm, so a vertex edit KEEPS identity (same seed → same
 *    field) while only the mask boundary adapts; an explicit re-roll (new seed)
 *    replaces the whole relief. (Deviation from §3's campaign-wide
 *    `f(campaignSeed,…)` phrasing: the region-generator signature hands only
 *    the region seed, and campaign-wide summation is plan 024 stage 0 — flagged
 *    in the phase report; `ElevationField` is exposed in the shape 024 composes.)
 *  - Hachures/peaks key on ABSOLUTE-WORLD lattice indices (like farmland's
 *    fields / orchard rows), so the mask saturates to 1 deep inside (grad 0) and
 *    every interior tick/peak is byte-identical under a rim vertex edit — only
 *    boundary nodes appear/disappear (the forest/farmland identity property;
 *    measured in the gate: edit overlap ≫ re-roll overlap). A bbox-derived
 *    lattice would shift under an edit → edit indistinguishable from re-roll.
 *  - D5: every emitted coordinate is mm-quantized. Feature ids hash POSITION
 *    (lattice indices), never emission order, integer so `clipNetworkToTile`'s
 *    `Number(id)` sort stays stable.
 *  - Containment: hachure ticks emit only when both endpoints are ≥ margin
 *    inside AND the tick doesn't cross the boundary (concave-safe); peaks/massif
 *    are contained by construction. Rim ticks drop → graceful degradation.
 *
 * Constraints are accepted for signature parity, never consumed (a mountain is
 * base terrain — it never sees the city, like forest/park/farmland).
 */
import { hashSeed, mulberry32 } from "./rng";
import {
  distanceToBoundary,
  segmentCrossesBoundary,
  clipPolylineToRegion,
  type ProcgenRegion,
} from "./region";
import { sdfPolygon, fMask, marchingSquares } from "./fields";
import { fbmEroded, type HeightSample, type ElevationField } from "./fields/elevation";
import {
  // The elevation-field internals moved VERBATIM to fields/mountainField.ts in
  // box 23-E (shared-field rule: farmland/river read the mountain elevation
  // through fields/, never by importing this generator). Re-exported below so
  // every existing import path (registry, MapController, tests) is unchanged —
  // the 23-A verbatim-move technique; mountain output stays byte-identical.
  MOUNTAIN_TERRAINS,
  type MountainTerrain,
  type MountainParams,
  AMP_MIN_M,
  AMP_MAX_M,
  BASE_CELL_M,
  MASK_BAND_M,
  terrainConfig,
  terrace,
  clamp01,
  mountainHeightField,
} from "./fields/mountainField";
import { q } from "./waterEmit";
import type { GenerationConstraints } from "./types";

type Pt = [number, number];

export { MOUNTAIN_TERRAINS, terrace, mountainHeightField };
export type { MountainTerrain, MountainParams };

// ── World-aligned lattice spacings (meters), absolute so edits stay local ────
const HACHURE_M = 26; // downslope tick spacing (sparse enough to read as strokes)
const PEAK_M = 45; // peak-search lattice (coarser than hachures)
const CONTAIN_MARGIN_M = 1; // keep ticks a hair clear of the boundary
// Hachure tick geometry.
const TICK_MIN_M = 7;
const TICK_MAX_M = 24;
const TICK_JITTER_M = 5; // hashed per-node start jitter (breaks the grid look)
// Near-flat gate: skip ticks where the SMOOTH relief is essentially level.
const FLAT_GATE = 0.00025;
// ── Contours (plan 023 §4.1) ─────────────────────────────────────────────────
// World-aligned marching-squares lattice for iso-lines. 20 m per §4.1 — fine
// enough that terrace risers read as bunched bands, coarse enough to stay cheap
// (region generation is explicit + cached, never per-frame). ABSOLUTE-world so
// abutting mountains agree on shared samples (seam rule) and edits stay local.
const CONTOUR_LATTICE_M = 20;
// Every MAJOR_EVERY-th contour (counting from the sea-level datum) is a "major"
// index line — themes paint it heavier. 5 is the standard topographic cadence.
const MAJOR_EVERY = 5;
// The contour interval (meters of relief between iso-lines) is chosen per region
// to yield ~CONTOUR_TARGET_BANDS lines across its amplitude — consistent visual
// density whatever the amplitude, snapped to a "nice" round number so the datum
// stays cartographically honest. Pure f(amplitude) ⇒ deterministic.
const CONTOUR_TARGET_BANDS = 15;
const CONTOUR_INTERVAL_LADDER = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000] as const;

/** Nice-round contour interval (meters) for a relief amplitude `A`. Smallest
 * ladder value giving ≤ CONTOUR_TARGET_BANDS lines; the coarsest as a floor. */
function contourInterval(A: number): number {
  const raw = A / CONTOUR_TARGET_BANDS;
  for (const step of CONTOUR_INTERVAL_LADDER) if (step >= raw) return step;
  return CONTOUR_INTERVAL_LADDER[CONTOUR_INTERVAL_LADDER.length - 1];
}

/** Normalized shape value (mask·terrace(fbm), 0..1) — the peak/threshold space,
 * independent of the amplitude in meters. */
function shapeValue(seed: number, region: ProcgenRegion, params: MountainParams): (x: number, y: number) => number {
  const cfg = terrainConfig(params.terrain);
  const roughness = clamp01(params.roughness);
  const octaves = cfg.octavesBase + Math.round(roughness * 2);
  const mask = fMask(sdfPolygon(region.ring), MASK_BAND_M);
  const opts = { octaves, damping: cfg.damping, ridged: cfg.ridged, baseCell: BASE_CELL_M, salt: "mtn-elev" };
  return (x, y) => mask(x, y) * terrace(fbmEroded(seed, x, y, opts).v, cfg.terraceSteps);
}

/**
 * Generate mountain relief inside a sketched polygon region (plan 023 §3).
 * Emits `mountain-massif` (1 polygon), `mountain-hachure` (downslope ticks) and
 * `mountain-peak` (summit points) — all strictly inside `region.ring`.
 * `_constraints` accepted for signature parity, never consumed (a mountain is
 * base terrain — it never sees the city).
 */
export function generateMountain(
  seed: number,
  region: ProcgenRegion,
  params: MountainParams,
  _constraints: GenerationConstraints
): GeoJSON.Feature[] {
  const { terrain } = params;
  const cfg = terrainConfig(params.terrain);
  const out: GeoJSON.Feature[] = [];
  const bbox = region.bbox;
  const amplitude = clamp01(params.amplitude);
  const A = AMP_MIN_M + amplitude * (AMP_MAX_M - AMP_MIN_M);

  const field = mountainHeightField(seed, region, params);
  const shape = shapeValue(seed, region, params);
  // Mask reused for the fade multiplier on tick length / density.
  const mask = fMask(sdfPolygon(region.ring), MASK_BAND_M);
  // Hachure ORIENTATION comes from a SMOOTH low-octave gradient, not the full
  // field: with gain 0.5 / lacunarity 2 every octave contributes equally to the
  // gradient, so the full-detail gradient points every-which-way (scratchy
  // noise, not relief). A 2–3 octave field follows the MAJOR slopes, so ticks
  // comb down the ridgelines/valleys — the classic hachure read. (Peaks + the
  // reported height still use the full-detail field.)
  const orientOctaves = cfg.ridged ? 3 : 2;
  const orient = (x: number, y: number): { dx: number; dy: number } => {
    const n = fbmEroded(seed, x, y, { octaves: orientOctaves, damping: 0, ridged: false, baseCell: BASE_CELL_M, salt: "mtn-elev" });
    return { dx: n.dx, dy: n.dy };
  };

  // ── Massif: the sketched ring as a rocky-ground base wash. Contained by
  //    construction (it IS the ring, already normalized + mm-quantized). ──────
  out.push({
    type: "Feature",
    id: hashSeed(seed, "mountain-massif", region.id),
    geometry: { type: "Polygon", coordinates: [region.ring.map(([x, y]) => [q(x), q(y)] as Pt)] },
    properties: { generatorId: "mountain-massif", type: "mountain-massif", terrain },
  });

  // ── Hachures: downslope ticks on the absolute-world lattice, oriented by the
  //    field gradient, length ∝ slope. Flats (slope < gate) stay bare. ────────
  const hx0 = Math.floor(bbox.minX / HACHURE_M) - 1;
  const hx1 = Math.ceil(bbox.maxX / HACHURE_M) + 1;
  const hy0 = Math.floor(bbox.minY / HACHURE_M) - 1;
  const hy1 = Math.ceil(bbox.maxY / HACHURE_M) + 1;
  for (let ix = hx0; ix <= hx1; ix++) {
    if (((ix % cfg.hachureStride) + cfg.hachureStride) % cfg.hachureStride !== 0) continue;
    for (let iy = hy0; iy <= hy1; iy++) {
      if (((iy % cfg.hachureStride) + cfg.hachureStride) % cfg.hachureStride !== 0) continue;
      const nx = ix * HACHURE_M;
      const ny = iy * HACHURE_M;
      const m = mask(nx, ny);
      if (m < 0.15) continue; // outside / in the edge fade
      const g = orient(nx, ny);
      // Smooth-relief slope (meters-per-meter, deriv carries the 1/cell factor).
      const gmag = Math.hypot(g.dx, g.dy);
      if (gmag < FLAT_GATE) continue; // near-flat ground stays bare (hachure cartography)
      const dirx = -g.dx / gmag; // downslope
      const diry = -g.dy / gmag;
      // Hashed jitter on the start so the lattice doesn't read as a grid.
      const rng = mulberry32(hashSeed(seed, "mtn-hachure", ix, iy));
      const jx = (rng() - 0.5) * TICK_JITTER_M;
      const jy = (rng() - 0.5) * TICK_JITTER_M;
      const sx = nx + jx;
      const sy = ny + jy;
      // Length ∝ slope × relief amplitude (steeper + higher relief → longer
      // ticks), faded by the edge mask; clamped to a readable range.
      const steep = gmag * (A / 800) * 5200;
      const len = Math.min(TICK_MAX_M, Math.max(TICK_MIN_M, TICK_MIN_M + steep)) * (0.55 + 0.45 * m);
      const ex = sx + dirx * len;
      const ey = sy + diry * len;
      // Containment: both endpoints inside + the tick doesn't cross the rim.
      if (distanceToBoundary(region, sx, sy) < CONTAIN_MARGIN_M) continue;
      if (distanceToBoundary(region, ex, ey) < CONTAIN_MARGIN_M) continue;
      if (segmentCrossesBoundary(region, sx, sy, ex, ey)) continue;
      out.push({
        type: "Feature",
        id: hashSeed(seed, "mountain-hachure", ix, iy),
        geometry: { type: "LineString", coordinates: [[q(sx), q(sy)], [q(ex), q(ey)]] },
        properties: { generatorId: "mountain-hachure", type: "mountain-hachure", terrain },
      });
    }
  }

  // ── Peaks: local maxima of the shape value on the coarse lattice, above the
  //    per-terrain threshold, ≥ margin inside. ────────────────────────────────
  const px0 = Math.floor(bbox.minX / PEAK_M) - 1;
  const px1 = Math.ceil(bbox.maxX / PEAK_M) + 1;
  const py0 = Math.floor(bbox.minY / PEAK_M) - 1;
  const py1 = Math.ceil(bbox.maxY / PEAK_M) + 1;
  for (let ix = px0; ix <= px1; ix++) {
    for (let iy = py0; iy <= py1; iy++) {
      const cx = ix * PEAK_M;
      const cy = iy * PEAK_M;
      if (distanceToBoundary(region, cx, cy) < PEAK_M * 0.35) continue; // keep summits off the rim
      const nv = shape(cx, cy);
      if (nv < cfg.peakThreshold) continue;
      // 8-neighbor local-max test (pure f(pos) samples → seam-safe).
      let isMax = true;
      for (let dxi = -1; dxi <= 1 && isMax; dxi++) {
        for (let dyi = -1; dyi <= 1; dyi++) {
          if (dxi === 0 && dyi === 0) continue;
          if (shape(cx + dxi * PEAK_M, cy + dyi * PEAK_M) > nv) {
            isMax = false;
            break;
          }
        }
      }
      if (!isMax) continue;
      const elevation = Math.round(field(cx, cy).v);
      const sizeN = clamp01((nv - cfg.peakThreshold) / (1 - cfg.peakThreshold));
      out.push({
        type: "Feature",
        id: hashSeed(seed, "mountain-peak", ix, iy),
        geometry: { type: "Point", coordinates: [q(cx), q(cy)] },
        properties: { generatorId: "mountain-peak", type: "mountain-peak", terrain, elevation, sizeN: q(sizeN) },
      });
    }
  }

  // ── Contours: topographic iso-lines over the SAME elevation field (plan 023
  //    §4.1). Marching squares on a world-aligned lattice → polylines, each
  //    clipped to the ring (containment: the mask fades the field to 0 by the
  //    rim, but the linear lattice interpolant can nick a curved boundary, so
  //    the clip is load-bearing, not cosmetic). No new request surface — this
  //    runs whenever the mountain (re)generates. ──────────────────────────────
  const interval = contourInterval(A);
  const levels: number[] = [];
  for (let lv = interval; lv < A; lv += interval) levels.push(lv);
  const elev = (x: number, y: number): number => field(x, y).v;
  const contours = marchingSquares(elev, { bbox, step: CONTOUR_LATTICE_M, levels });
  for (const c of contours) {
    // Major index line every MAJOR_EVERY-th interval from the datum (level 0).
    const band = Math.round(c.level / interval);
    const index = band % MAJOR_EVERY === 0 ? "major" : "minor";
    const elevation = Math.round(c.level);
    // Clip each traced line to the ring; a concave region can split it into
    // several runs, each emitted with a position-derived id (never emission
    // order): the level + the run's mm first vertex (0.1 m id resolution).
    for (const run of clipPolylineToRegion(region, c.points)) {
      if (run.length < 2) continue;
      const coords = run.map(([x, y]) => [q(x), q(y)] as Pt);
      const [fx, fy] = coords[0];
      out.push({
        type: "Feature",
        id: hashSeed(seed, "mountain-contour", elevation, Math.round(fx * 10), Math.round(fy * 10)),
        geometry: { type: "LineString", coordinates: coords },
        properties: { generatorId: "mountain-contour", type: "mountain-contour", terrain, elevation, index },
      });
    }
  }

  return out;
}
