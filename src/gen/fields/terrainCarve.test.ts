import { describe, it, expect } from "vitest";
import { terrainAt, macroTerrainField } from "./terrain";
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

describe("terrainAt carve — water flows downhill (monotone bed, item 7)", () => {
  // A long spine over a BUMPY base (fBm relief): the pre-carve surface climbs and
  // dips along the flow, so a raw `pre − depth` bed would too — the "river goes up
  // and down" bug. The monotone-min bed must NOT climb toward the mouth.
  const bumpy = { base: { campAmp: 300, seaDatum: 0 }, campaignSeed: 11 } as const;
  const longSpine: Pt[] = [];
  for (let i = 0; i <= 40; i++) longSpine.push([i * 120, Math.sin(i / 3) * 60]);

  it("the carved channel core is non-increasing from source to mouth", () => {
    const carved = terrainAt([river("flow", longSpine, { width: 24 })], bumpy);
    // Sample ON the spine (channel core) marching downstream (spine[0] → mouth).
    let prev = Infinity;
    let sawDrop = false;
    for (let i = 0; i <= 40; i++) {
      const [x, y] = longSpine[i];
      const v = carved(x, y).v;
      expect(v, `vertex ${i} climbs (${v} > ${prev})`).toBeLessThanOrEqual(prev + 1e-6);
      if (v < prev - 1) sawDrop = true;
      prev = v;
    }
    expect(sawDrop).toBe(true); // it genuinely descends (not a flat trivial pass)
  });

  it("a raw (bump-tracking) bed WOULD have climbed here — the fix is load-bearing", () => {
    // The pre-carve surface itself is non-monotone along the spine (proof the
    // fixture exercises the bug: an un-graded `pre − depth` bed would inherit these
    // rises).
    const surface = terrainAt([], bumpy);
    let climbs = 0;
    let prev = Infinity;
    for (let i = 0; i <= 40; i++) {
      const v = surface(longSpine[i][0], longSpine[i][1]).v;
      if (v > prev + 1) climbs++;
      prev = v;
    }
    expect(climbs).toBeGreaterThan(0);
  });
});

describe("terrainAt carve — generator inputs untouched (macroTerrainField excludes carve)", () => {
  it("adding a procgen river does not move the macro terrain field a generator reads", () => {
    const feats = [mountain("m", RING)];
    const withRiver = [...feats, river("r", CROSS_SPINE)];
    // A mountain is present ⇒ macroTerrainField is non-null (not the flat shortcut).
    const macroBare = macroTerrainField(feats, { campAmp: 200, seaDatum: 0 }, 5)!;
    const macroRiver = macroTerrainField(withRiver, { campAmp: 200, seaDatum: 0 }, 5)!;
    for (const [x, y] of [[600, 748], [750, 750], [900, 755], [200, 700], [1300, 700]] as Pt[]) {
      expect(macroRiver(x, y)).toEqual(macroBare(x, y)); // carve never enters the generator field
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

  it("a point FAR outside a river's bbox is byte-identical with and without the carve (far-field reject)", () => {
    // The DEM samples several rivers per tile; a point near one river is far from
    // the others, where the carve is provably inert. The far-field fast-reject
    // (compact support) must return `pre` to the FLOAT — same bytes, gradients
    // included. Force BOTH fields through the composed path with a non-flat base
    // (so the reject is compared against the true composed `pre`, not the
    // mountain-only fast path whose signed-zero gradients differ by construction).
    const spine: Pt[] = [[0, 0], [400, 20], [900, -10], [1500, 0]];
    const opts = { base: { campAmp: 200, seaDatum: 0 }, campaignSeed: 3 } as const;
    const feats = [mountain("m", RING), river("far", spine)];
    const carveOff = terrainAt(feats, { ...opts, include: { carve: false } });
    const carveOn = terrainAt(feats, opts);
    // Points thousands of metres from the spine's bbox (the "near a different
    // river" case) and just-outside-the-bbox points alike: reject ⇒ exactly `pre`.
    for (const [x, y] of [[5000, 5000], [-4000, 3000], [750, 4000], [3000, -20], [-2000, 0]] as Pt[]) {
      expect(carveOn(x, y)).toEqual(carveOff(x, y));
    }
    // Sanity: ON the channel the carve is NOT rejected — it genuinely lowers.
    expect(carveOn(750, 5).v).toBeLessThan(carveOff(750, 5).v);
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
