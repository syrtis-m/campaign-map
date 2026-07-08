/**
 * Route connections between settlements: each settlement connects to its
 * k-nearest neighbors within a max distance — a purely local, pairwise rule
 * (not a global MST/greedy pass), so it can't diverge across a tile edge as
 * long as the halo covers the search radius. A true MST would give a
 * cleaner network but is globally coupled — the whole point set can shift
 * which edges are minimal, which is exactly the order-dependence class the
 * seam gate is designed to catch. Tier B territory for later refinement.
 */
import { hashSeed } from "../rng";
import type { BBox } from "../spatialHash";
import { expandBBox } from "../spatialHash";
import { clipPolylineToBBox } from "../clip";
import type { GenerationConstraints } from "../types";
import { ROUTE_K_NEAREST, ROUTE_MAX_DISTANCE } from "./params";
import { settlementCandidates, type SettlementSite } from "./settlements";

function pairKey(a: SettlementSite, b: SettlementSite): string {
  const idA = `${a.cellX},${a.cellY}`;
  const idB = `${b.cellX},${b.cellY}`;
  return idA < idB ? `${idA}|${idB}` : `${idB}|${idA}`;
}

/** `(seed, bbox, constraints) => Feature[]` — LineString features connecting nearby settlements. */
export function generateRoutes(
  campaignSeed: number,
  bbox: BBox,
  constraints: GenerationConstraints
): GeoJSON.Feature[] {
  const haloBBox = expandBBox(bbox, ROUTE_MAX_DISTANCE);
  const settlements = settlementCandidates(campaignSeed, haloBBox, constraints);
  if (settlements.length < 2) return [];

  const seen = new Set<string>();
  const features: GeoJSON.Feature[] = [];

  for (const s of settlements) {
    const neighbors = settlements
      .filter((o) => o !== s)
      .map((o) => ({ o, d: Math.hypot(o.x - s.x, o.y - s.y) }))
      .filter(({ d }) => d <= ROUTE_MAX_DISTANCE)
      .sort((a, b) => a.d - b.d || a.o.x - b.o.x || a.o.y - b.o.y)
      .slice(0, ROUTE_K_NEAREST);

    for (const { o } of neighbors) {
      const key = pairKey(s, o);
      if (seen.has(key)) continue;
      seen.add(key);

      const line = [
        { x: s.x, y: s.y },
        { x: o.x, y: o.y },
      ];
      const parts = clipPolylineToBBox(line, bbox);
      parts.forEach((part, i) => {
        if (part.length < 2) return;
        features.push({
          type: "Feature",
          id: hashSeed(campaignSeed, key, "route", i),
          geometry: { type: "LineString", coordinates: part.map((p) => [p.x, p.y]) },
          properties: { generated: true, generatorId: "world-route", type: "route" },
        });
      });
    }
  }

  features.sort((a, b) => {
    const ca = (a.geometry as GeoJSON.LineString).coordinates[0];
    const cb = (b.geometry as GeoJSON.LineString).coordinates[0];
    return ca[0] - cb[0] || ca[1] - cb[1];
  });
  return features;
}
