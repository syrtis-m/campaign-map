import { describe, it, expect } from "vitest";
import { terrainAt, macroTerrainField, hasTerrainRelief } from "./terrain";
import { elevationFieldFromFabric } from "./mountainField";
import type { FabricFeature } from "../../model/fabric";

type Pt = [number, number];

const RING: Pt[] = [
  [0, 0],
  [1500, 0],
  [1500, 1500],
  [0, 1500],
  [0, 0],
];
const EAST_RING: Pt[] = [
  [3000, 0],
  [4500, 0],
  [4500, 1500],
  [3000, 1500],
  [3000, 0],
];

function mountain(id: string, ring: Pt[], seed = 777, params: Record<string, unknown> = { terrain: "alpine", amplitude: 0.8, roughness: 0.5 }): FabricFeature {
  return {
    type: "Feature",
    id,
    geometry: { type: "Polygon", coordinates: [ring] },
    properties: { kind: "mountain", procgen: { algorithm: "mountain", seed, version: 1, params } },
  } as FabricFeature;
}

function relief(id: string, spine: Pt[], params: Record<string, unknown>): FabricFeature {
  return {
    type: "Feature",
    id,
    geometry: { type: "LineString", coordinates: spine },
    properties: { kind: "relief", procgen: { algorithm: "relief", seed: 5, version: 1, params } },
  } as FabricFeature;
}

function landform(id: string, ring: Pt[], params: Record<string, unknown>): FabricFeature {
  return {
    type: "Feature",
    id,
    geometry: { type: "Polygon", coordinates: [ring] },
    properties: { kind: "landform", procgen: { algorithm: "landform", seed: 3, version: 1, params } },
  } as FabricFeature;
}

function river(id: string, spine: Pt[], params: Record<string, unknown>): FabricFeature {
  return {
    type: "Feature",
    id,
    geometry: { type: "LineString", coordinates: spine },
    properties: { kind: "river", procgen: { algorithm: "river", seed: 9, version: 2, params } },
  } as FabricFeature;
}

// ─── THE HEADLINE: bit-exact migration ───────────────────────────────────────

describe("terrainAt — bit-exact vs elevationFieldFromFabric on a mountain-only campaign", () => {
  it("single mountain: v/dx/dy identical to the float", () => {
    const feats = [mountain("m1", RING)];
    const t = terrainAt(feats); // flat base by default
    const e = elevationFieldFromFabric(feats)!;
    for (const [x, y] of [
      [400, 400],
      [750, 1100],
      [60, 60], // rim band
      [1234, 321],
      [2500, 2500], // outside — exact zero
      [-500, -500],
    ] as Pt[]) {
      const a = t(x, y);
      const b = e(x, y);
      expect(a.v).toBe(b.v);
      expect(a.dx).toBe(b.dx);
      expect(a.dy).toBe(b.dy);
    }
  });

  it("multiple mountains (union max): identical, enumeration-order independent", () => {
    const feats = [mountain("aa", RING, 11), mountain("bb", EAST_RING, 22, { terrain: "rolling-hills", amplitude: 0.4, roughness: 0.3 })];
    const t = terrainAt(feats);
    const e = elevationFieldFromFabric(feats)!;
    for (const [x, y] of [
      [750, 750],
      [3750, 750],
      [2250, 750], // between (both masks 0)
    ] as Pt[]) {
      expect(t(x, y)).toEqual(e(x, y));
    }
  });

  it("a flat, stampless campaign is EXACTLY the datum everywhere (byte-stable)", () => {
    const t = terrainAt([]);
    for (const [x, y] of [[0, 0], [1234, -9876], [5e5, 5e5]] as Pt[]) {
      expect(t(x, y)).toEqual({ v: 0, dx: 0, dy: 0 });
    }
    // seaDatum offset is an exact constant, still zero gradient.
    const s = terrainAt([], { base: { seaDatum: 250 } });
    expect(s(42, 42)).toEqual({ v: 250, dx: 0, dy: 0 });
  });

  it("hasTerrainRelief mirrors the null/non-null of elevationFieldFromFabric for mountains", () => {
    expect(hasTerrainRelief([])).toBe(false);
    expect(hasTerrainRelief([mountain("m1", RING)])).toBe(true);
    expect(hasTerrainRelief([], { campAmp: 1 })).toBe(true);
    expect(hasTerrainRelief([relief("r1", [[0, 0], [100, 0]], { polarity: "ridge", height: 100, halfWidth: 80 })])).toBe(true);
  });
});

// ─── Determinism: id-sorted folds, shuffle-invariant ─────────────────────────

describe("terrainAt — operator-class determinism (shuffled stamp enumeration)", () => {
  const feats: FabricFeature[] = [
    mountain("m-2", RING, 11),
    mountain("m-1", EAST_RING, 22, { terrain: "mesa", amplitude: 0.6, roughness: 0.4 }),
    relief("r-b", [[200, 200], [600, 700], [1000, 1200]], { polarity: "ridge", height: 300, halfWidth: 250 }),
    relief("r-a", [[100, 1300], [900, 900], [1400, 300]], { polarity: "valley", height: 180, halfWidth: 220 }),
    landform("l-b", [[300, 300], [1100, 300], [1100, 1100], [300, 1100], [300, 300]], { mode: "plateau", target: 900, band: 150, priority: 0 }),
    landform("l-a", [[500, 500], [1300, 500], [1300, 1300], [500, 1300], [500, 500]], { mode: "basin", target: -100, band: 150, priority: 0 }),
  ];

  function shuffle<T>(arr: T[], seed: number): T[] {
    const a = [...arr];
    let s = seed;
    for (let i = a.length - 1; i > 0; i--) {
      s = (s * 1664525 + 1013904223) >>> 0;
      const j = s % (i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  it("every permutation of the fabric samples identically", () => {
    const canonical = terrainAt(feats);
    const probes: Pt[] = [
      [400, 400],
      [750, 800],
      [1000, 1000],
      [600, 700],
      [1200, 400],
      [250, 1250],
    ];
    const want = probes.map(([x, y]) => canonical(x, y));
    for (let seed = 1; seed <= 8; seed++) {
      const t = terrainAt(shuffle(feats, seed));
      probes.forEach(([x, y], i) => {
        expect(t(x, y)).toEqual(want[i]);
      });
    }
  });
});

// ─── Analytic gradients vs central differences ───────────────────────────────

describe("terrainAt — analytic gradients match central differences", () => {
  function central(f: (x: number, y: number) => { v: number }, x: number, y: number, h: number): [number, number] {
    return [(f(x + h, y).v - f(x - h, y).v) / (2 * h), (f(x, y + h).v - f(x, y - h).v) / (2 * h)];
  }

  it("relief add-stamp: signed cross-profile gradient (ridge and valley)", () => {
    const spine: Pt[] = [[-500, 0], [0, 0], [500, 0]];
    for (const polarity of ["ridge", "valley"] as const) {
      const t = terrainAt([relief("r", spine, { polarity, height: 300, halfWidth: 200 })]);
      // Sample off the spine, inside the band, away from the endpoint kinks.
      for (const [x, y] of [[0, 60], [120, 90], [-140, 110], [60, 150]] as Pt[]) {
        const s = t(x, y);
        const [gx, gy] = central(t, x, y, 0.05);
        expect(s.dx).toBeCloseTo(gx, 3);
        expect(s.dy).toBeCloseTo(gy, 3);
      }
    }
  });

  it("landform replace: gradient zero deep interior, ∇base far outside, and matches in the band", () => {
    const ring: Pt[] = [[0, 0], [1000, 0], [1000, 1000], [0, 1000], [0, 0]];
    const t = terrainAt([landform("l", ring, { mode: "plateau", target: 500, band: 120 })]);
    // Deep interior: value saturates to target, gradient exactly 0.
    const deep = t(500, 500);
    expect(deep.v).toBe(500);
    expect(deep.dx).toBe(0);
    expect(deep.dy).toBe(0);
    // In the falloff band (near a mid-edge, smooth region): analytic ≈ central.
    for (const [x, y] of [[500, 60], [500, 90], [60, 500]] as Pt[]) {
      const s = t(x, y);
      const [gx, gy] = central(t, x, y, 0.05);
      expect(s.dx).toBeCloseTo(gx, 2);
      expect(s.dy).toBeCloseTo(gy, 2);
    }
  });

  it("continental base: exact gradient (damping-0 fBm)", () => {
    const t = terrainAt([], { base: { campAmp: 300, seaDatum: 100 }, campaignSeed: 42 });
    for (const [x, y] of [[1200, 800], [-3000, 2000], [500, -500]] as Pt[]) {
      const s = t(x, y);
      const [gx, gy] = central(t, x, y, 0.1);
      expect(s.dx).toBeCloseTo(gx, 3);
      expect(s.dy).toBeCloseTo(gy, 3);
    }
  });
});

// ─── Priority / id-order (Q4: last wins) ─────────────────────────────────────

describe("terrainAt — replace priority + id order (last wins)", () => {
  const bigA: Pt[] = [[0, 0], [1000, 0], [1000, 1000], [0, 1000], [0, 0]];
  const bigB: Pt[] = [[0, 0], [1000, 0], [1000, 1000], [0, 1000], [0, 0]];

  it("higher priority wins where two landforms overlap", () => {
    const feats = [
      landform("z-first-id", bigA, { mode: "plateau", target: 200, band: 100, priority: 5 }),
      landform("a-second-id", bigB, { mode: "plateau", target: 900, band: 100, priority: 1 }),
    ];
    // Deep interior of both: priority 5 is applied LAST → 200 wins, despite
    // "a-second-id" sorting earlier alphabetically.
    expect(terrainAt(feats)(500, 500).v).toBe(200);
  });

  it("equal priority: higher id wins (stable tiebreak)", () => {
    const feats = [
      landform("aaa", bigA, { mode: "plateau", target: 111, band: 100, priority: 0 }),
      landform("zzz", bigB, { mode: "plateau", target: 777, band: 100, priority: 0 }),
    ];
    // Both priority 0 → id order; "zzz" folds last → wins.
    expect(terrainAt(feats)(500, 500).v).toBe(777);
  });
});

// ─── Compact support: a disjoint stamp is byte-inert ─────────────────────────

describe("terrainAt — compact support (disjoint stamps are exactly inert)", () => {
  it("a relief stamp beyond its half-width adds exactly nothing at a far point", () => {
    const far: Pt = [10000, 10000];
    const withStamp = terrainAt([relief("r", [[0, 0], [500, 0]], { polarity: "ridge", height: 300, halfWidth: 200 })]);
    const without = terrainAt([]);
    expect(withStamp(...far)).toEqual(without(...far));
  });

  it("a landform stamp outside its band leaves the field identical", () => {
    const ring: Pt[] = [[0, 0], [400, 0], [400, 400], [0, 400], [0, 0]];
    const withStamp = terrainAt([landform("l", ring, { mode: "plateau", target: 500, band: 100 })]);
    const without = terrainAt([]);
    expect(withStamp(9000, 9000)).toEqual(without(9000, 9000));
  });
});

// ─── Item 5: macroTerrainField is a bit-exact drop-in ────────────────────────

describe("macroTerrainField — bit-exact drop-in for elevationFieldFromFabric", () => {
  it("mountain-only campaign: identical field (v/dx/dy) to the float", () => {
    const feats = [mountain("aa", RING, 11), mountain("bb", EAST_RING, 22, { terrain: "mesa", amplitude: 0.6, roughness: 0.4 })];
    const macro = macroTerrainField(feats)!;
    const legacy = elevationFieldFromFabric(feats)!;
    for (const [x, y] of [[400, 400], [750, 1100], [60, 60], [3750, 750], [2250, 750], [9999, 9999]] as Pt[]) {
      expect(macro(x, y)).toEqual(legacy(x, y));
    }
  });

  it("returns null on a trivially-flat campaign (the null shortcut is preserved)", () => {
    expect(macroTerrainField([])).toBeNull();
    expect(macroTerrainField(undefined)).toBeNull();
    // A river / relief / landform WITHOUT a mountain is still flat macro terrain.
    expect(macroTerrainField([relief("r", [[0, 0], [100, 0]], { polarity: "ridge", height: 100, halfWidth: 80 })])).toBeNull();
  });

  it("ignores relief/landform/carve — only mountains + base reach the consumer", () => {
    const withStamps = macroTerrainField([
      mountain("m", RING),
      relief("r", [[200, 200], [1000, 1200]], { polarity: "ridge", height: 400, halfWidth: 300 }),
      river("rv", [[-200, 750], [1700, 750]], { width: 30 }),
    ])!;
    const mountainOnly = elevationFieldFromFabric([mountain("m", RING)])!;
    // A point the relief + carve both influence: macro sees only the mountain.
    expect(withStamps(750, 750)).toEqual(mountainOnly(750, 750));
  });

  it("adds the campaign base when opted in (campAmp > 0)", () => {
    const field = macroTerrainField([mountain("m", RING)], { campAmp: 100, seaDatum: 50 })!;
    // Far outside the mountain: value is the base (mountain contributes 0), non-flat.
    const s = field(20000, 20000);
    expect(s.v).not.toBe(0);
    expect(Number.isFinite(s.v)).toBe(true);
  });
});
