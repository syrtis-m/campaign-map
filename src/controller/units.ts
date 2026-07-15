/**
 * Pure unit/geometry helpers shared by the host-agnostic MapController and the
 * Obsidian-bound MapView. Convert between a fictional campaign's own
 * coordinates (fake units, 1 unit = `scaleMetersPerUnit` meters —
 * fictionalCRS.ts) and the generators' meter-space WITHOUT importing MapView
 * (which pulls in MapLibre + Obsidian). No DOM/map/Obsidian imports here — same
 * purity rule as src/gen/ (CLAUDE.md).
 */
import type { BBox } from "../gen/spatialHash";

export function boundsToBBox(bounds: [number, number, number, number]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  return { minX: bounds[0], minY: bounds[1], maxX: bounds[2], maxY: bounds[3] };
}

export function unitsToMeters(u: number, scaleMetersPerUnit: number): number {
  return u * scaleMetersPerUnit;
}

export function metersToUnits(m: number, scaleMetersPerUnit: number): number {
  return m / scaleMetersPerUnit;
}

export function bboxUnitsToMeters(b: BBox, scale: number): BBox {
  return {
    minX: unitsToMeters(b.minX, scale),
    minY: unitsToMeters(b.minY, scale),
    maxX: unitsToMeters(b.maxX, scale),
    maxY: unitsToMeters(b.maxY, scale),
  };
}

export function mapCoordinates(coords: unknown, fn: (n: number) => number): unknown {
  if (typeof coords === "number") return fn(coords);
  if (Array.isArray(coords)) return coords.map((c) => mapCoordinates(c, fn));
  return coords;
}

export function transformFeatureUnits(feature: GeoJSON.Feature, fn: (n: number) => number): GeoJSON.Feature {
  const geometry = feature.geometry as unknown as { type: string; coordinates: unknown };
  return {
    ...feature,
    geometry: { ...geometry, coordinates: mapCoordinates(geometry.coordinates, fn) } as GeoJSON.Geometry,
  };
}

/**
 * `GENERATION_TILE_SIZE` is anchored at the generation-space world origin
 * with a fixed size, not to the campaign's own bounds — so a tile can
 * legitimately extend past a small campaign's edges (docs/06 §3 tuning
 * ranges are sized in meters, campaigns can be much smaller than one tile).
 * Filter emitted features to those actually touching `worldBounds` so
 * generated fabric doesn't visibly spill beyond the campaign's own box.
 */
export function featureTouchesBBox(feature: GeoJSON.Feature, bbox: BBox): boolean {
  let touches = false;
  const check = (coords: unknown): void => {
    if (touches) return;
    if (typeof coords === "number") return;
    if (!Array.isArray(coords)) return;
    if (typeof coords[0] === "number" && typeof coords[1] === "number") {
      const [x, y] = coords as [number, number];
      if (x >= bbox.minX && x <= bbox.maxX && y >= bbox.minY && y <= bbox.maxY) touches = true;
      return;
    }
    for (const c of coords) check(c);
  };
  check((feature.geometry as unknown as { coordinates: unknown }).coordinates);
  return touches;
}
