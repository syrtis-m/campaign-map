/**
 * Cityness (procgen v3 §5.4) — a scalar density field in [0,1] that modulates
 * the growth loop: branch priority and probability rise with it, and growth
 * stops where it falls below `profile.edge`. v3.1-minimal scope: radial
 * falloff × seeded noise only. The §5.4 canon-Location bumps ("the city grows
 * around the GM's pins") land in v3.3 with the rest of the cityness consumers.
 *
 * Determinism/seam argument: a pure function of (citySeed, domain center/
 * radius, world position) — value noise is position-hashed (`world/noise.ts`),
 * so every sample is independent of query order and identical wherever it is
 * asked from (D6).
 */
import { valueNoise2D } from "../world/noise";
import type { CityDomain } from "./domain";

/** Noise cell size (meters) — coarse enough to read as neighborhoods. */
export const CITYNESS_NOISE_CELL_M = 260;

export type CitynessFn = (x: number, y: number) => number;

/** `falloff(|p − center| / radius) × (0.6 + 0.4 · noise)` (§5.4). */
export function makeCityness(citySeed: number, domain: CityDomain): CitynessFn {
  return (x, y) => {
    const t = Math.hypot(x - domain.cx, y - domain.cy) / domain.radius;
    const falloff = Math.max(0, 1 - t * t);
    const noise = valueNoise2D(citySeed, x, y, CITYNESS_NOISE_CELL_M, "cityness");
    return falloff * (0.6 + 0.4 * noise);
  };
}
