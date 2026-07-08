import type { BBox } from "../spatialHash";

/**
 * Generation tile grid — a fixed size for Phase 3. Phase 4 ("Zoom-band
 * dispatcher over .mapcache/ chunks") adds real per-zoom bands on top of
 * this; the cache key already carries a `zoom` field so that's additive,
 * not a format break.
 */
export const GENERATION_TILE_SIZE = 600;
export const GENERATION_ZOOM = 0;

export function tileXYForPoint(x: number, y: number, tileSize: number = GENERATION_TILE_SIZE): { tileX: number; tileY: number } {
  return { tileX: Math.floor(x / tileSize), tileY: Math.floor(y / tileSize) };
}

export function tileBBox(tileX: number, tileY: number, tileSize: number = GENERATION_TILE_SIZE): BBox {
  return {
    minX: tileX * tileSize,
    minY: tileY * tileSize,
    maxX: (tileX + 1) * tileSize,
    maxY: (tileY + 1) * tileSize,
  };
}

/** `hash(campaignSeed, tileX, tileY, zoom, generatorId)` (CLAUDE.md locked decision). */
export function tileKey(campaignSeed: number, tileX: number, tileY: number, zoom: number, generatorId: string): string {
  return `${campaignSeed}:${tileX}:${tileY}:${zoom}:${generatorId}`;
}
