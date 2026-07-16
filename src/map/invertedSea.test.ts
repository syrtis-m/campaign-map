import { describe, it, expect } from "vitest";
import {
  invertedSeaBounds,
  invertedSeaLandHoles,
  invertedSeaDonutRings,
  invertedSeaLabelPoint,
} from "./invertedSea";
import { pointInRingClosed } from "../gen/fields/sdf";
import { defaultFictionalBounds } from "./fictionalCRS";
import type { FabricFeature } from "../model/fabric";

type Pt = [number, number];

function landform(id: string, ring: Pt[], params: Record<string, unknown>, name?: string): FabricFeature {
  return {
    type: "Feature",
    id,
    geometry: { type: "Polygon", coordinates: [ring] },
    properties: { kind: "landform", name, procgen: { algorithm: "landform", seed: 3, version: 1, params } },
  } as FabricFeature;
}

function mountain(id: string, ring: Pt[]): FabricFeature {
  return {
    type: "Feature",
    id,
    geometry: { type: "Polygon", coordinates: [ring] },
    properties: { kind: "mountain", procgen: { algorithm: "mountain", seed: 7, version: 1, params: {} } },
  } as FabricFeature;
}

// A big campaign box with a small island coast centred at the origin — the layout
// that made "The Deep" label mid-island and the islet paint as water.
const BOUNDS: [number, number, number, number] = [-100, -100, 100, 100];
const COAST: Pt[] = [[-10, -10], [10, -10], [10, 10], [-10, 10], [-10, -10]];
const SEA = landform("sea", COAST, { mode: "sea", band: 5, invert: true }, "The Deep");

// An islet plateau out in the water (exterior), far from the main coast.
const ISLET: Pt[] = [[60, 60], [70, 60], [70, 70], [60, 70], [60, 60]];

describe("invertedSeaBounds", () => {
  it("passes through explicit config bounds", () => {
    expect(invertedSeaBounds([1, 2, 3, 4], false, COAST)).toEqual([1, 2, 3, 4]);
  });
  it("uses the fictional default when no bounds and not real", () => {
    expect(invertedSeaBounds(undefined, false, COAST)).toEqual(defaultFictionalBounds());
  });
  it("expands the coast bbox 5× for a real campaign without bounds", () => {
    const b = invertedSeaBounds(undefined, true, COAST);
    // coast bbox is [-10,-10,10,10], span 20 → expand ±100 each side.
    expect(b).toEqual([-110, -110, 110, 110]);
  });
});

describe("invertedSeaLandHoles", () => {
  it("cuts a hole for a plateau in the sea's exterior (the islet)", () => {
    const islet = landform("islet", ISLET, { mode: "plateau", target: 20, band: 2 }, "Lighthouse Rock");
    const holes = invertedSeaLandHoles(SEA, [SEA, islet], 0);
    expect(holes).toHaveLength(1);
    expect(holes[0]).toEqual(ISLET);
  });

  it("does NOT cut a hole for a plateau INSIDE the main coast (already dry land)", () => {
    const inner: Pt[] = [[-4, -4], [4, -4], [4, 4], [-4, 4], [-4, -4]]; // centroid inside COAST
    const plat = landform("inner", inner, { mode: "plateau", target: 20, band: 2 });
    expect(invertedSeaLandHoles(SEA, [SEA, plat], 0)).toEqual([]);
  });

  it("ignores landforms that do not rise above the sea datum (a default basin)", () => {
    const basin = landform("basin", ISLET, { mode: "basin", band: 2 });
    expect(invertedSeaLandHoles(SEA, [SEA, basin], 0)).toEqual([]);
  });

  it("ignores non-landform features and never holes the sea itself", () => {
    const mtn = mountain("m", ISLET);
    expect(invertedSeaLandHoles(SEA, [SEA, mtn], 0)).toEqual([]);
  });

  it("id-sorts multiple island holes deterministically", () => {
    const a = landform("z-isle", ISLET, { mode: "plateau", target: 20, band: 2 });
    const b = landform("a-isle", [[80, 80], [90, 80], [90, 90], [80, 90], [80, 80]], { mode: "plateau", target: 20, band: 2 });
    const holes = invertedSeaLandHoles(SEA, [SEA, a, b], 0);
    // a-isle sorts before z-isle.
    expect(holes[0][0]).toEqual([80, 80]);
    expect(holes[1][0]).toEqual([60, 60]);
  });
});

describe("invertedSeaDonutRings", () => {
  it("returns [outerBox, coast, ...landHoles] with the box as ring[0]", () => {
    const rings = invertedSeaDonutRings(BOUNDS, COAST, [ISLET]);
    expect(rings).toHaveLength(3);
    // ring[0] = campaign box corners.
    expect(rings[0]).toEqual([[-100, -100], [100, -100], [100, 100], [-100, 100], [-100, -100]]);
    expect(rings[1]).toBe(COAST); // the coast hole
    expect(rings[2]).toBe(ISLET); // the islet hole (Bug 2: islet is an interior ring ⇒ land)
  });
});

describe("invertedSeaLabelPoint — pole of inaccessibility in open water", () => {
  it("places the label OUTSIDE the island coast and inside bounds (not mid-island)", () => {
    const [x, y] = invertedSeaLabelPoint(BOUNDS, COAST, []);
    expect(pointInRingClosed(COAST, x, y)).toBe(false);
    expect(x).toBeGreaterThanOrEqual(-100);
    expect(x).toBeLessThanOrEqual(100);
    expect(y).toBeGreaterThanOrEqual(-100);
    expect(y).toBeLessThanOrEqual(100);
  });

  it("avoids island holes too", () => {
    const [x, y] = invertedSeaLabelPoint(BOUNDS, COAST, [ISLET]);
    expect(pointInRingClosed(COAST, x, y)).toBe(false);
    expect(pointInRingClosed(ISLET, x, y)).toBe(false);
  });

  it("is deterministic (same input ⇒ same point)", () => {
    expect(invertedSeaLabelPoint(BOUNDS, COAST, [ISLET])).toEqual(invertedSeaLabelPoint(BOUNDS, COAST, [ISLET]));
  });

  it("falls back to the box centre when the island fills the box (no water cell)", () => {
    const fullCoast: Pt[] = [[-100, -100], [100, -100], [100, 100], [-100, 100], [-100, -100]];
    expect(invertedSeaLabelPoint(BOUNDS, fullCoast, [])).toEqual([0, 0]);
  });
});
