/**
 * Position-deterministic point seeding, shared by every Phase 3 generator.
 *
 * The classic algorithms for streamline seeding (dsep from existing streamlines)
 * and Bridson Poisson-disc (active-list + random pick) are order-dependent: what
 * exists depends on generation order, so two tiles computing independently
 * diverge at the shared boundary. Seams require the opposite property: a feature
 * straddling a boundary must generate identically no matter which tile asks.
 *
 * Fix: seed points come from a coarse world-space grid. Each cell independently
 * hashes to zero-or-one jittered point, entirely as a function of (campaignSeed,
 * cellX, cellY, salt) — never of neighboring cells or generation order. Callers
 * generate over a halo-padded bbox so a point near a tile edge is computed
 * identically by both tiles that can see it.
 */
import { hashSeed, mulberry32 } from "./rng";

export interface GridPoint {
  x: number;
  y: number;
  cellX: number;
  cellY: number;
}

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Expands a bbox by a fixed halo margin in world units. */
export function expandBBox(bbox: BBox, halo: number): BBox {
  return {
    minX: bbox.minX - halo,
    minY: bbox.minY - halo,
    maxX: bbox.maxX + halo,
    maxY: bbox.maxY + halo,
  };
}

/**
 * Deterministic jittered-grid point set over a bbox: a stratified substitute
 * for Bridson Poisson-disc sampling. Not true blue noise, but every point is a
 * pure function of its own cell — no active-list, no scan order, no seam risk.
 * `density` in (0,1]: probability a given cell spawns a point at all (lets
 * callers thin the grid without changing cell size / jitter behavior).
 */
export function jitteredGridPoints(
  campaignSeed: number,
  bbox: BBox,
  cellSize: number,
  salt: string,
  density = 1
): GridPoint[] {
  const points: GridPoint[] = [];
  const cellXMin = Math.floor(bbox.minX / cellSize);
  const cellXMax = Math.floor(bbox.maxX / cellSize);
  const cellYMin = Math.floor(bbox.minY / cellSize);
  const cellYMax = Math.floor(bbox.maxY / cellSize);

  for (let cellY = cellYMin; cellY <= cellYMax; cellY++) {
    for (let cellX = cellXMin; cellX <= cellXMax; cellX++) {
      const rng = mulberry32(hashSeed(campaignSeed, cellX, cellY, salt));
      const spawnRoll = rng();
      if (spawnRoll >= density) continue;
      const jx = rng();
      const jy = rng();
      const x = (cellX + jx) * cellSize;
      const y = (cellY + jy) * cellSize;
      if (x < bbox.minX || x > bbox.maxX || y < bbox.minY || y > bbox.maxY) continue;
      points.push({ x, y, cellX, cellY });
    }
  }

  // Canonical order: never rely on grid scan order surviving downstream (e.g.
  // into d3-delaunay, whose triangulation is order-sensitive for coincident
  // inputs). Sort so output is identical regardless of iteration direction.
  points.sort((a, b) => a.x - b.x || a.y - b.y);
  return points;
}

/** Seeded RNG scoped to one grid cell — for per-point attribute rolls (name, kind, etc). */
export function cellRng(campaignSeed: number, cellX: number, cellY: number, salt: string): () => number {
  return mulberry32(hashSeed(campaignSeed, cellX, cellY, salt));
}
