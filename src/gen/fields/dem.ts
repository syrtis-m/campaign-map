/**
 * DEM (digital-elevation-model) raster support for hillshade + 3D terrain.
 * PURE / headless (no DOM/canvas/Obsidian imports): this module owns the
 * *numeric* half of the DEM path — composing the campaign elevation field,
 * mapping slippy tiles → gen-space samples, and the raw-lattice quantization +
 * terrarium RGBA packing. The *encoding* half (int lattice → PNG bytes via a
 * canvas) lives in the view layer (`campaignDemProtocol.ts`), because canvas is
 * a host API and PNG bytes are NOT a determinism surface (zlib/canvas encoders
 * vary across platforms/versions). The DURABLE record is the quantized int
 * lattice here; the PNG is re-encoded from it at serve time and never
 * byte-compared.
 *
 * Point-evaluability is preserved: every height is `field(x,y)` at an ABSOLUTE
 * gen-space position derived purely from the tile's geography, so two tiles that
 * share a boundary sample the identical world point there and agree (the seam
 * rule — same story as contours/costField, now for heights).
 */
import type { ElevationField, HeightSample } from "./elevation";

/** WGS84 equatorial circumference (m) — MapLibre's web-mercator assumes this.
 * One fake-lng-degree in a fictional CRS spans this/360 mercator-meters. */
const EARTH_CIRCUMFERENCE_M = 40075016.686;
const MERCATOR_M_PER_DEGREE = EARTH_CIRCUMFERENCE_M / 360; // ≈ 111319.49

/** Terrarium elevation encoding: `E = R·256 + G + B/256 − 32768` (meters). The
 * durable lattice stores integer `E`, so RGB packing is exact + lossless. */
export const TERRARIUM_BASE = 32768;
const TERRARIUM_MAX = 32767; // 65535 − 32768

/**
 * VERTICAL SCALE (the fictional-CRS reconciliation). MapLibre's hillshade
 * derives slope from elevation deltas normalized by web-mercator meters-per-
 * pixel at the tile's zoom (`deriv = Sobel(elev)/pow(2, …−zoom)`), assuming the
 * DEM is georeferenced in real mercator meters. A fictional campaign packs many
 * real meters into one fake degree (`scaleMetersPerUnit` ≪ the mercator
 * 111 319 m/deg), so raw campaign-meter heights read ~`MERCATOR_M_PER_DEGREE /
 * scaleMetersPerUnit`× too gentle — hillshade renders flat even when positioned
 * correctly over the relief. The physically-exact fix multiplies heights by that
 * full factor, but it blows past the terrarium ±32 768 m ceiling for real
 * mountains. Readability (not physical accuracy) is the bar, and MapLibre's
 * slope is zoom-invariant, so a terrarium-capped constant `K` per campaign
 * suffices: exact where the campaign is large enough to fit, gently compressed
 * (still clearly shaded) where it isn't. Constant per-campaign (never per-tile)
 * so seams + cross-tile continuity hold. Tunable via the two ceilings below.
 */
const DEM_ENCODE_CEIL_M = 30000; // encoded-height budget (headroom under 32 767)
const MAX_TERRAIN_HEIGHT_M = 1200; // mountain AMP_MAX_M (src/gen/mountain.ts); union is max, never sum

/** Per-campaign vertical scale `K` (encoded-terrarium-meters per campaign-meter).
 * `min(physical, ceiling-fit)`: physical correction where it fits the terrarium
 * range, else the largest factor that keeps a full-height peak inside it. */
export function demVerticalScale(scaleMetersPerUnit: number): number {
  const physical = MERCATOR_M_PER_DEGREE / Math.max(1e-6, scaleMetersPerUnit);
  const ceilingFit = DEM_ENCODE_CEIL_M / MAX_TERRAIN_HEIGHT_M;
  return Math.min(physical, ceilingFit);
}

/**
 * Composed-terrain FIELD version — the ONE salt bumped whenever the field math
 * changes output bytes for the SAME durable inputs. Both the per-tile DEM digest
 * (below) and the campaign-wide contour digest (`elevationDigest`) carry it, so a
 * bump re-derives every cached DEM tile AND contour leaf; old-salt records simply
 * mismatch and re-derive (self-healing, no migration). NOT a persisted
 * determinism surface — a compared cache key, re-derivable per machine.
 *   3: per-tile DEM digest (was a single campaign-wide digest) + t2→t3 salt.
 *   4: monotone-downhill river bed (buildRiverCarve cumulative-min) — the carve
 *      field moved for the same river inputs, so every DEM tile + contour leaf
 *      must re-derive or a stale bumpy lattice serves forever.
 */
export const TERRAIN_FIELD_VERSION = 4;

/** Longitude/latitude bounds of a slippy tile (z/x/y, XYZ scheme). Standard
 * web-mercator inverse — the tile grid MapLibre requests DEM tiles on. */
export function tileLngLatBounds(
  z: number,
  x: number,
  y: number
): { west: number; east: number; north: number; south: number } {
  const n = Math.pow(2, z);
  const lng = (xi: number): number => (xi / n) * 360 - 180;
  const lat = (yi: number): number => {
    const t = Math.PI * (1 - (2 * yi) / n);
    return (Math.atan(Math.sinh(t)) * 180) / Math.PI;
  };
  return { west: lng(x), east: lng(x + 1), north: lat(y), south: lat(y + 1) };
}

/**
 * Compose a campaign-wide elevation field from per-region fields via UNION
 * (pointwise `max` on the value; the max contributor's gradient carried). Each
 * mountain field is masked to its own ring (0 outside), so `max` is the natural
 * "any mountain here wins" combinator and outside every ring the campaign is
 * flat (height 0). Empty campaign → constant-0 field (a legal flat DEM: hillshade
 * shows nothing, no crash). Base continental terrain + water carve compose on
 * top of this; `heightAt` stays untouched.
 */
export function unionFields(fields: ElevationField[]): ElevationField {
  if (fields.length === 0) return () => ({ v: 0, dx: 0, dy: 0 });
  if (fields.length === 1) return fields[0];
  return (x, y): HeightSample => {
    let best: HeightSample = { v: -Infinity, dx: 0, dy: 0 };
    for (const f of fields) {
      const s = f(x, y);
      if (s.v > best.v) best = s;
    }
    return best;
  };
}

/**
 * Quantized raw-height lattice for one DEM tile — the DURABLE determinism
 * record. `res × res` row-major integer terrarium elevations `E = round(clamp(
 * K·field, −base, max))`. Each pixel samples the field at the ABSOLUTE gen-space
 * point under that pixel (`lng·scale, lat·scale` — display units are the fake
 * lng/lat, gen-space meters = unit·scaleMetersPerUnit, matching
 * `buildRegionFromFeature`), so any two tiles agree on shared world points (seam
 * rule). Pixel centers are placed at `(i+0.5)/res` across the tile extent, the
 * terrarium tile convention. Pure f(field, tile, scale, K).
 */
export function demTileLattice(
  field: ElevationField,
  z: number,
  x: number,
  y: number,
  res: number,
  scaleMetersPerUnit: number,
  k: number
): number[] {
  const { west, east, north, south } = tileLngLatBounds(z, x, y);
  const out: number[] = new Array(res * res);
  for (let j = 0; j < res; j++) {
    const lat = north + ((south - north) * (j + 0.5)) / res;
    const my = lat * scaleMetersPerUnit;
    for (let i = 0; i < res; i++) {
      const lng = west + ((east - west) * (i + 0.5)) / res;
      const mx = lng * scaleMetersPerUnit;
      const h = field(mx, my).v * k;
      out[j * res + i] = Math.round(Math.max(-TERRARIUM_BASE, Math.min(TERRARIUM_MAX, h)));
    }
  }
  return out;
}

/**
 * Pack an integer terrarium-elevation lattice into RGBA bytes (row-major,
 * 4·res² length) — the exact, lossless representation the PNG encoder wraps.
 * `E = R·256 + G + B/256 − 32768`; integer `E` ⇒ `B = 0`. Pure (no canvas), so
 * it is unit-testable without a DOM; the view layer only turns these bytes into
 * a PNG (which is never byte-compared).
 */
export function latticeToRGBA(heights: number[], res: number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(res * res * 4);
  for (let p = 0; p < heights.length; p++) {
    const v = heights[p] + TERRARIUM_BASE; // 0 .. 65535
    const r = Math.floor(v / 256);
    const g = v % 256;
    const o = p * 4;
    rgba[o] = r;
    rgba[o + 1] = g;
    rgba[o + 2] = 0;
    rgba[o + 3] = 255;
  }
  return rgba;
}
