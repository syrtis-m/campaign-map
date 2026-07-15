import { describe, it, expect } from "vitest";
import { terrainAt } from "./terrain";
import type { FabricFeature } from "../../model/fabric";

type Pt = [number, number];

const RING: Pt[] = [
  [0, 0],
  [1500, 0],
  [1500, 1500],
  [0, 1500],
  [0, 0],
];
// A district covering the middle of the massif.
const DISTRICT_RING: Pt[] = [
  [400, 400],
  [1100, 400],
  [1100, 1100],
  [400, 1100],
  [400, 400],
];

function mountain(id: string): FabricFeature {
  return {
    type: "Feature",
    id,
    geometry: { type: "Polygon", coordinates: [RING] },
    properties: { kind: "mountain", procgen: { algorithm: "mountain", seed: 777, version: 1, params: { terrain: "alpine", amplitude: 0.8, roughness: 0.5 } } },
  } as FabricFeature;
}

function district(id: string, params: Record<string, unknown>): FabricFeature {
  return {
    type: "Feature",
    id,
    geometry: { type: "Polygon", coordinates: [DISTRICT_RING] },
    properties: { kind: "district", procgen: { algorithm: "city", seed: 5, version: 1, params } },
  } as FabricFeature;
}

describe("terrainAt grading — DEFAULT OFF byte-identity (Q3)", () => {
  it("a district WITHOUT grade leaves the terrain byte-identical", () => {
    const plain = terrainAt([mountain("m")]);
    const withCity = terrainAt([mountain("m"), district("d", { profile: "euro-medieval" })]);
    for (const [x, y] of [[400, 400], [750, 750], [900, 600], [1234, 321], [3000, 3000]] as Pt[]) {
      expect(withCity(x, y)).toEqual(plain(x, y));
    }
  });

  it("grade:false is also a strict no-op", () => {
    const plain = terrainAt([mountain("m")]);
    const withCity = terrainAt([mountain("m"), district("d", { profile: "euro-medieval", grade: false })]);
    expect(withCity(750, 750)).toEqual(plain(750, 750));
  });
});

describe("terrainAt grading — ON flattens the interior toward the center elevation", () => {
  it("deep-interior points level toward the district center's ground elevation", () => {
    const center: Pt = [750, 750];
    const ungraded = terrainAt([mountain("m")]);
    const graded = terrainAt([mountain("m"), district("d", { profile: "euro-medieval", grade: true, center, gradeBand: 200 })]);
    const centerElev = ungraded(center[0], center[1]).v;
    // Points well inside the district (past the falloff band) sit at ~centerElev,
    // and are FLATTER (closer to centerElev) than the natural relief.
    for (const [x, y] of [[650, 650], [850, 700], [700, 850]] as Pt[]) {
      const g = graded(x, y).v;
      const u = ungraded(x, y).v;
      expect(Math.abs(g - centerElev)).toBeLessThan(Math.abs(u - centerElev) + 1e-9);
      expect(Math.abs(g - centerElev)).toBeLessThan(30); // levelled onto the platform
    }
    // At the very center the graded surface equals the center elevation.
    expect(graded(center[0], center[1]).v).toBeCloseTo(centerElev, 6);
  });

  it("the rim stays natural (outside the ring the field is untouched)", () => {
    const graded = terrainAt([mountain("m"), district("d", { profile: "euro-medieval", grade: true, center: [750, 750] })]);
    const ungraded = terrainAt([mountain("m")]);
    // Outside the district ring: identical to the ungraded terrain.
    expect(graded(100, 100)).toEqual(ungraded(100, 100));
  });
});

describe("terrainAt base — params take effect ONLY when applied (36-D Apply model)", () => {
  it("the base is an explicit input, not auto-applied (deferred until passed)", () => {
    const flat = terrainAt([mountain("m")]); // default base: campAmp 0
    const applied = terrainAt([mountain("m")], { base: { campAmp: 200, seaDatum: 100 }, campaignSeed: 7 });
    // Far outside the mountain, the un-applied field is exactly flat (datum 0);
    // the applied field carries the base relief — proof the base only changes the
    // surface when explicitly supplied (an Apply), never implicitly.
    const far: Pt = [30000, 30000];
    expect(flat(...far).v).toBe(0); // un-applied ⇒ exactly the datum
    expect(applied(...far).v).not.toBe(0); // applied base carries relief
  });

  it("macro-consumers never see grading (include.grade off) — a graded city can't couple back", async () => {
    const { macroTerrainField } = await import("./terrain");
    const feats = [mountain("m"), district("d", { profile: "euro-medieval", grade: true, center: [750, 750] })];
    const macro = macroTerrainField(feats)!;
    const mountainOnly = terrainAt([mountain("m")]);
    // The macro field a river/farmland reads excludes grading → identical to the
    // plain mountain terrain at the district center.
    expect(macro(750, 750)).toEqual(mountainOnly(750, 750));
  });
});
