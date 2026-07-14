import { describe, it, expect } from "vitest";
import { elevationFieldFromFabric, mountainHeightField, MOUNTAIN_TERRAINS } from "./mountainField";
import { mountainHeightField as reExported } from "../mountain";
import { makeRegion } from "../region";
import type { FabricFeature } from "../../model/fabric";

type Pt = [number, number];

const RING: Pt[] = [
  [0, 0],
  [1500, 0],
  [1500, 1500],
  [0, 1500],
  [0, 0],
];

function mountainFeature(
  id: string,
  ring: Pt[],
  seed = 777,
  params: Record<string, unknown> = { terrain: "alpine", amplitude: 0.8, roughness: 0.5 }
): FabricFeature {
  return {
    type: "Feature",
    id,
    geometry: { type: "Polygon", coordinates: [ring] },
    properties: { kind: "mountain", procgen: { algorithm: "mountain", seed, version: 1, params } },
  } as FabricFeature;
}

describe("fields/mountainField — the 23-E verbatim move (bit-exactness by construction)", () => {
  it("mountain.ts re-exports the SAME function (no fork, no drift)", () => {
    expect(reExported).toBe(mountainHeightField);
  });

  it("field values match the pre-move behavior shape: positive relief inside, exact zero far outside", () => {
    const region = makeRegion("m", RING);
    const f = mountainHeightField(777, region, { terrain: "alpine", amplitude: 0.8, roughness: 0.5 });
    const inside = f(750, 750);
    expect(inside.v).toBeGreaterThan(0);
    // Mask is EXACTLY 0 outside the ring (smoothstep clamps), so v/dx/dy are
    // exact zeros — the property the river's far-segment byte-identity rides on.
    const outside = f(5000, 5000);
    // (±0 both count: A·0·n.dx is a signed zero, and Math.hypot(±0, ±0) === 0,
    // so the river's slope term is exactly 0 there.)
    expect(Math.abs(outside.v)).toBe(0);
    expect(Math.abs(outside.dx)).toBe(0);
    expect(Math.abs(outside.dy)).toBe(0);
  });
});

describe("fields/elevationFieldFromFabric — the cross-KIND elevation surface (box 23-E)", () => {
  it("returns null with no fabric, empty fabric, or no mountain features", () => {
    expect(elevationFieldFromFabric(undefined)).toBeNull();
    expect(elevationFieldFromFabric([])).toBeNull();
    const road = {
      type: "Feature",
      id: "r1",
      geometry: { type: "LineString", coordinates: [[0, 0], [100, 0]] },
      properties: { kind: "road" },
    } as unknown as FabricFeature;
    expect(elevationFieldFromFabric([road])).toBeNull();
    // A mountain-KIND sketch without a procgen block is inert — not a request,
    // not an elevation source (plan 020: cancel leaves an inert shape).
    const inert = {
      type: "Feature",
      id: "m0",
      geometry: { type: "Polygon", coordinates: [RING] },
      properties: { kind: "mountain" },
    } as unknown as FabricFeature;
    expect(elevationFieldFromFabric([inert])).toBeNull();
  });

  it("matches the mountain generator's own field for the same seed/ring/params", () => {
    const feature = mountainFeature("m1", RING);
    const composed = elevationFieldFromFabric([feature])!;
    const region = makeRegion("m1", RING);
    const direct = mountainHeightField(777, region, { terrain: "alpine", amplitude: 0.8, roughness: 0.5 });
    for (const [x, y] of [
      [400, 400],
      [750, 1100],
      [60, 60], // rim band
      [2500, 2500], // outside
    ] as Pt[]) {
      const a = composed(x, y);
      const b = direct(x, y);
      expect(a.v).toBe(b.v);
      expect(a.dx).toBe(b.dx);
      expect(a.dy).toBe(b.dy);
    }
  });

  it("is deterministic (two compositions sample identically) and keys on the persisted seed", () => {
    const f1 = elevationFieldFromFabric([mountainFeature("m1", RING)])!;
    const f2 = elevationFieldFromFabric([mountainFeature("m1", RING)])!;
    expect(f1(321, 654)).toEqual(f2(321, 654));
    const other = elevationFieldFromFabric([mountainFeature("m1", RING, 778)])!;
    expect(other(321, 654).v).not.toBe(f1(321, 654).v);
  });

  it("unions multiple mountains (max wins) and is enumeration-order independent", () => {
    const east: Pt[] = [
      [3000, 0],
      [4500, 0],
      [4500, 1500],
      [3000, 1500],
      [3000, 0],
    ];
    const a = mountainFeature("aa", RING, 11);
    const b = mountainFeature("bb", east, 22, { terrain: "rolling-hills", amplitude: 0.4, roughness: 0.3 });
    const fab = elevationFieldFromFabric([a, b])!;
    const fba = elevationFieldFromFabric([b, a])!;
    for (const [x, y] of [
      [750, 750],
      [3750, 750],
      [2250, 750], // between the two (both masks 0)
    ] as Pt[]) {
      expect(fab(x, y)).toEqual(fba(x, y));
    }
    expect(fab(750, 750).v).toBeGreaterThan(0); // west mountain
    expect(fab(3750, 750).v).toBeGreaterThan(0); // east mountain
    expect(fab(2250, 750).v).toBe(0); // flat between
  });

  it("defends malformed params (non-string terrain, missing sliders) with the host defaults", () => {
    const feature = mountainFeature("mX", RING, 5, { terrain: 42, amplitude: "no" });
    const f = elevationFieldFromFabric([feature])!;
    expect(Number.isFinite(f(700, 700).v)).toBe(true);
    expect(f(700, 700).v).toBeGreaterThan(0);
  });

  it("every terrain type composes (enum guard)", () => {
    for (const terrain of MOUNTAIN_TERRAINS) {
      const f = elevationFieldFromFabric([
        mountainFeature(`m-${terrain}`, RING, 9, { terrain, amplitude: 0.6, roughness: 0.5 }),
      ])!;
      expect(f(750, 750).v).toBeGreaterThan(0);
    }
  });
});
