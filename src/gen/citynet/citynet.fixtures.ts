// Shared, non-test fixtures/helpers for the citynet suites.
//
// Extracted (plan 021 §2.1) so the fast unit suite (citynet.test.ts) and the
// slow fuzz/stress tier (citynet.fuzz.test.ts) share ONE definition of these
// helpers instead of duplicating them — the fuzz tier moved to its own file so
// `npm test` stays <30 s while the ~50 s 200-region + ~19 s polygon fuzzes run
// only at phase/pre-merge gates via `npm run test:fuzz`.
//
// This file is NOT collected by vitest (no `.test.ts` suffix); it is a plain
// helper module imported by the two test files.
import { generateCityNetwork, discToRing, makeDomain, citySeedFor, type ProfileId } from "./index";
import { distanceToBoundary, makeRegion, type ProcgenRegion } from "../region";
import type { BBox } from "../spatialHash";
import type { GenerationConstraints } from "../types";
import type { FabricFeature } from "../../model/fabric";

export const WORLD_BOUNDS: BBox = { minX: -4000, minY: -4000, maxX: 4000, maxY: 4000 };
export const CAMPAIGN_SEED = 90210;

/** Disc-shaped fixture (v3 parity): domain → 32-gon region, v3's seed. */
export function fixtureAt(cx: number, cy: number, profile: ProfileId = "euro-medieval", radius = 900) {
  const domain = makeDomain(cx, cy, radius, profile, 0);
  const seed = citySeedFor(CAMPAIGN_SEED, domain);
  const region = makeRegion(`dom-shim:${domain.id}`, discToRing(domain));
  return { domain, seed, region };
}

export function net(
  cx: number,
  cy: number,
  profile: ProfileId = "euro-medieval",
  constraints: Partial<GenerationConstraints> = {},
  radius = 900
) {
  const { seed, region } = fixtureAt(cx, cy, profile, radius);
  return generateCityNetwork(seed, region, profile, { worldBounds: WORLD_BOUNDS, ...constraints });
}

/** A river line that fully bisects the region's cost-field bbox horizontally. */
export function riverThrough(cy: number): FabricFeature {
  return {
    type: "Feature",
    id: "river-1",
    geometry: { type: "LineString", coordinates: [[-4000, cy], [4000, cy]] },
    properties: { kind: "river" },
  };
}

/** Every coordinate of every feature is inside the region (≥ −eps signed
 * distance) — plan 020's "nothing spills past the GM's line". */
export function allCoordsInside(network: GeoJSON.Feature[], region: ProcgenRegion, eps = 0.01): boolean {
  const check = (x: number, y: number): boolean => distanceToBoundary(region, x, y) >= -eps;
  for (const f of network) {
    const g = f.geometry;
    if (g.type === "Point") {
      const [x, y] = g.coordinates as [number, number];
      if (!check(x, y)) return false;
    } else if (g.type === "LineString") {
      for (const [x, y] of g.coordinates as [number, number][]) {
        if (!check(x, y)) return false;
      }
    } else if (g.type === "Polygon") {
      for (const [x, y] of g.coordinates[0] as [number, number][]) {
        if (!check(x, y)) return false;
      }
    }
  }
  return true;
}
