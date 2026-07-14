/**
 * Mountain elevation field (plan 023 §3) as a FIELDS module — moved VERBATIM
 * from `src/gen/mountain.ts` in box 23-E so that OTHER generators (farmland's
 * paddy terraces, the river's slope coupling — plan 022 §3.1/§3.5) can read the
 * elevation the sketched mountains define WITHOUT importing the mountain
 * generator (the never-import-one-generator-from-another rule: shared field
 * access goes through `fields/`). `mountain.ts` imports these back one-way
 * (mountain → fields, acyclic) and re-exports its public API unchanged — the
 * 23-A verbatim-move bit-exactness technique: character-identical arithmetic,
 * same evaluation order, so every pre-23-E mountain byte-stays.
 *
 * STAGE-LAYERING LEGALITY (the 23-E design constraint): everything here is a
 * pure function of the DURABLE SKETCH LAYER — persisted seeds/params/rings of
 * mountain fabric features — never of another generator's OUTPUT. Reading it
 * from farmland/river is the same legality as 23-D's DEM ("pure field
 * evaluation over the durable sketch layer"); output→output coupling is plan
 * 024's cascade, not this.
 */
import { fMask } from "./combinators";
import { sdfPolygon } from "./sdf";
import { fbmEroded, type HeightSample, type ElevationField } from "./elevation";
import { unionFields } from "./dem";
import type { FabricFeature } from "../../model/fabric";

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

// Relief amplitude envelope (meters of vertical relief): amplitude 0 → 200 m
// foothills, 1 → 1400 m alpine wall. Reads in the campaign's own metric scale.
export const AMP_MIN_M = 200;
export const AMP_MAX_M = 1200;
// Relief feature scale (coarsest fBm octave cell, meters) and mask fade band —
// FIXED absolute-world constants, NEVER derived from `region.effectiveRadius`.
// A region-size-derived scale would change the noise frequency / mask ramp when
// a vertex edit changes the area, re-rolling the whole interior — the farmland
// "deviation #1" trap (an edit would look like a re-roll). A constant keeps the
// deep interior byte-identical under edits (relief wavelength is a real-world
// quantity anyway, not a function of how big the polygon was drawn).
export const BASE_CELL_M = 320;
export const MASK_BAND_M = 120;

/** Per-terrain relief character. `octavesBase`/`damping`/`ridged`/`terrace`
 * shape the fBm; `peakThreshold` (normalized 0..1) gates summits; `hachureStride`
 * subsamples the tick lattice; `slopeGate` is the minimum normalized slope a
 * tick needs (flats stay bare — classic hachure cartography). */
export interface TerrainConfig {
  octavesBase: number;
  damping: number;
  ridged: boolean;
  terraceSteps: number; // 0 = no terracing
  peakThreshold: number;
  hachureStride: number;
}

export function terrainConfig(terrain: MountainTerrain): TerrainConfig {
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

export function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
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
 *
 * `region` is structural (`{ ring }`) so both a full `ProcgenRegion` and a
 * fabric-derived ring qualify — the arithmetic is untouched from 23-B.
 */
export function mountainHeightField(seed: number, region: { ring: Pt[] }, params: MountainParams): ElevationField {
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

/** mm quantization (D5) — matched to region.ts `q` so a fabric-derived ring
 * reproduces `makeRegion`'s ingest normalization bit-for-bit. */
function q(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** Ingest-normalize a fabric polygon's outer ring the way `makeRegion` does
 * (mm-quantize, dedupe consecutive vertices, strip + re-add the closing
 * vertex) WITHOUT importing region.ts (fields stays a leaf; winding is
 * irrelevant to distance/even-odd, so the CCW flip is deliberately skipped). */
function normalizeRing(raw: Pt[]): Pt[] | null {
  const open: Pt[] = [];
  for (const p of raw) {
    const v: Pt = [q(p[0]), q(p[1])];
    const last = open[open.length - 1];
    if (last && last[0] === v[0] && last[1] === v[1]) continue;
    open.push(v);
  }
  if (open.length >= 2) {
    const a = open[0];
    const b = open[open.length - 1];
    if (a[0] === b[0] && a[1] === b[1]) open.pop();
  }
  if (open.length < 3) return null;
  return [...open, open[0]];
}

/**
 * The campaign elevation field as seen THROUGH THE CONSTRAINTS (box 23-E): the
 * union of every sketched mountain region's height field, rebuilt from the
 * persisted `procgen` blocks (seed + params) and ring geometry carried on
 * `constraints.fabricFeatures` — i.e. a pure function of the durable sketch
 * layer, in gen-space meters (the host converts units before threading
 * constraints; see `generationContext`). This is the twin of the host-side
 * `campaignElevationSnapshot` (DEM, 23-D) for the PURE side of the boundary:
 * generators must not call the controller, but every generator already
 * receives the whole sketch layer, so the field composes from what is in hand.
 *
 * Determinism: mountains are visited in feature-id order (stable across
 * enumeration order); params parse defensively with the SAME defaults the host
 * uses (terrain "alpine", amplitude 0.6, roughness 0.5 — MapController's
 * regionElevationReport precedent). `null` when no mountain sketch exists, so
 * callers can keep their uncoupled code path byte-identical (the 23-E
 * no-mountain byte-identity rule).
 */
export function elevationFieldFromFabric(fabricFeatures: FabricFeature[] | undefined): ElevationField | null {
  if (!fabricFeatures || fabricFeatures.length === 0) return null;
  const mountains = fabricFeatures
    .filter((f) => f.properties.procgen?.algorithm === "mountain" && f.geometry.type === "Polygon")
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const fields: ElevationField[] = [];
  for (const feature of mountains) {
    const block = feature.properties.procgen!;
    const coords = (feature.geometry as GeoJSON.Polygon).coordinates[0] as Pt[] | undefined;
    const ring = coords ? normalizeRing(coords) : null;
    if (!ring) continue;
    const p = block.params as Record<string, unknown>;
    const terrain = (
      typeof p.terrain === "string" && (MOUNTAIN_TERRAINS as readonly string[]).includes(p.terrain)
        ? p.terrain
        : "alpine"
    ) as MountainTerrain;
    const amplitude = typeof p.amplitude === "number" ? p.amplitude : 0.6;
    const roughness = typeof p.roughness === "number" ? p.roughness : 0.5;
    fields.push(mountainHeightField(block.seed, { ring }, { terrain, amplitude, roughness }));
  }
  if (fields.length === 0) return null;
  return unionFields(fields);
}
