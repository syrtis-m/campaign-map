// Plan 038 item 8 — wall water refinements.
//
// Where the wall spine crosses GENERATED water (the river channel or a city
// canal), a `wall-gate` with `waterGate: true` (a sluice/river-gate marker,
// distinct from a road gatehouse) sits at the bank crossing; and — with a moat —
// the moat SNAPS to the bank (a `leat: true` junction quad) instead of ending a
// resample-step short. City canals now ride into the settlement payload
// (`canalLines`) so the wall reads them as water. Pinned seeds; asserts:
//   (1) a spine crossing a generated channel mints water-gate markers at the banks,
//   (2) a spine crossing a canal (fed via the settlement payload) mints a water-gate,
//   (3) with a moat, the straddle step snaps to the bank (a leat quad appears),
//   (4) NO upstream water AND no canal ⇒ byte-identical to the uncoupled wall,
//   (5) the settlement payload splits canal LineStrings out of `city-landmark`.
import { describe, expect, it } from "vitest";
import { generateWall, wallMaxOffset } from "./wall";
import { generateRiver, riverMaxOffset } from "./river";
import { makeSpine, makeCorridorRegion } from "./region";
import { buildUpstreamWaterField, buildSettlementPayload } from "./upstream";
import type { GenerationConstraints } from "./types";
import type { BBox } from "./spatialHash";

type Pt = [number, number];

const WORLD: BBox = { minX: -5000, minY: -5000, maxX: 5000, maxY: 5000 };

// A horizontal wall spine along y = 0 (so a vertical river crosses both banks).
const SPINE: Pt[] = [
  [-300, 0],
  [-100, 0],
  [100, 0],
  [300, 0],
];
const PARAMS = { style: "curtain-wall" as const, towerSpacing: 60, moat: false, gatehouseScale: 1 };
const MOAT_PARAMS = { ...PARAMS, moat: true };
const SEED = 33221;

function wallRegion(params = PARAMS) {
  return makeCorridorRegion("wwg-wall", makeSpine("wwg-wall", SPINE), wallMaxOffset(params));
}

/** A wide generated river channel crossing the spine vertically near x = 0. */
function channelWater(): GeoJSON.Feature[] {
  const rSpine: Pt[] = [[0, -200], [8, -60], [-8, 60], [0, 200]];
  const rp = { windiness: 0.2, braiding: 0, width: 44, widthGrowth: 0, braidBias: 0, slopeSensitivity: 0 };
  const rRegion = makeCorridorRegion("wwg-river", makeSpine("wwg-river", rSpine), riverMaxOffset(rp));
  return generateRiver(4242, rRegion, rp, { worldBounds: WORLD }).filter(
    (f) => (f.properties as { generatorId?: string }).generatorId === "river-channel"
  );
}

function waterGates(feats: GeoJSON.Feature[]): GeoJSON.Feature[] {
  return feats.filter((f) => (f.properties as { waterGate?: boolean }).waterGate === true);
}

describe("wall water refinements (plan 038 item 8)", () => {
  it("(1) a spine crossing the generated channel mints water-gate markers at the banks", () => {
    const water = channelWater();
    expect(water.length).toBeGreaterThan(0);
    const feats = generateWall(SEED, wallRegion(), PARAMS, { worldBounds: WORLD, upstream: { water } });
    const wg = waterGates(feats);
    // A vertical river crossing a horizontal wall enters and exits ⇒ two banks.
    expect(wg.length).toBe(2);
    const chan = buildUpstreamWaterField({ water })!;
    for (const g of wg) {
      const [x, y] = (g.geometry as GeoJSON.Point).coordinates as Pt;
      // The marker sits ON the bank (field ≈ 0), never deep in the channel.
      expect(Math.abs(chan(x, y))).toBeLessThan(1);
      expect((g.properties as { bearing?: number }).bearing).toBeUndefined(); // a sluice, not a road gate
    }
  });

  it("(2) a spine crossing a city canal (fed via the settlement payload) mints a water-gate", () => {
    // A `city-landmark` type=canal LineString (as MapController now feeds it).
    const canal: GeoJSON.Feature = {
      type: "Feature",
      id: "canal-1",
      geometry: { type: "LineString", coordinates: [[0, -120], [0, 120]] },
      properties: { generatorId: "city-landmark", type: "canal" },
    };
    const feats = generateWall(SEED, wallRegion(), PARAMS, { worldBounds: WORLD, upstream: { settlement: [canal] } });
    const wg = waterGates(feats);
    expect(wg.length).toBe(1); // one straight canal crosses the spine once
    const [x] = (wg[0].geometry as GeoJSON.Point).coordinates as Pt;
    expect(Math.abs(x)).toBeLessThan(5);
  });

  it("(3) with a moat, the straddle step snaps to the bank (a leat junction quad appears)", () => {
    const water = channelWater();
    const feats = generateWall(SEED, wallRegion(MOAT_PARAMS), MOAT_PARAMS, { worldBounds: WORLD, upstream: { water } });
    const leats = feats.filter((f) => (f.properties as { leat?: boolean }).leat === true);
    expect(leats.length).toBeGreaterThan(0);
    // Every leat is a `wall-moat` quad and stays within the corridor bound.
    const bound = wallMaxOffset(MOAT_PARAMS);
    for (const f of leats) {
      expect((f.properties as { generatorId?: string }).generatorId).toBe("wall-moat");
      for (const [x, y] of (f.geometry as GeoJSON.Polygon).coordinates[0] as Pt[]) {
        // distance to the horizontal spine (y = 0) ≤ corridor bound.
        expect(Math.abs(y)).toBeLessThanOrEqual(bound + 0.01);
      }
    }
  });

  it("(4) no upstream water and no canal ⇒ byte-identical to the uncoupled wall", () => {
    const base = JSON.stringify(generateWall(SEED, wallRegion(MOAT_PARAMS), MOAT_PARAMS, { worldBounds: WORLD }));
    expect(
      JSON.stringify(generateWall(SEED, wallRegion(MOAT_PARAMS), MOAT_PARAMS, { worldBounds: WORLD, upstream: undefined }))
    ).toBe(base);
    // A settlement payload with streets but NO canal + no water: still no water-gate.
    const street: GeoJSON.Feature = {
      type: "Feature",
      id: "s1",
      geometry: { type: "LineString", coordinates: [[0, -80], [0, 80]] },
      properties: { generatorId: "city-street", type: "street", roadClass: "street" },
    };
    const withStreet = generateWall(SEED, wallRegion(), PARAMS, { worldBounds: WORLD, upstream: { settlement: [street] } });
    expect(waterGates(withStreet).length).toBe(0);
  });

  it("(5) the settlement payload splits canal LineStrings out of the street set", () => {
    const canal: GeoJSON.Feature = {
      type: "Feature",
      id: "canal-2",
      geometry: { type: "LineString", coordinates: [[0, 0], [50, 0]] },
      properties: { generatorId: "city-landmark", type: "canal" },
    };
    const street: GeoJSON.Feature = {
      type: "Feature",
      id: "s2",
      geometry: { type: "LineString", coordinates: [[0, 10], [50, 10]] },
      properties: { generatorId: "city-street", type: "street", roadClass: "arterial" },
    };
    const payload = buildSettlementPayload({ settlement: [canal, street] })!;
    expect(payload.canalLines.length).toBe(1);
    expect(payload.streets.length).toBe(1);
    expect(payload.streets[0].roadClass).toBe("arterial");
  });
});
