/**
 * Cityness (procgen v3 §5.4, completed in v3.3) — a scalar density field that
 * modulates the whole pipeline: branch priority/probability and growth extent
 * (growth.ts), snap distance (growth.ts), parcel minArea and footprint
 * depth/coverage (parcels.ts), and the outskirts bands (outskirts.ts).
 *
 * `cityness(x,y) = falloff(|p − center|/radius) × (0.6 + 0.4·noise) + Σ bumps`
 * where each settlement-type canon Location inside the domain adds a
 * hashed-magnitude radial bump — "the city grows around the GM's pins".
 *
 * Determinism/seam argument: a pure function of (citySeed, domain, canon
 * feature list, world position) — value noise is position-hashed
 * (`world/noise.ts`) and each bump's magnitude hashes on the pin's rounded
 * position, never on array order (D2/D6).
 */
import { hashSeed, mulberry32 } from "../rng";
import { valueNoise2D } from "../world/noise";
import type { CityDomain } from "./domain";

/** Noise cell size (meters) — coarse enough to read as neighborhoods. */
export const CITYNESS_NOISE_CELL_M = 260;
/** Radius (meters) of a canon-location bump's influence. */
export const BUMP_RADIUS_M = 180;
/** Hashed bump magnitude range for settlement-type pins (city/town/village). */
export const BUMP_SETTLEMENT_MIN = 0.15;
export const BUMP_SETTLEMENT_MAX = 0.3;
/** Smaller fixed-range bump for canon Points without a settlement type — any
 * pin the GM dropped still pulls some density (per v3.3 brief fallback). */
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

/** Extract deterministic bumps from canon Point features inside the domain. */
function canonBumps(citySeed: number, domain: CityDomain, canonFeatures: GeoJSON.Feature[]): Bump[] {
  const bumps: Bump[] = [];
  for (const f of canonFeatures) {
    if (f.geometry.type !== "Point") continue;
    const [x, y] = f.geometry.coordinates as [number, number];
    if (Math.hypot(x - domain.cx, y - domain.cy) > domain.radius) continue;
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
 * profiling) that want the bare radial field. */
export function makeCityness(
  citySeed: number,
  domain: CityDomain,
  canonFeatures: GeoJSON.Feature[] = []
): CitynessFn {
  const bumps = canonBumps(citySeed, domain, canonFeatures);
  return (x, y) => {
    const t = Math.hypot(x - domain.cx, y - domain.cy) / domain.radius;
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
