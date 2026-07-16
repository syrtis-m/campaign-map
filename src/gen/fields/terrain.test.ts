import { describe, it, expect } from "vitest";
import { terrainAt, macroTerrainField, hasTerrainRelief, terrainStampSupport, reliefReach, landformReplaceOverlaps, landformRaisesLandAbove } from "./terrain";
import { SegmentHash } from "../segmentHash";
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

  it("far-field samples never pay a nearest-spiral (relief + landform fast reject — the DEM-fill stall)", () => {
    // A whole-map relief spine + landform ring, then a lattice of samples far
    // outside both bboxes: with the byte-exact reject, ZERO segments are tested.
    // Without it, every sample spirals O(dist²) cells — the >120s/DEM-tile stall
    // the carve already guards against (terrainCarve.test.ts).
    SegmentHash.totalSegmentTests = 0;
    const field = terrainAt([
      relief("spine", [[-4000, 4000], [0, 4400], [4000, 4200]], { polarity: "ridge", height: 400, halfWidth: 900 }),
      landform("plateau", [[2000, -1000], [5000, -1000], [5000, 2000], [2000, 2000], [2000, -1000]], { mode: "plateau", target: 400, band: 300 }),
    ]);
    for (let j = 0; j < 32; j++) {
      for (let i = 0; i < 32; i++) {
        field(-30000 + i * 120, -30000 + j * 120); // all ≥ 20 km from every stamp
      }
    }
    expect(SegmentHash.totalSegmentTests).toBe(0);
  });
});

// ─── Foothill apron: skirt falloff past halfWidth (shortlist item 2) ─────────

describe("relief apron — foothill skirt extends the compact support past halfWidth", () => {
  const SPINE: Pt[] = [[-500, 0], [0, 0], [500, 0]];

  it("apron 0 (or absent) is BYTE-IDENTICAL to the pre-apron stamp at every distance", () => {
    const noApron = terrainAt([relief("r", SPINE, { polarity: "ridge", height: 300, halfWidth: 200 })]);
    const apron0 = terrainAt([relief("r", SPINE, { polarity: "ridge", height: 300, halfWidth: 200, apron: 0 })]);
    // Probe across the spine, inside the band, at the rim, and past it.
    for (const [x, y] of [[0, 0], [0, 60], [120, 150], [0, 199], [0, 200], [0, 260], [0, 5000]] as Pt[]) {
      const a = noApron(x, y);
      const b = apron0(x, y);
      expect(a.v).toBe(b.v);
      expect(a.dx).toBe(b.dx);
      expect(a.dy).toBe(b.dy);
    }
  });

  it("a positive apron keeps the peak at the spine, spreads the toe, and is EXACTLY 0 only past halfWidth+apron", () => {
    const hw = 200;
    const apron = 300;
    const withApron = terrainAt([relief("r", SPINE, { polarity: "ridge", height: 300, halfWidth: hw, apron })]);
    const bare = terrainAt([relief("r", SPINE, { polarity: "ridge", height: 300, halfWidth: hw })]);
    // Peak unchanged at the spine (bump(0) === 1 for both).
    expect(withApron(0, 0).v).toBeCloseTo(bare(0, 0).v, 6);
    // AT the old rim (d = hw) the bare stamp is 0, the apron'd one is still raised
    // (the toe now spreads into a foothill instead of hitting 0).
    expect(bare(0, hw).v).toBeCloseTo(0, 6);
    expect(withApron(0, hw).v).toBeGreaterThan(20);
    // In the skirt (hw < d < hw+apron) the field is positive; just past the reach
    // it is EXACTLY 0 (compact support at the widened radius).
    expect(withApron(0, hw + apron - 1).v).toBeGreaterThan(0);
    expect(withApron(0, hw + apron).v).toBe(0);
    expect(withApron(0, hw + apron + 500).v).toBe(0);
  });

  it("reliefReach and terrainStampSupport both fold the apron into the reach", () => {
    expect(reliefReach({ polarity: "ridge", height: 300, halfWidth: 180 })).toBe(180);
    expect(reliefReach({ polarity: "ridge", height: 300, halfWidth: 180, apron: 220 })).toBe(400);
    const stamp = relief("r", SPINE, { polarity: "ridge", height: 300, halfWidth: 180, apron: 220 });
    expect(terrainStampSupport(stamp)).toBe(400);
    // Absent apron ⇒ reach is exactly the half-width (byte-stable invalidation).
    expect(terrainStampSupport(relief("r2", SPINE, { polarity: "ridge", height: 300, halfWidth: 180 }))).toBe(180);
  });

  it("the far-field reject still fires ZERO segment tests past the APRON'd reach", () => {
    // A whole-map apron'd spine, then a lattice of samples far beyond halfWidth+apron:
    // the byte-exact reject uses `reach`, so no sample pays the nearest-spiral.
    SegmentHash.totalSegmentTests = 0;
    const field = terrainAt([
      relief("spine", [[-4000, 4000], [0, 4400], [4000, 4200]], { polarity: "ridge", height: 400, halfWidth: 500, apron: 900 }),
    ]);
    for (let j = 0; j < 24; j++) {
      for (let i = 0; i < 24; i++) {
        field(-30000 + i * 140, -30000 + j * 140); // all ≫ (500+900) m from the spine
      }
    }
    expect(SegmentHash.totalSegmentTests).toBe(0);
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
    // A river WITHOUT any terrain stamp is still flat macro terrain (the carve is
    // NOT a terrain input — a river must not read its own gorge).
    expect(macroTerrainField([river("rv", [[0, 0], [100, 0]], { width: 30 })])).toBeNull();
  });

  it("a relief/landform WITHOUT a mountain reaches the consumer (ruling 2026-07-15)", () => {
    // "No more mountain polygons, only the global terrain system": a relief ridge
    // with NO mountain present composes a non-null macro field the consumer reads.
    const reliefOnly = macroTerrainField([
      relief("r", [[0, 0], [1000, 0]], { polarity: "ridge", height: 300, halfWidth: 200 }),
    ]);
    expect(reliefOnly).not.toBeNull();
    // The field is nonzero on the ridge spine (the relief IS composed, not ignored).
    expect(reliefOnly!(0, 0).v).toBeGreaterThan(0);
  });

  it("composes relief + landform, but EXCLUDES the river carve + city grade", () => {
    const stampFeats = [
      mountain("m", RING),
      relief("r", [[200, 200], [1000, 1200]], { polarity: "ridge", height: 400, halfWidth: 300 }),
    ];
    const withoutRiver = macroTerrainField(stampFeats)!;
    const withRiver = macroTerrainField([...stampFeats, river("rv", [[-200, 750], [1700, 750]], { width: 30 })])!;
    // CARVE EXCLUDED: adding a river makes NO difference to the macro field (a
    // consumer never reads a river's own gorge — circular).
    expect(withRiver(750, 750)).toEqual(withoutRiver(750, 750));
    // RELIEF INCLUDED: the macro field differs from the mountain-only union.
    const mountainOnly = elevationFieldFromFabric([mountain("m", RING)])!;
    expect(withoutRiver(750, 750)).not.toEqual(mountainOnly(750, 750));
  });

  it("adds the campaign base when opted in (campAmp > 0)", () => {
    const field = macroTerrainField([mountain("m", RING)], { campAmp: 100, seaDatum: 50 })!;
    // Far outside the mountain: value is the base (mountain contributes 0), non-flat.
    const s = field(20000, 20000);
    expect(s.v).not.toBe(0);
    expect(Number.isFinite(s.v)).toBe(true);
  });
});

describe("terrainAt — island-from-coastline (plan 041 inverted sea)", () => {
  // A small coast ring; land inside, sea outside. An explicit sea target (-500)
  // distinguishes sea from the flat datum-0 land so the flip is observable.
  const COAST: Pt[] = [
    [400, 400],
    [800, 400],
    [800, 800],
    [400, 800],
    [400, 400],
  ];

  it("inverts the mask: sea OUTSIDE the drawn coast, land deep INSIDE", () => {
    const t = terrainAt([landform("island", COAST, { mode: "sea", target: -500, band: 60, invert: true })]);
    // Deep interior (>band from every edge) → mask 0 → land unchanged (base 0).
    expect(t(600, 600).v).toBe(0);
    // Far exterior (outside the ring bbox) → mask 1 → sea target.
    expect(t(3000, 3000).v).toBe(-500);
    // Just outside a coast edge is still sea (mask 1 once past the band).
    expect(t(1000, 600).v).toBe(-500);
  });

  it("is the exact opposite of a non-inverted sea (interior IS the sea)", () => {
    const inside: Pt = [600, 600];
    const outside: Pt = [3000, 3000];
    const plain = terrainAt([landform("sea", COAST, { mode: "sea", target: -500, band: 60 })]);
    const inv = terrainAt([landform("island", COAST, { mode: "sea", target: -500, band: 60, invert: true })]);
    // Plain sea: interior is sea, exterior is land. Inverted: mirror image.
    expect(plain(inside[0], inside[1]).v).toBe(-500);
    expect(plain(outside[0], outside[1]).v).toBe(0);
    expect(inv(inside[0], inside[1]).v).toBe(0);
    expect(inv(outside[0], outside[1]).v).toBe(-500);
  });

  it("invert absent ⇒ byte-identical to invert:false (no version bump)", () => {
    const absent = terrainAt([landform("s", COAST, { mode: "sea", target: -500, band: 60 })]);
    const explicitFalse = terrainAt([landform("s", COAST, { mode: "sea", target: -500, band: 60, invert: false })]);
    for (let x = 0; x <= 1200; x += 137) {
      for (let y = 0; y <= 1200; y += 149) {
        expect(explicitFalse(x, y)).toEqual(absent(x, y));
      }
    }
  });

  it("gradient is exactly flat deep inside (land) and far outside (open sea)", () => {
    const t = terrainAt([landform("island", COAST, { mode: "sea", target: -500, band: 60, invert: true })]);
    // Deep interior: constant land ⇒ zero gradient.
    const deep = t(600, 600);
    expect(deep.dx).toBe(0);
    expect(deep.dy).toBe(0);
    // Far ocean: constant sea ⇒ zero gradient (the flipped far-field reject).
    const ocean = t(5000, 5000);
    expect(ocean.dx).toBe(0);
    expect(ocean.dy).toBe(0);
  });

  it("terrainStampSupport: an inverted sea is GLOBAL (Infinity); every other landform is compact (0)", () => {
    expect(terrainStampSupport(landform("i", COAST, { mode: "sea", band: 60, invert: true }))).toBe(Infinity);
    expect(terrainStampSupport(landform("s", COAST, { mode: "sea", band: 60 }))).toBe(0);
    // invert only inverts the SEA mode — a plateau with invert:true stays compact.
    expect(terrainStampSupport(landform("p", COAST, { mode: "plateau", band: 60, invert: true }))).toBe(0);
    expect(terrainStampSupport(landform("i-false", COAST, { mode: "sea", band: 60, invert: false }))).toBe(0);
  });
});

// ─── Multi-ring landform: polygon holes are carved out of the mask ───────────
// (Cradle learning 2026-07-15 — a donut sea silently flattened the island in its
// hole because the mask read only coordinates[0].)

describe("terrainAt — landform holes (donut) leave the hole interior at base elevation", () => {
  type Pt3 = [number, number];
  const OUTER: Pt3[] = [
    [0, 0],
    [2000, 0],
    [2000, 2000],
    [0, 2000],
    [0, 0],
  ];
  const HOLE: Pt3[] = [
    [800, 800],
    [1200, 800],
    [1200, 1200],
    [800, 1200],
    [800, 800],
  ];

  function donut(id: string, rings: Pt3[][], params: Record<string, unknown>): FabricFeature {
    return {
      type: "Feature",
      id,
      geometry: { type: "Polygon", coordinates: rings },
      properties: { kind: "landform", procgen: { algorithm: "landform", seed: 3, version: 1, params } },
    } as FabricFeature;
  }

  const PLATEAU = { mode: "plateau", target: 500, band: 120 };

  it("hole interior stays at base elevation; the plateau body saturates to target", () => {
    const t = terrainAt([donut("d", [OUTER, HOLE], PLATEAU)]);
    // Deep inside the hole (>band from every hole rim) → mask 0 → base (0).
    expect(t(1000, 1000).v).toBe(0);
    // Deep in the plateau body (>band from outer rim AND hole rim) → mask 1 → target.
    expect(t(300, 1000).v).toBe(500);
    expect(t(1000, 300).v).toBe(500);
  });

  it("WITHOUT the hole the same spot is flattened (proves the hole is what saves it)", () => {
    const solid = terrainAt([donut("d", [OUTER], PLATEAU)]);
    // No hole: the whole interior is the plateau, so the (would-be) island is flat-topped.
    expect(solid(1000, 1000).v).toBe(500);
  });

  it("a C1 rim ramp runs INWARD along the hole boundary (monotone 0 → target)", () => {
    const t = terrainAt([donut("d", [OUTER, HOLE], PLATEAU)]);
    // Walk from the hole center outward toward a hole edge (y=800): center 0,
    // just inside the rim raised, and by the time we clear the band the plateau
    // body is at target. Values must be non-decreasing.
    const center = t(1000, 1000).v; // 0
    const nearRimInside = t(1000, 850).v; // 50 into the hole, within band → (0, target)
    const rim = t(1000, 800).v; // on the hole boundary (sd=0) → mask 1 side → target-ish
    const body = t(1000, 650).v; // 150 outside the hole, clear of the band → target
    expect(center).toBe(0);
    expect(nearRimInside).toBeGreaterThan(0);
    expect(nearRimInside).toBeLessThan(500);
    expect(rim).toBeGreaterThanOrEqual(nearRimInside);
    expect(body).toBe(500);
  });

  it("hole band gradient: analytic matches central differences", () => {
    const t = terrainAt([donut("d", [OUTER, HOLE], PLATEAU)]);
    function central(f: (x: number, y: number) => { v: number }, x: number, y: number, h: number): [number, number] {
      return [(f(x + h, y).v - f(x - h, y).v) / (2 * h), (f(x, y + h).v - f(x, y - h).v) / (2 * h)];
    }
    // Inside the hole band, away from corners: analytic ∇ ≈ central.
    for (const [x, y] of [[1000, 850], [1000, 1150], [850, 1000], [1150, 1000]] as Pt3[]) {
      const s = t(x, y);
      const [gx, gy] = central(t, x, y, 0.05);
      expect(s.dx).toBeCloseTo(gx, 2);
      expect(s.dy).toBeCloseTo(gy, 2);
    }
  });

  it("deep hole interior has EXACTLY zero gradient (flat base)", () => {
    const s = terrainAt([donut("d", [OUTER, HOLE], PLATEAU)])(1000, 1000);
    expect(s.dx).toBe(0);
    expect(s.dy).toBe(0);
  });

  it("2×2 seam: two independently-constructed fields sample byte-identically across the donut", () => {
    // terrainAt is a pure point field, so a tile that constructs its own field must
    // read the SAME bytes as any adjacent tile at every shared-edge sample — the
    // seam guarantee. Build the field twice (as two tiles would) and compare along
    // a seam line crossing the outer rim, the hole band, and the hole interior.
    const a = terrainAt([donut("d", [OUTER, HOLE], PLATEAU)]);
    const b = terrainAt([donut("d", [OUTER, HOLE], PLATEAU)]);
    for (let x = -100; x <= 2100; x += 37) {
      const sa = a(x, 1000);
      const sb = b(x, 1000);
      expect(sa.v).toBe(sb.v);
      expect(sa.dx).toBe(sb.dx);
      expect(sa.dy).toBe(sb.dy);
    }
  });

  it("shuffled HOLE order is byte-identical (fold determinism, holes id-independent)", () => {
    // Two asymmetric holes; swapping their ring order in `coordinates` must not
    // move a single byte (min-fold value is order-invariant; generic samples avoid
    // the measure-zero equal-value tie).
    const H1: Pt3[] = [[300, 300], [600, 300], [600, 600], [300, 600], [300, 300]];
    const H2: Pt3[] = [[1300, 1300], [1700, 1300], [1700, 1700], [1300, 1700], [1300, 1300]];
    const straight = terrainAt([donut("d", [OUTER, H1, H2], PLATEAU)]);
    const swapped = terrainAt([donut("d", [OUTER, H2, H1], PLATEAU)]);
    for (let x = 100; x <= 1900; x += 53) {
      for (let y = 100; y <= 1900; y += 59) {
        const s = straight(x, y);
        const w = swapped(x, y);
        expect(s.v).toBe(w.v);
        expect(s.dx).toBe(w.dx);
        expect(s.dy).toBe(w.dy);
      }
    }
  });

  it("a malformed (degenerate) hole ring is ignored ⇒ byte-identical to no hole", () => {
    // Defensive parse of the durable sketch layer: a <3-point hole reverts to the
    // no-hole path rather than throwing or building a broken ring.
    const bad = terrainAt([donut("d", [OUTER, [[1000, 1000], [1000, 1000]]], PLATEAU)]);
    const none = terrainAt([donut("d", [OUTER], PLATEAU)]);
    for (let x = 0; x <= 2000; x += 143) {
      for (let y = 0; y <= 2000; y += 149) {
        expect(bad(x, y)).toEqual(none(x, y));
      }
    }
  });

  it("a donut SEA leaves its island (hole) dry — the exact Cradle bug", () => {
    // Sea target -500 fills the donut ring; the hole is the island, which must stay
    // at the datum (0), not drown to -500.
    const sea = terrainAt([donut("d", [OUTER, HOLE], { mode: "sea", target: -500, band: 120 })]);
    expect(sea(1000, 1000).v).toBe(0); // island: dry land
    expect(sea(300, 1000).v).toBe(-500); // sea body: sunk to target
  });

  it("single-ring landform is byte-identical to the pre-hole path (no version bump)", () => {
    // The multi-ring refactor must not perturb an existing (holeless) landform.
    const solid = terrainAt([donut("d", [OUTER], PLATEAU)]);
    // Reference: value/gradient computed the old way is stable across probes; here
    // we assert the field is well-formed and saturates as before.
    expect(solid(1000, 1000).v).toBe(500);
    expect(solid(5000, 5000)).toEqual({ v: 0, dx: 0, dy: 0 });
  });
});

// ─── Replace-over-add advisory: pure overlap detection ───────────────────────

describe("landformReplaceOverlaps — a replace landform that flattens add-stamps", () => {
  type Pt2 = [number, number];
  const BOX: Pt2[] = [
    [0, 0],
    [1000, 0],
    [1000, 1000],
    [0, 1000],
    [0, 0],
  ];

  // These fixtures are authored in METERS with a 1:1 scale (scaleMetersPerUnit=1),
  // so the meter reach and the geometry frame coincide.
  it("reports a mountain whose bbox intersects the landform ring", () => {
    const lf = landform("lf", BOX, { mode: "plateau", target: 400, band: 100 });
    const mtn = mountain("mtn", [[400, 400], [900, 400], [900, 900], [400, 900], [400, 400]]);
    expect(landformReplaceOverlaps(lf, [lf, mtn], 1)).toEqual(["mtn"]);
  });

  it("reports a relief whose support (halfWidth) reaches into the ring, but not one beyond it", () => {
    const lf = landform("lf", BOX, { mode: "basin", target: -100, band: 100 });
    // Spine sits 120 m outside the ring's right edge, halfWidth 200 → its band
    // reaches inside ⇒ flagged.
    const near = relief("near", [[1120, 200], [1120, 800]], { polarity: "ridge", height: 300, halfWidth: 200 });
    expect(landformReplaceOverlaps(lf, [lf, near], 1)).toEqual(["near"]);
    // Same spine but halfWidth 50 → its band stops short of the ring ⇒ NOT flagged
    // (support-aware, terrainStampSupport reach).
    const farNarrow = relief("far", [[1120, 200], [1120, 800]], { polarity: "ridge", height: 300, halfWidth: 50 });
    expect(landformReplaceOverlaps(lf, [lf, farNarrow], 1)).toEqual([]);
  });

  it("returns [] when the landform overlaps no add-stamp", () => {
    const lf = landform("lf", BOX, { mode: "plateau", target: 400, band: 100 });
    const mtn = mountain("mtn", [[5000, 5000], [6000, 5000], [6000, 6000], [5000, 6000], [5000, 5000]]);
    expect(landformReplaceOverlaps(lf, [lf, mtn], 1)).toEqual([]);
  });

  it("an INVERTED sea is silent (it replaces the exterior, not the interior)", () => {
    const inv = landform("inv", BOX, { mode: "sea", target: -500, band: 100, invert: true });
    const mtn = mountain("mtn", [[400, 400], [900, 400], [900, 900], [400, 900], [400, 400]]);
    expect(landformReplaceOverlaps(inv, [inv, mtn], 1)).toEqual([]);
  });

  it("a non-landform feature returns [] (safe to call on any selection)", () => {
    const mtn = mountain("mtn", BOX);
    expect(landformReplaceOverlaps(mtn, [mtn], 1)).toEqual([]);
    const rv = river("rv", [[0, 0], [100, 0]], { width: 20 });
    expect(landformReplaceOverlaps(rv, [rv], 1)).toEqual([]);
  });

  it("id-sorts multiple overlapping stamps and never lists the landform itself", () => {
    const lf = landform("lf", BOX, { mode: "plateau", target: 400, band: 100 });
    const zMtn = mountain("z-mtn", [[100, 100], [500, 100], [500, 500], [100, 500], [100, 100]]);
    const aRelief = relief("a-relief", [[200, 200], [800, 800]], { polarity: "ridge", height: 200, halfWidth: 150 });
    expect(landformReplaceOverlaps(lf, [zMtn, lf, aRelief], 1)).toEqual(["a-relief", "z-mtn"]);
  });
});

describe("landformRaisesLandAbove — is a landform DRY LAND above the sea datum?", () => {
  type Pt2 = [number, number];
  const R: Pt2[] = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];

  it("a default plateau raises land (target 400 > datum 0)", () => {
    expect(landformRaisesLandAbove(landform("p", R, { mode: "plateau", band: 1 }), 0)).toBe(true);
  });
  it("a plateau targeted at/below the datum is NOT land", () => {
    expect(landformRaisesLandAbove(landform("p", R, { mode: "plateau", target: 0, band: 1 }), 0)).toBe(false);
    expect(landformRaisesLandAbove(landform("p", R, { mode: "plateau", target: -50, band: 1 }), 0)).toBe(false);
  });
  it("a default basin drops below the datum ⇒ not land", () => {
    expect(landformRaisesLandAbove(landform("b", R, { mode: "basin", band: 1 }), 0)).toBe(false);
  });
  it("a basin explicitly raised above the datum IS land", () => {
    expect(landformRaisesLandAbove(landform("b", R, { mode: "basin", target: 30, band: 1 }), 0)).toBe(true);
  });
  it("an inverted sea is water, never land", () => {
    expect(landformRaisesLandAbove(landform("s", R, { mode: "sea", target: 999, band: 1, invert: true }), 0)).toBe(false);
  });
  it("honours a non-zero sea datum", () => {
    expect(landformRaisesLandAbove(landform("p", R, { mode: "plateau", target: 15, band: 1 }), 20)).toBe(false);
    expect(landformRaisesLandAbove(landform("p", R, { mode: "plateau", target: 25, band: 1 }), 20)).toBe(true);
  });
  it("a non-landform feature is never land", () => {
    expect(landformRaisesLandAbove(mountain("m", R), 0)).toBe(false);
  });
});

// ─── UNIT-FRAME regression (Cradle bug 2026-07-15) ───────────────────────────
// Fabric geometry is DISPLAY units; `terrainStampSupport` returns METERS. The old
// detector added the meter reach to display-unit bboxes, inflating it by
// scaleMetersPerUnit× (500× on the Cradle) so a stamp kilometres away read as
// overlapping. These fixtures live in display units at scale 500 (Cradle).
describe("landformReplaceOverlaps — meter reach vs display-unit geometry (scale 500)", () => {
  type Pt2 = [number, number];
  const SCALE = 500; // Cradle: 1 display unit = 500 m

  // A ~200 m-across islet plateau ("Lighthouse Rock") near the origin: 0.4 display
  // units ≈ 200 m across.
  const ISLET: Pt2[] = [
    [0, 0],
    [0.4, 0],
    [0.4, 0.4],
    [0, 0.4],
    [0, 0],
  ];

  it("the islet plateau does NOT overlap ridges kilometres away (was a 500× false positive)", () => {
    const islet = landform("islet", ISLET, { mode: "plateau", target: 20, band: 0.2 });
    // Eight relief ridges on the distant main island, ~10 display units (5 km) off —
    // far beyond any relief's halfWidth once the reach is measured in the RIGHT frame.
    const ridges = Array.from({ length: 8 }, (_, i) =>
      relief(`ridge-${i}`, [[10 + i, 10], [10 + i, 12]], { polarity: "ridge", height: 200, halfWidth: 150 })
    );
    expect(landformReplaceOverlaps(islet, [islet, ...ridges], SCALE)).toEqual([]);
  });

  it("a plateau genuinely covering a ridge IS detected", () => {
    // Plateau spanning [10,10]..[12,12] display units; the ridge spine runs through it.
    const plat: Pt2[] = [[10, 10], [12, 10], [12, 12], [10, 12], [10, 10]];
    const lf = landform("lf", plat, { mode: "plateau", target: 400, band: 0.2 });
    const ridge = relief("ridge", [[10.5, 10.5], [11.5, 11.5]], { polarity: "ridge", height: 200, halfWidth: 150 });
    expect(landformReplaceOverlaps(lf, [lf, ridge], SCALE)).toEqual(["ridge"]);
  });

  it("detects a spine within (halfWidth+apron) of the ring but OUTSIDE its bbox", () => {
    // Plateau bbox [10,10]..[12,12]. Spine 0.5 display units (250 m) to the right of
    // the ring edge — outside the ring bbox, but halfWidth 200 m + apron 100 m = 300 m
    // reach = 0.6 units reaches back into the ring ⇒ flagged. A bbox-only test (reach
    // 0) would miss it; the meter→unit reach conversion catches it.
    const plat: Pt2[] = [[10, 10], [12, 10], [12, 12], [10, 12], [10, 10]];
    const lf = landform("lf", plat, { mode: "plateau", target: 400, band: 0.2 });
    const spine = relief("spine", [[12.5, 10.5], [12.5, 11.5]], { polarity: "ridge", height: 200, halfWidth: 200, apron: 100 });
    expect(landformReplaceOverlaps(lf, [lf, spine], SCALE)).toEqual(["spine"]);
    // Nudge the spine out past the reach (0.7 units = 350 m > 300 m reach) ⇒ silent.
    const farSpine = relief("far", [[12.7, 10.5], [12.7, 11.5]], { polarity: "ridge", height: 200, halfWidth: 200, apron: 100 });
    expect(landformReplaceOverlaps(lf, [lf, farSpine], SCALE)).toEqual([]);
  });
});
