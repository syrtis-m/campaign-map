/**
 * Heightmap + moisture fields. Both are pure functions of world coordinates
 * and the campaign's fixed `worldBounds` (never the tile bbox being
 * generated) — same invariant as tensorField.ts, for the same reason.
 */
import type { BBox } from "../spatialHash";
import { fractalNoise2D } from "./noise";

/** Height in [0,1]; <0.35 is ocean (see biomes.ts). Azgaar "island template"
 * lineage: fractal noise combined with radial falloff toward worldBounds'
 * center, so campaigns default to a landmass rather than infinite terrain. */
export function heightAt(campaignSeed: number, x: number, y: number, worldBounds: BBox): number {
  const raw = fractalNoise2D(campaignSeed, x, y, "height", { octaves: 4, baseCellSize: 900, persistence: 0.5 });

  const cx = (worldBounds.minX + worldBounds.maxX) / 2;
  const cy = (worldBounds.minY + worldBounds.maxY) / 2;
  const halfW = (worldBounds.maxX - worldBounds.minX) / 2 || 1;
  const halfH = (worldBounds.maxY - worldBounds.minY) / 2 || 1;
  const nx = (x - cx) / halfW;
  const ny = (y - cy) / halfH;
  const distFromCenter = Math.min(1, Math.hypot(nx, ny));
  const falloff = 1 - distFromCenter * distFromCenter;

  return Math.max(0, Math.min(1, raw * 0.7 + falloff * 0.3));
}

export function moistureAt(campaignSeed: number, x: number, y: number): number {
  return fractalNoise2D(campaignSeed, x, y, "moisture", { octaves: 3, baseCellSize: 700, persistence: 0.5 });
}
