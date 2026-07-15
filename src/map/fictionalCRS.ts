/**
 * Fictional worlds use fake [lng, lat] coordinates in a bounded box (architecture §4).
 * MapLibre still assumes Web Mercator under the hood, so all fake
 * coordinates are kept near the equator (lat in roughly [-10, 10]) to keep Mercator
 * distortion negligible across a campaign's extent.
 *
 * `scaleMetersPerUnit` converts one degree of fake longitude at the equator into
 * real-world-equivalent meters for the scale bar and any distance UI.
 */

const EARTH_CIRCUMFERENCE_M = 40075016.686;
const TILE_SIZE_PX = 512;

/** Meters-per-pixel of the underlying Web Mercator projection at the equator. */
export function mercatorMetersPerPixel(zoom: number): number {
  return EARTH_CIRCUMFERENCE_M / (TILE_SIZE_PX * Math.pow(2, zoom));
}

/** Converts a screen-pixel distance at the given zoom into campaign-scale meters. */
export function pixelsToCampaignMeters(
  pixels: number,
  zoom: number,
  scaleMetersPerUnit: number
): number {
  const degreesPerPixel = mercatorMetersPerPixel(zoom) / (EARTH_CIRCUMFERENCE_M / 360);
  const fakeUnits = pixels * degreesPerPixel;
  return fakeUnits * scaleMetersPerUnit;
}

const NICE_STEPS = [1, 2, 5];

/** Picks a "nice" round distance (1/2/5 * 10^n) at or under maxMeters, Google-Maps-style. */
export function niceScaleStep(maxMeters: number): number {
  if (maxMeters <= 0) return 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(maxMeters)));
  let best = magnitude;
  for (const step of NICE_STEPS) {
    const candidate = step * magnitude;
    if (candidate <= maxMeters) best = candidate;
  }
  return best;
}

export function formatMeters(meters: number): string {
  if (meters >= 1000) {
    const km = meters / 1000;
    return `${km >= 10 ? Math.round(km) : Math.round(km * 10) / 10} km`;
  }
  return `${Math.round(meters)} m`;
}

/** Computes a scale-bar reading: target pixel width + label, for a given max pixel budget. */
export function computeScaleBar(
  zoom: number,
  scaleMetersPerUnit: number,
  maxWidthPx: number
): { widthPx: number; label: string } {
  const maxMeters = pixelsToCampaignMeters(maxWidthPx, zoom, scaleMetersPerUnit);
  const niceMeters = niceScaleStep(maxMeters);
  const degreesPerPixel = mercatorMetersPerPixel(zoom) / (EARTH_CIRCUMFERENCE_M / 360);
  const fakeUnits = niceMeters / scaleMetersPerUnit;
  const widthPx = fakeUnits / degreesPerPixel;
  return { widthPx, label: formatMeters(niceMeters) };
}

/** Default bounded box for a fresh fictional campaign, centered near the equator. */
export function defaultFictionalBounds(): [number, number, number, number] {
  return [-8, -6, 8, 6];
}
