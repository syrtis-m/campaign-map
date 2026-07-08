/**
 * Naming cultures as regions (docs/04 F5, Azgaar's model): each region
 * carries a phoneme/style profile. Rather than graph flood-fill from seeded
 * culture centers (order-dependent BFS — the same coupling class that
 * breaks streamline/Poisson determinism), culture territory is assigned by
 * nearest-culture-center: a fixed, campaign-wide set of seeded points, each
 * pre-assigned one culture. Any given position's culture is a pure function
 * of its own coordinates + that fixed set — no dependency on neighboring
 * cells, generation order, or tile bbox, so it's trivially seam-safe.
 */
import { hashSeed, mulberry32 } from "../rng";
import type { BBox } from "../spatialHash";
import type { NamingCulture, NamingGenre } from "./culture";
import { culturesForGenre, NAMING_CULTURES } from "./cultures";

export interface CultureCenter {
  x: number;
  y: number;
  cultureId: string;
}

const CENTERS_PER_CULTURE = 2;

/** Pure fn of (campaignSeed, worldBounds, genre, activeCultureIds) —
 * worldBounds must be the campaign's fixed bounds, never a tile bbox
 * (tensorField.ts precedent). `activeCultureIds` narrows to a campaign's
 * chosen subset (see culturesForGenre); omit for the full genre set. */
export function buildCultureCenters(
  campaignSeed: number,
  worldBounds: BBox,
  genre: NamingGenre,
  activeCultureIds?: string[]
): CultureCenter[] {
  const cultures = culturesForGenre(genre, activeCultureIds);
  if (cultures.length === 0) return [];

  const rng = mulberry32(hashSeed(campaignSeed, "culture-centers", genre));
  const w = worldBounds.maxX - worldBounds.minX;
  const h = worldBounds.maxY - worldBounds.minY;

  const centers: CultureCenter[] = [];
  for (const culture of cultures) {
    for (let i = 0; i < CENTERS_PER_CULTURE; i++) {
      centers.push({
        x: worldBounds.minX + rng() * w,
        y: worldBounds.minY + rng() * h,
        cultureId: culture.id,
      });
    }
  }
  return centers;
}

/** The naming culture in effect at a world position — nearest culture center wins. */
export function cultureAt(
  campaignSeed: number,
  x: number,
  y: number,
  worldBounds: BBox,
  genre: NamingGenre,
  activeCultureIds?: string[]
): NamingCulture {
  const centers = buildCultureCenters(campaignSeed, worldBounds, genre, activeCultureIds);
  const fallback = culturesForGenre(genre, activeCultureIds)[0] ?? NAMING_CULTURES["fantasy-brackish"];
  if (centers.length === 0) return fallback;

  let best = centers[0];
  let bestDist = Infinity;
  for (const c of centers) {
    const d = Math.hypot(c.x - x, c.y - y);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return NAMING_CULTURES[best.cultureId] ?? fallback;
}
