// Slow fuzz/stress tier for citynet — split out of citynet.test.ts (plan 021
// §2.1) so the fast unit suite (`npm test`) stays <30 s. These two describes
// dominated the old ~125 s suite (~50 s + ~19 s); they run only at phase and
// pre-merge gates via `npm run test:fuzz`. Not deleted, not weakened — moved.
import { describe, expect, it } from "vitest";
import { generateCityNetwork, type ProfileId } from "./index";
import { makeRegion, type ProcgenRegion } from "../region";
import { hashSeed, mulberry32 } from "../rng";
import type { FabricFeature } from "../../model/fabric";
import { WORLD_BOUNDS, net, riverThrough, allCoordsInside } from "./citynet.fixtures";

describe("v3.1/v3.4 200-region fuzz (gate e, anti-Watabou — all four profiles)", () => {
  it("200 hashed disc regions (50 per profile) generate without throwing, each within budget", () => {
    const fuzzProfiles: ProfileId[] = ["euro-medieval", "euro-continental", "na-grid", "na-suburb"];
    const t0 = Date.now();
    for (let i = 0; i < 200; i++) {
      const rng = mulberry32(hashSeed(4242, "fuzz", i));
      const cx = Math.round((rng() - 0.5) * 5000);
      const cy = Math.round((rng() - 0.5) * 5000);
      const radius = 400 + Math.round(rng() * 1100);
      const fabric: FabricFeature[] = [];
      if (i % 5 === 0) fabric.push(riverThrough(cy + Math.round((rng() - 0.5) * radius)));
      if (i % 7 === 0) {
        fabric.push({
          type: "Feature",
          id: `road-${i}`,
          geometry: {
            type: "LineString",
            coordinates: [
              [cx - radius, cy - Math.round(radius * 0.4)],
              [cx + radius, cy + Math.round(radius * 0.4)],
            ],
          },
          properties: { kind: "road" },
        });
      }
      const runStart = Date.now();
      const network = net(cx, cy, fuzzProfiles[i % 4], { fabricFeatures: fabric }, radius);
      expect(network.length).toBeGreaterThan(0);
      expect(Date.now() - runStart).toBeLessThan(5000); // per-run wall clock sane
    }
    expect(Date.now() - t0).toBeLessThan(180000);
  }, 240000);
});

describe("v4.0 4-profile polygon fuzz (plan 020 gate f)", () => {
  /** Deterministic random SIMPLE polygon: radial-monotone star (angles
   * ascending ⇒ no self-intersection), scaled to an exact target
   * effectiveRadius. 5–10 vertices. */
  function randomRegion(i: number): ProcgenRegion {
    const rng = mulberry32(hashSeed(7777, "poly", i));
    const n = 5 + Math.floor(rng() * 6); // 5–10 vertices
    const cx = Math.round((rng() - 0.5) * 6000);
    const cy = Math.round((rng() - 0.5) * 6000);
    const targetR = 400 + rng() * 1100; // effectiveRadius 400–1500
    const pts: [number, number][] = [];
    for (let k = 0; k < n; k++) {
      const ang = ((k + 0.4 * (rng() - 0.5)) / n) * 2 * Math.PI;
      const rad = targetR * (0.55 + 0.9 * rng());
      pts.push([cx + rad * Math.cos(ang), cy + rad * Math.sin(ang)]);
    }
    // Scale about the center so area = π·targetR² exactly (pre-quantization).
    let area2 = 0;
    for (let k = 0; k < n; k++) {
      const [ax, ay] = pts[k];
      const [bx, by] = pts[(k + 1) % n];
      area2 += ax * by - bx * ay;
    }
    const s = Math.sqrt((Math.PI * targetR * targetR) / Math.abs(area2 / 2));
    const ring: [number, number][] = pts.map(([x, y]) => [cx + (x - cx) * s, cy + (y - cy) * s]);
    ring.push(ring[0]);
    return makeRegion(`fuzz-poly-${i}`, ring);
  }

  const fuzzProfiles: ProfileId[] = ["euro-medieval", "euro-continental", "na-grid", "na-suburb"];

  it("30 random simple polygons × 4 profiles: no throw, all output inside", () => {
    for (let i = 0; i < 30; i++) {
      const region = randomRegion(i);
      for (const profile of fuzzProfiles) {
        const seed = hashSeed(7777, "fuzzseed", i, profile);
        let network: GeoJSON.Feature[] = [];
        expect(() => {
          network = generateCityNetwork(seed, region, profile, { worldBounds: WORLD_BOUNDS });
        }).not.toThrow();
        expect(network.length).toBeGreaterThan(0);
        expect(allCoordsInside(network, region)).toBe(true);
      }
    }
  }, 300000);
});
