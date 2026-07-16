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

/**
 * Generation tiers. World-tier content
 * (regions/routes/coastline) is coarse and appropriate below street level;
 * city-tier (streets/districts/blocks) is the fine fabric for street-level
 * zooms. `bandForZoom` picks which tier an explicit "Generate fabric here"
 * runs at, from the zoom the GM is looking at — generation itself is
 * explicit-only, never dispatched from pan/zoom. Both tiers reuse the same
 * `GENERATION_TILE_SIZE` grid — these are small fictional campaigns
 * (docs/quality-bar.md), not continents, so a separate coarser world-tile grid isn't
 * needed yet; the cache key's `zoom`/generatorId fields already make this
 * additive, not a format break, if that changes later.
 *
 * `world-settlement` is deliberately NOT in the world set:
 * named places are Locations the GM creates, not generator output. The
 * settlements generator stays in-tree (populate-area shares its naming),
 * it's just unwired from generate-here.
 */
export const GENERATION_TIERS = ["world", "city"] as const;
export type ZoomBand = (typeof GENERATION_TIERS)[number];
export const CITY_BAND_MIN_ZOOM = 8;
export const WORLD_GENERATOR_IDS = ["world-region", "world-route"] as const;
export const CITY_GENERATOR_IDS = ["city-street", "city-district", "city-block"] as const;

export function bandForZoom(zoom: number): ZoomBand {
  return zoom >= CITY_BAND_MIN_ZOOM ? "city" : "world";
}

export function generatorIdsForBand(band: ZoomBand): readonly string[] {
  return band === "city" ? CITY_GENERATOR_IDS : WORLD_GENERATOR_IDS;
}
