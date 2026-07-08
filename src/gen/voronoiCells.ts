/**
 * Shared Voronoi-cell generation for any seed-point-driven area feature
 * (city districts, world regions). d3-delaunay's triangulation is
 * geometrically unique for points in general position, so cell shape near a
 * tile edge is stable across tiles as long as both include the same local
 * neighborhood of sites — hence the halo, generous relative to site spacing.
 *
 * Lesson from city/districts.ts: too small a halo lets the halo bbox's own
 * outer clip rectangle (not a real neighbor bisector) leak into cell shapes
 * near the requested tile, and that artificial clip differs between two
 * tiles whose halo rectangles aren't the same shape. 8x cell size resolved
 * it there; kept as the shared default.
 */
import { Delaunay } from "d3-delaunay";
import type { BBox, GridPoint } from "./spatialHash";
import { expandBBox, jitteredGridPoints } from "./spatialHash";
import { clipPolygonToBBox } from "./clip";

export const VORONOI_HALO_MULTIPLIER = 8;

type Pt = [number, number];

export interface VoronoiCell {
  site: GridPoint;
  siteIndex: number;
  /** Closed ring, clipped to `bbox` (the requested tile, not the halo). */
  ring: Pt[];
}

export function ensureClosedRing(ring: Pt[]): Pt[] {
  if (ring.length === 0) return ring;
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) return ring;
  return [...ring, first];
}

/**
 * Generates Voronoi cells whose sites fall in a halo-padded region around
 * `bbox`, clipped to `bbox`. `salt` distinguishes independent site sets
 * (e.g. "district-seed" vs "world-region-seed") sharing the same campaign
 * seed and cell size.
 */
export function generateVoronoiCells(
  campaignSeed: number,
  bbox: BBox,
  cellSize: number,
  salt: string,
  haloMultiplier: number = VORONOI_HALO_MULTIPLIER
): VoronoiCell[] {
  const halo = cellSize * haloMultiplier;
  const haloBBox = expandBBox(bbox, halo);
  const sites = jitteredGridPoints(campaignSeed, haloBBox, cellSize, salt);
  if (sites.length < 2) return [];

  const delaunay = Delaunay.from(sites.map((s): Pt => [s.x, s.y]));
  const voronoi = delaunay.voronoi([haloBBox.minX, haloBBox.minY, haloBBox.maxX, haloBBox.maxY]);

  const cells: VoronoiCell[] = [];
  sites.forEach((site, i) => {
    const cell = voronoi.cellPolygon(i) as Pt[] | null;
    if (!cell) return;
    const clipped = clipPolygonToBBox(cell, bbox);
    if (clipped.length < 3) return;
    cells.push({ site, siteIndex: i, ring: ensureClosedRing(clipped) });
  });

  cells.sort((a, b) => a.ring[0][0] - b.ring[0][0] || a.ring[0][1] - b.ring[0][1]);
  return cells;
}
