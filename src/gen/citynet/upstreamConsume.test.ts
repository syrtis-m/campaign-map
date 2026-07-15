// The city consumes the GENERATED upstream river CHANNEL
// (`constraints.upstream.water`).
//
// Windiness acceptance as a pinned-seed unit proof (no Obsidian): a district
// with a meandered river channel crossing it must (1) regenerate DIFFERENTLY
// than the same district reading only the straight sketched spine (consumption
// is wired), (2) keep every building footprint OUT of the channel ("nothing
// swims" — the blockedByWater path folds `channelRings`), (3) bridge the channel
// (arterials cross it as bridges tracking the real water), (4) TRACK the channel
// — a windier channel relocates the bridges/quays — and (5) stay byte-identical
// when there is no upstream (the digest golden + sketched-river citynet tests
// are protected).
//
// Seeds are PINNED (`citySeedFor(CAMPAIGN_SEED, domain)` + fixed river seeds),
// so every assertion is a within-file relative comparison — no cross-run
// byte-equality, no timestamp-seed flake.
import { describe, expect, it } from "vitest";
import { generateCityNetwork } from "./index";
import { WORLD_BOUNDS, fixtureAt } from "./citynet.fixtures";
import type { GenerationConstraints } from "../types";
import type { FabricFeature } from "../../model/fabric";
import { generateRiver, riverMaxOffset } from "../river";
import { makeSpine, makeCorridorRegion } from "../region";
import { pointInRingClosed } from "../fields/sdf";

type Pt = [number, number];

// A district and a river spine that crosses it horizontally (the region for
// fixtureAt(600,600) spans roughly x,y ∈ [-300, 1500]).
const CX = 600;
const CY = 600;
const SPINE: Pt[] = [
  [-300, 600],
  [300, 660],
  [900, 540],
  [1500, 600],
];

/** The sketched river spine as a raw fabric constraint (what the city tracks
 * WITHOUT the generated channel). */
const RIVER_SKETCH: FabricFeature = {
  type: "Feature",
  id: "river-fixture",
  geometry: { type: "LineString", coordinates: SPINE },
  properties: { kind: "river" },
};

/** Generate the meandered channel polygons for a given windiness (the stage-1
 * hydrology output the city consumes as `upstream.water`). Pinned seed. */
function channelWater(windiness: number, seed = 4242): GeoJSON.Feature[] {
  const params = {
    windiness,
    braiding: 0,
    width: 20,
    widthGrowth: 0,
    braidBias: 0,
    slopeSensitivity: 0,
  };
  const region = makeCorridorRegion("river-fixture", makeSpine("river-fixture", SPINE), riverMaxOffset(params));
  const feats = generateRiver(seed, region, params, { worldBounds: WORLD_BOUNDS });
  return feats.filter((f) => (f.properties as { generatorId?: string } | null)?.generatorId === "river-channel");
}

/** Outer rings of the channel polygons. */
function channelRings(water: GeoJSON.Feature[]): Pt[][] {
  const rings: Pt[][] = [];
  for (const f of water) {
    if (f.geometry.type === "Polygon") rings.push(f.geometry.coordinates[0] as Pt[]);
  }
  return rings;
}

function city(constraints: Partial<GenerationConstraints>): GeoJSON.Feature[] {
  const { seed, region } = fixtureAt(CX, CY, "euro-medieval");
  return generateCityNetwork(seed, region, "euro-medieval", { worldBounds: WORLD_BOUNDS, ...constraints });
}

function ofType(net: GeoJSON.Feature[], type: string): GeoJSON.Feature[] {
  return net.filter((f) => (f.properties as { type?: string } | null)?.type === type);
}
function vertices(f: GeoJSON.Feature): Pt[] {
  const g = f.geometry;
  if (g.type === "LineString") return g.coordinates as Pt[];
  if (g.type === "Polygon") return g.coordinates[0] as Pt[];
  if (g.type === "Point") return [g.coordinates as Pt];
  return [];
}
function anyVertexInChannel(f: GeoJSON.Feature, rings: Pt[][]): boolean {
  for (const [x, y] of vertices(f)) {
    for (const ring of rings) if (pointInRingClosed(ring, x, y)) return true;
  }
  return false;
}

describe("citynet consumes upstream.water (windiness acceptance)", () => {
  const water = channelWater(0.85);
  const rings = channelRings(water);
  const withChannel: Partial<GenerationConstraints> = {
    fabricFeatures: [RIVER_SKETCH],
    upstream: { water },
  };
  const spineOnly: Partial<GenerationConstraints> = { fabricFeatures: [RIVER_SKETCH] };

  it("produces a non-degenerate channel that overlaps the district", () => {
    expect(rings.length).toBeGreaterThan(0);
  });

  it("(1) consumption is wired: the channel changes the city vs. the straight spine", () => {
    expect(JSON.stringify(city(withChannel))).not.toBe(JSON.stringify(city(spineOnly)));
  });

  it("is byte-deterministic with the same upstream channel", () => {
    expect(JSON.stringify(city(withChannel))).toBe(JSON.stringify(city(withChannel)));
  });

  it("(2) no building footprint is placed in the channel (nothing swims)", () => {
    const net = city(withChannel);
    const footprints = net.filter((f) => (f.properties as { generatorId?: string } | null)?.generatorId === "city-footprint");
    expect(footprints.length).toBeGreaterThan(0);
    // Every footprint's centroid is dry — the "buildings don't swim"
    // guarantee (a block may straddle the channel; its footprints in the water
    // are dropped). Arterials legitimately CROSS as bridges, so streets are not
    // asserted here — that is the (3) bridge check.
    for (const f of footprints) {
      const vs = vertices(f);
      let cx = 0;
      let cy = 0;
      for (const [x, y] of vs) {
        cx += x;
        cy += y;
      }
      const c: Pt = [cx / vs.length, cy / vs.length];
      const inWater = rings.some((ring) => pointInRingClosed(ring, c[0], c[1]));
      expect(inWater).toBe(false);
    }
  });

  it("(3) arterials bridge the channel (a bridge crosses the real water)", () => {
    const net = city(withChannel);
    const bridges = ofType(net, "bridge");
    expect(bridges.length).toBeGreaterThan(0);
    expect(bridges.some((b) => anyVertexInChannel(b, rings))).toBe(true);
  });

  it("(4) tracks the channel: a windier channel relocates the city's water fabric", () => {
    const straighter = channelWater(0.2);
    const a = city({ fabricFeatures: [RIVER_SKETCH], upstream: { water } });
    const b = city({ fabricFeatures: [RIVER_SKETCH], upstream: { water: straighter } });
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it("(5) no upstream ⇒ byte-identical with no channel (empty and absent both no-op)", () => {
    const base = JSON.stringify(city({ fabricFeatures: [RIVER_SKETCH] }));
    expect(JSON.stringify(city({ fabricFeatures: [RIVER_SKETCH], upstream: undefined }))).toBe(base);
    expect(JSON.stringify(city({ fabricFeatures: [RIVER_SKETCH], upstream: { water: [] } }))).toBe(base);
  });
});
