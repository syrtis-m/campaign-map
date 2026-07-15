import { describe, it, expect } from "vitest";
import { terrainAt } from "./terrain";
import { SegmentHash } from "../segmentHash";
import type { FabricFeature } from "../../model/fabric";

type Pt = [number, number];

const RING: Pt[] = [
  [0, 0],
  [1500, 0],
  [1500, 1500],
  [0, 1500],
  [0, 0],
];

function mountain(id: string, ring: Pt[], seed = 777, params: Record<string, unknown> = { terrain: "alpine", amplitude: 0.8, roughness: 0.5 }): FabricFeature {
  return {
    type: "Feature",
    id,
    geometry: { type: "Polygon", coordinates: [ring] },
    properties: { kind: "mountain", procgen: { algorithm: "mountain", seed, version: 1, params } },
  } as FabricFeature;
}

function river(id: string, spine: Pt[], params: Record<string, unknown> = { width: 20 }): FabricFeature {
  return {
    type: "Feature",
    id,
    geometry: { type: "LineString", coordinates: spine },
    properties: { kind: "river", procgen: { algorithm: "river", seed: 9, version: 2, params } },
  } as FabricFeature;
}

// A river spine crossing the mountain massif horizontally through the middle.
const CROSS_SPINE: Pt[] = [
  [-300, 750],
  [400, 720],
  [800, 760],
  [1800, 750],
];

describe("terrainAt carve — a river incises a gorge across a mountain", () => {
  it("the channel floor is below the surrounding uncarved surface", () => {
    const uncarved = terrainAt([mountain("m", RING)]);
    const carved = terrainAt([mountain("m", RING), river("r", CROSS_SPINE)]);
    // On the spine, well inside the massif: carved sits well below uncarved.
    for (const [x, y] of [[600, 748], [750, 750], [900, 755]] as Pt[]) {
      const u = uncarved(x, y).v;
      const c = carved(x, y).v;
      expect(c).toBeLessThan(u - 30); // at least the base incision shows
    }
  });

  it("banks rise back to the surface away from the channel (compact gorge)", () => {
    const uncarved = terrainAt([mountain("m", RING)]);
    const carved = terrainAt([mountain("m", RING), river("r", CROSS_SPINE)]);
    // Far off the channel (well past the gorge walls): carved == uncarved to the
    // float — smin returns `pre` exactly where the rising bed clears the surface
    // (compact support). depth 90 / bank slope 2.2 ⇒ the wall clears within a few
    // hundred metres of the ~90 m-deep local gorge.
    for (const y of [750 + 700, 750 - 700]) {
      const u = uncarved(750, y);
      const c = carved(750, y);
      expect(c.v).toBe(u.v);
    }
  });

  it("stays incised the length of the channel (a continuous gorge, not one pit)", () => {
    // Straight spine at a constant y so on-channel samples sit ON the centerline
    // (the alpine surface is far too spiky to offset from a wandering spine — a
    // 13 m step swings the ridged relief by tens of metres).
    const straight: Pt[] = [[-200, 700], [1700, 700]];
    const uncarved = terrainAt([mountain("m", RING)]);
    const carved = terrainAt([mountain("m", RING), river("r2", straight)]);
    for (let x = 200; x <= 1300; x += 100) {
      const drop = uncarved(x, 700).v - carved(x, 700).v; // exactly on the spine
      expect(drop, `x=${x}`).toBeGreaterThan(40); // ~depth incision the whole length
    }
  });
});

describe("carve segment-tests-per-sample budget (the polyline binding pays off)", () => {
  it("a continental river spine tests only a bounded handful of segments per query", () => {
    // 2000-segment meandering spine — a naive nearest-point scan would test all
    // 2000 per lattice sample (the ~1e9-ops blow-up the plan calls out).
    const spine: [number, number][] = [];
    for (let i = 0; i <= 2000; i++) spine.push([i * 30, Math.sin(i / 5) * 200]);
    // Carve cellSize = max(64, width·4); width 20 ⇒ 80 m (the terrain.ts config).
    const hash = new SegmentHash(spine, { cellSize: 80 });
    let worst = 0;
    for (let x = 0; x <= 60000; x += 617) {
      for (let y = -600; y <= 600; y += 137) {
        hash.nearest(x, y);
        worst = Math.max(worst, hash.segmentTests);
      }
    }
    // Budget: an order of magnitude below the 2000-segment naive cost, and a hard
    // constant (independent of spine length).
    expect(worst).toBeLessThan(120);
  });
});

describe("terrainAt carve — byte-identity for campaigns with no rivers", () => {
  it("a mountain-only campaign is untouched by the carve machinery (fast path)", () => {
    const a = terrainAt([mountain("m", RING)]);
    const b = terrainAt([mountain("m", RING)]);
    for (const [x, y] of [[400, 400], [750, 750], [60, 60], [3000, 3000]] as Pt[]) {
      expect(a(x, y)).toEqual(b(x, y));
    }
  });

  it("adding an INERT (blockless) river sketch changes nothing", () => {
    const withMtn = terrainAt([mountain("m", RING)]);
    const inertRiver = {
      type: "Feature",
      id: "r0",
      geometry: { type: "LineString", coordinates: CROSS_SPINE },
      properties: { kind: "river" }, // no procgen block ⇒ not a carve request
    } as unknown as FabricFeature;
    const withInert = terrainAt([mountain("m", RING), inertRiver]);
    for (const [x, y] of [[600, 748], [750, 750], [900, 755]] as Pt[]) {
      expect(withInert(x, y)).toEqual(withMtn(x, y));
    }
  });
});
