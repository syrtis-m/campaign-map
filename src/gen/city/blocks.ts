/**
 * Block subdivision + footprints, recursively bisecting each (already
 * tile-clipped) district polygon. Each split is a pure function of the
 * polygon's own vertices + a seed keyed to the recursion path — never of
 * neighboring polygons or generation order — so it needs no halo of its
 * own: it can't diverge across a tile edge because it never looks past the
 * district boundary it was handed, and that boundary already matches
 * exactly between tiles (districts.ts).
 */
import { hashSeed, mulberry32 } from "../rng";
import type { BBox } from "../spatialHash";
import type { GenerationConstraints } from "../types";
import { clipPolygonToBBox } from "../clip";
import { blockedByWater, indexFabricConstraints } from "../fabricConstraints";
import { ensureClosed, generateDistricts } from "./districts";

// Tuning per docs/06 §3: block subdivision min-area 400m^2.
export const BLOCK_MIN_AREA = 400;
export const BLOCK_MAX_DEPTH = 6;

type Pt = [number, number];

function polygonArea(ring: Pt[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

function ringBBox(ring: Pt[]): BBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

function subdivide(ring: Pt[], campaignSeed: number, path: string, depth: number): Pt[][] {
  const area = polygonArea(ring);
  if (area < BLOCK_MIN_AREA * 2 || depth >= BLOCK_MAX_DEPTH) return [ring];

  const box = ringBBox(ring);
  const w = box.maxX - box.minX;
  const h = box.maxY - box.minY;
  const rng = mulberry32(hashSeed(campaignSeed, path, "block-split"));
  const ratio = 0.35 + rng() * 0.3;

  let left: Pt[];
  let right: Pt[];
  if (w >= h) {
    const splitX = box.minX + w * ratio;
    left = clipPolygonToBBox(ring, { minX: -Infinity, minY: -Infinity, maxX: splitX, maxY: Infinity });
    right = clipPolygonToBBox(ring, { minX: splitX, minY: -Infinity, maxX: Infinity, maxY: Infinity });
  } else {
    const splitY = box.minY + h * ratio;
    left = clipPolygonToBBox(ring, { minX: -Infinity, minY: -Infinity, maxX: Infinity, maxY: splitY });
    right = clipPolygonToBBox(ring, { minX: -Infinity, minY: splitY, maxX: Infinity, maxY: Infinity });
  }

  const result: Pt[][] = [];
  if (left.length >= 3) result.push(...subdivide(left, campaignSeed, path + "L", depth + 1));
  if (right.length >= 3) result.push(...subdivide(right, campaignSeed, path + "R", depth + 1));
  return result.length > 0 ? result : [ring];
}

function footprintFor(ring: Pt[]): Pt[] | null {
  const box = ringBBox(ring);
  const w = box.maxX - box.minX;
  const h = box.maxY - box.minY;
  const inset = Math.min(w, h) * 0.15;
  const fx0 = box.minX + inset;
  const fx1 = box.maxX - inset;
  const fy0 = box.minY + inset;
  const fy1 = box.maxY - inset;
  if (fx1 <= fx0 || fy1 <= fy0) return null;
  return ensureClosed([
    [fx0, fy0],
    [fx1, fy0],
    [fx1, fy1],
    [fx0, fy1],
  ]);
}

/** `(seed, bbox, constraints) => Feature[]` — block + footprint polygons within each district. */
export function generateCityBlocks(
  campaignSeed: number,
  bbox: BBox,
  constraints: GenerationConstraints
): GeoJSON.Feature[] {
  const districts = generateDistricts(campaignSeed, bbox, constraints);
  const features: GeoJSON.Feature[] = [];
  // District-site drops (districts.ts) already exclude claimed ground; this
  // additionally drops individual blocks whose own center falls in sketched
  // water — a kept district can still lap a shoreline. Pure function of the
  // block's own vertices (blocks never cross tile edges: districts are
  // pre-clipped), so it can't diverge across a seam.
  const fabric = indexFabricConstraints(constraints.fabricFeatures);
  const blockCenter = (ring: Pt[]): Pt => {
    const box = ringBBox(ring);
    return [(box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2];
  };

  for (const district of districts) {
    const ring = (district.geometry as GeoJSON.Polygon).coordinates[0] as Pt[];
    const districtPath = `d${district.id}`;
    const blocks = subdivide(ring, campaignSeed, districtPath, 0);

    blocks.forEach((block, blockIndex) => {
      if (block.length < 3) return;
      const [bcx, bcy] = blockCenter(block);
      if (blockedByWater(fabric, bcx, bcy)) return;
      const blockPath = `${districtPath}-b${blockIndex}`;
      features.push({
        type: "Feature",
        id: hashSeed(campaignSeed, blockPath, "block"),
        geometry: { type: "Polygon", coordinates: [ensureClosed(block)] },
        properties: { generated: true, generatorId: "city-block", type: "block", districtId: district.id },
      });

      const footprint = footprintFor(block);
      if (footprint) {
        features.push({
          type: "Feature",
          id: hashSeed(campaignSeed, blockPath, "footprint"),
          geometry: { type: "Polygon", coordinates: [footprint] },
          properties: { generated: true, generatorId: "city-footprint", type: "footprint", districtId: district.id },
        });
      }
    });
  }

  features.sort((a, b) => {
    const ca = (a.geometry as GeoJSON.Polygon).coordinates[0][0];
    const cb = (b.geometry as GeoJSON.Polygon).coordinates[0][0];
    return ca[0] - cb[0] || ca[1] - cb[1] || String(a.id).localeCompare(String(b.id));
  });
  return features;
}
