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
 *
 * Contours (marching squares, plan 023 §4.1) and DEM/hillshade/3D (§4.2) are
 * LATER phases; the mountain kind renders self-contained relief now.
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
import { distanceToBoundary, segmentCrossesBoundary, type ProcgenRegion } from "./region";
import { sdfPolygon, fMask } from "./fields";
import { fbmEroded, type HeightSample, type ElevationField } from "./fields/elevation";
import { q } from "./waterEmit";
import type { GenerationConstraints } from "./types";

type Pt = [number, number];

export const MOUNTAIN_TERRAINS = ["alpine", "mesa", "rolling-hills"] as const;
export type MountainTerrain = (typeof MOUNTAIN_TERRAINS)[number];

/** Mountain params v1 (plan 023 §3). All knobs have defaults so a bare `{}`
 * validates to a reasonable alpine massif (additive-params rule §1). `terrain`
 * drives layout (like the city `profile`), never a preset-id branch; `amplitude`
 * 0–1 scales relief height; `roughness` 0–1 adds octaves (finer detail). */
export interface MountainParams {
  terrain: MountainTerrain;
  amplitude: number;
  roughness: number;
}

// ── World-aligned lattice spacings (meters), absolute so edits stay local ────
const HACHURE_M = 26; // downslope tick spacing (sparse enough to read as strokes)
const PEAK_M = 45; // peak-search lattice (coarser than hachures)
const CONTAIN_MARGIN_M = 1; // keep ticks a hair clear of the boundary
// Relief amplitude envelope (meters of vertical relief): amplitude 0 → 200 m
// foothills, 1 → 1400 m alpine wall. Reads in the campaign's own metric scale.
const AMP_MIN_M = 200;
const AMP_MAX_M = 1200;
// Relief feature scale (coarsest fBm octave cell, meters) and mask fade band —
// FIXED absolute-world constants, NEVER derived from `region.effectiveRadius`.
// A region-size-derived scale would change the noise frequency / mask ramp when
// a vertex edit changes the area, re-rolling the whole interior — the farmland
// "deviation #1" trap (an edit would look like a re-roll). A constant keeps the
// deep interior byte-identical under edits (relief wavelength is a real-world
// quantity anyway, not a function of how big the polygon was drawn).
const BASE_CELL_M = 320;
const MASK_BAND_M = 120;
// Hachure tick geometry.
const TICK_MIN_M = 7;
const TICK_MAX_M = 24;
const TICK_JITTER_M = 5; // hashed per-node start jitter (breaks the grid look)
// Near-flat gate: skip ticks where the SMOOTH relief is essentially level.
const FLAT_GATE = 0.00025;

/** Per-terrain relief character. `octavesBase`/`damping`/`ridged`/`terrace`
 * shape the fBm; `peakThreshold` (normalized 0..1) gates summits; `hachureStride`
 * subsamples the tick lattice; `slopeGate` is the minimum normalized slope a
 * tick needs (flats stay bare — classic hachure cartography). */
interface TerrainConfig {
  octavesBase: number;
  damping: number;
  ridged: boolean;
  terraceSteps: number; // 0 = no terracing
  peakThreshold: number;
  hachureStride: number;
}

function terrainConfig(terrain: MountainTerrain): TerrainConfig {
  switch (terrain) {
    case "mesa":
      return { octavesBase: 3, damping: 0.15, ridged: false, terraceSteps: 4, peakThreshold: 0.62, hachureStride: 1 };
    case "rolling-hills":
      return { octavesBase: 2, damping: 0.05, ridged: false, terraceSteps: 0, peakThreshold: 0.72, hachureStride: 2 };
    default: // alpine
      return { octavesBase: 5, damping: 0.7, ridged: true, terraceSteps: 0, peakThreshold: 0.46, hachureStride: 1 };
  }
}

/** Terrace transform (mesa): flatten tops, steepen risers → cliff bands. Maps
 * `v ∈ [0,1]` to a stepped value whose plateaus are flat and whose steps are
 * sharp. `steps ≤ 0` is the identity. Exported for direct unit testing (the
 * mesa signature is otherwise subtle until contours land, 23-C). */
export function terrace(v: number, steps: number): number {
  if (steps <= 0) return v;
  const s = Math.min(0.999999, Math.max(0, v)) * steps;
  const base = Math.floor(s);
  const frac = s - base;
  // Cube the fractional part so most of a step is a flat plateau, the last
  // sliver a steep riser.
  return (base + frac * frac * frac) / steps;
}

/**
 * Build the mountain height field for a region (plan 023 §3): the campaign
 * base is deferred to plan 024, so this is `A · mask(x,y) · terrace(fbm(x,y))`
 * in meters, plus its analytic gradient. Exposed as an `ElevationField` — the
 * `elevationWithGrad(x,y)` shape §3 names, so plan 024 stage 0 can compose
 * several of these (+ base, + water carve) into the campaign-wide field.
 *
 * The returned gradient uses the RAW fbm gradient scaled by `A·mask` (the mask
 * factor's own gradient is dropped): deep inside `mask ≡ 1` (grad 0) so this is
 * exact there, and near the rim the tick DIRECTION should follow the terrain
 * slope, not point radially inward along `∇mask` — a deliberate choice (plan
 * 023 §3 hachure-orientation open question) that keeps the interior edit-local
 * and the rim natural.
 */
export function mountainHeightField(seed: number, region: ProcgenRegion, params: MountainParams): ElevationField {
  const cfg = terrainConfig(params.terrain);
  const amplitude = clamp01(params.amplitude);
  const roughness = clamp01(params.roughness);
  const A = AMP_MIN_M + amplitude * (AMP_MAX_M - AMP_MIN_M);
  const octaves = cfg.octavesBase + Math.round(roughness * 2);
  // Mask fades relief in over a fixed band inside the ring (treeline-style
  // falloff); deep interior saturates to 1 so edits stay rim-local.
  const mask = fMask(sdfPolygon(region.ring), MASK_BAND_M);
  const opts = { octaves, damping: cfg.damping, ridged: cfg.ridged, baseCell: BASE_CELL_M, salt: "mtn-elev" };

  return (x, y): HeightSample => {
    const m = mask(x, y);
    const n = fbmEroded(seed, x, y, opts);
    const tv = terrace(n.v, cfg.terraceSteps);
    // d(terrace)/dv ≈ 1 on average; for slope direction the raw fbm gradient is
    // the honest terrain slope (terrace only re-buckets magnitude), so scale by
    // A·m and keep direction from the fbm gradient.
    return { v: A * m * tv, dx: A * m * n.dx, dy: A * m * n.dy };
  };
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

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
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

  return out;
}
