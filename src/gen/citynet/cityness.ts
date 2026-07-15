/**
 * Cityness — a scalar density field that modulates the whole pipeline:
 * branch priority/
 * probability and growth extent (growth.ts), snap distance (growth.ts),
 * parcel minArea and footprint depth/coverage (parcels.ts), and the
 * outskirts bands (outskirts.ts).
 *
 * `cityness(x,y) = falloff(interiorT(p)) × (0.6 + 0.4·noise) + Σ bumps`
 * where `interiorT` (region.ts) replaces the disc's `|p − center|/radius`
 * with the same semantics — ~0 at the deepest interior, 1 at the sketched
 * boundary — and the same `max(0, 1 − t²)` curve, so density falls toward
 * the GM's line whatever shape it takes. Each settlement-type canon Location
 * INSIDE the region (`regionContains`) adds a hashed-magnitude radial bump —
 * "the city grows around the GM's pins".
 *
 * Determinism/seam argument: a pure function of (citySeed, region, canon
 * feature list, world position) — value noise is position-hashed
 * (`world/noise.ts`) and each bump's magnitude hashes on the pin's rounded
 * position, never on array order.
 */
import { hashSeed, mulberry32 } from "../rng";
import { valueNoise2D } from "../world/noise";
import { interiorT, regionContains, type ProcgenRegion } from "../region";
import type { Field } from "../fields/sdf";

// ── Vegetation growth-cost coupling (plan 037, forest/park → city) ────────────
// The generated canopy (`constraints.upstream.vegetation`, an SDF positive
// inside) ATTENUATES cityness — streets thin and blocks coarsen in the woods (a
// growth-cost multiplier), the town reading as a clearing. Attenuation ramps
// with canopy depth to a floor; canopy is NEVER clipped (standing rejection —
// the clearing is a paint-order read, not a hole in the forest).
/** Canopy depth (m) at which the attenuation reaches its floor. */
export const CANOPY_ATTEN_FULL_M = 60;
/** Cityness multiplier floor deep inside canopy (streets never vanish entirely). */
export const CANOPY_ATTEN_FLOOR = 0.25;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Noise cell size (meters) — coarse enough to read as neighborhoods. */
export const CITYNESS_NOISE_CELL_M = 260;
/** Radius (meters) of a canon-location bump's influence. */
export const BUMP_RADIUS_M = 180;
/** Hashed bump magnitude range for settlement-type pins (city/town/village). */
export const BUMP_SETTLEMENT_MIN = 0.15;
export const BUMP_SETTLEMENT_MAX = 0.3;
/** Smaller fixed-range bump for canon Points without a settlement type — any
 * pin the GM dropped still pulls some density. */
export const BUMP_OTHER_MIN = 0.05;
export const BUMP_OTHER_MAX = 0.1;
/** Location-note `type` values that read as settlements. */
export const SETTLEMENT_TYPES = new Set(["city", "town", "village"]);

export type CitynessFn = (x: number, y: number) => number;

interface Bump {
  x: number;
  y: number;
  magnitude: number;
}

/** Extract deterministic bumps from canon Point features inside the region. */
function canonBumps(citySeed: number, region: ProcgenRegion, canonFeatures: GeoJSON.Feature[]): Bump[] {
  const bumps: Bump[] = [];
  for (const f of canonFeatures) {
    if (f.geometry.type !== "Point") continue;
    const [x, y] = f.geometry.coordinates as [number, number];
    if (!regionContains(region, x, y)) continue;
    const type = String((f.properties as Record<string, unknown> | null)?.type ?? "");
    const settlement = SETTLEMENT_TYPES.has(type);
    // Magnitude hashes on the pin's rounded position (stable under reorder).
    const rng = mulberry32(hashSeed(citySeed, "bump", Math.round(x * 10), Math.round(y * 10)));
    const [lo, hi] = settlement ? [BUMP_SETTLEMENT_MIN, BUMP_SETTLEMENT_MAX] : [BUMP_OTHER_MIN, BUMP_OTHER_MAX];
    bumps.push({ x, y, magnitude: lo + rng() * (hi - lo) });
  }
  // Canonical order (D2) — summation order affects FP at the last ulp.
  bumps.sort((a, b) => a.x - b.x || a.y - b.y);
  return bumps;
}

/** Build the cityness field. `canonFeatures` optional for callers (tests,
 * profiling) that want the bare interior falloff. Note interiorT can dip a
 * hair below 0 at the deepest interior (region.ts lattice approximation);
 * `1 − t²` handles that gracefully (falloff stays ≤ 1). */
export function makeCityness(
  citySeed: number,
  region: ProcgenRegion,
  canonFeatures: GeoJSON.Feature[] = []
): CitynessFn {
  const bumps = canonBumps(citySeed, region, canonFeatures);
  return (x, y) => {
    const t = interiorT(region, x, y);
    const falloff = Math.max(0, 1 - t * t);
    const noise = valueNoise2D(citySeed, x, y, CITYNESS_NOISE_CELL_M, "cityness");
    let c = falloff * (0.6 + 0.4 * noise);
    for (const b of bumps) {
      const d = Math.hypot(x - b.x, y - b.y);
      if (d >= BUMP_RADIUS_M) continue;
      const s = 1 - d / BUMP_RADIUS_M;
      c += b.magnitude * s * s;
    }
    return c;
  };
}

/**
 * Wrap a cityness field so it is ATTENUATED inside the generated canopy (plan
 * 037): `cityness'(p) = cityness(p) × canopyFactor(depth(p))`, where the factor
 * is 1 outside the canopy and ramps to `CANOPY_ATTEN_FLOOR` at
 * `CANOPY_ATTEN_FULL_M` of depth. `canopy === null` (no upstream vegetation)
 * returns the base field UNCHANGED — the city stays byte-identical to the
 * uncoupled generator (23-E). Pure; the factor is a closed form of the field.
 */
export function attenuateCitynessByCanopy(base: CitynessFn, canopy: Field | null): CitynessFn {
  if (canopy === null) return base;
  return (x, y) => {
    const c = base(x, y);
    const d = canopy(x, y); // > 0 inside the canopy
    if (d <= 0) return c;
    const factor = 1 - (1 - CANOPY_ATTEN_FLOOR) * clamp01(d / CANOPY_ATTEN_FULL_M);
    return c * factor;
  };
}
