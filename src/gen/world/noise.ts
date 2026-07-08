/**
 * Seeded value noise — pure function of (seed, x, y). Unlike streamline/
 * Poisson seeding, noise needs no halo/seam handling at all: every sample is
 * computed independently from its own lattice cell, never from neighboring
 * samples or generation order, so it's trivially identical across any tile
 * boundary.
 */
import { hashSeed, mulberry32 } from "../rng";

function latticeValue(seed: number, ix: number, iy: number, salt: string): number {
  return mulberry32(hashSeed(seed, ix, iy, salt))();
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Bilinear-interpolated value noise on an integer lattice, range [0,1). */
export function valueNoise2D(seed: number, x: number, y: number, cellSize: number, salt: string): number {
  const gx = x / cellSize;
  const gy = y / cellSize;
  const ix = Math.floor(gx);
  const iy = Math.floor(gy);
  const fx = gx - ix;
  const fy = gy - iy;
  const v00 = latticeValue(seed, ix, iy, salt);
  const v10 = latticeValue(seed, ix + 1, iy, salt);
  const v01 = latticeValue(seed, ix, iy + 1, salt);
  const v11 = latticeValue(seed, ix + 1, iy + 1, salt);
  const sx = smoothstep(fx);
  const sy = smoothstep(fy);
  const top = v00 + (v10 - v00) * sx;
  const bottom = v01 + (v11 - v01) * sx;
  return top + (bottom - top) * sy;
}

export interface FractalNoiseOptions {
  octaves: number;
  baseCellSize: number;
  persistence: number;
}

const DEFAULT_OPTS: FractalNoiseOptions = { octaves: 4, baseCellSize: 800, persistence: 0.5 };

/** Fractal (multi-octave) value noise, range [0,1]. */
export function fractalNoise2D(
  seed: number,
  x: number,
  y: number,
  salt: string,
  opts: Partial<FractalNoiseOptions> = {}
): number {
  const { octaves, baseCellSize, persistence } = { ...DEFAULT_OPTS, ...opts };
  let total = 0;
  let amplitude = 1;
  let maxAmp = 0;
  let cellSize = baseCellSize;
  for (let o = 0; o < octaves; o++) {
    total += valueNoise2D(seed, x, y, cellSize, `${salt}-o${o}`) * amplitude;
    maxAmp += amplitude;
    amplitude *= persistence;
    cellSize /= 2;
  }
  return maxAmp > 0 ? total / maxAmp : 0;
}
