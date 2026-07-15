// Metrics module — two jobs:
//   1. MEANINGFULNESS: each metric returns the hand-computed value on a
//      synthetic fixture whose geometry we control exactly (so the measurement
//      logic is proven independent of the city generator).
//   2. BENCHMARK GATES: each preset, generated deterministically on the gallery
//      ring with PINNED seeds, lands inside its band, and the cross-preset
//      ORDERINGS the research predicts hold.
// Determinism: metrics are a pure function of (features, region) — same input,
// same numbers forever.
import { describe, expect, it } from "vitest";
import {
  computeNetworkMetrics,
  benchmarkViolations,
  PRESET_BENCHMARKS,
  WIDTH_BY_CLASS,
  type NetworkMetrics,
} from "./metrics";
import { generateCityNetwork, type ProfileId } from "./index";
import { makeRegion, type ProcgenRegion } from "../region";
import { hashSeed } from "../rng";
import { allCoordsInside } from "./citynet.fixtures";

const WORLD = { minX: -8000, minY: -8000, maxX: 8000, maxY: 8000 };
const GALLERY_SEED = 90210;

/** The gallery shape: a regular 16-gon of effective radius ~700 m at the
 * origin — the SAME apples-to-apples boundary every gallery preset uses, so
 * on-screen differences are the preset, never the polygon. */
function galleryRegion(effR = 700, n = 16): ProcgenRegion {
  const targetArea = Math.PI * effR * effR;
  const unit = 0.5 * n * Math.sin((2 * Math.PI) / n);
  const R = Math.sqrt(targetArea / unit);
  const ring: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * Math.PI;
    ring.push([R * Math.cos(a), R * Math.sin(a)]);
  }
  ring.push(ring[0]);
  return makeRegion("gallery", ring);
}

function presetNet(profile: ProfileId, region: ProcgenRegion): GeoJSON.Feature[] {
  const seed = hashSeed(GALLERY_SEED, "gallery", profile);
  return generateCityNetwork(seed, region, profile, { worldBounds: WORLD });
}

// ── Synthetic-fixture helpers (exact hand geometry) ──────────────────────────

function street(id: number, coords: [number, number][], roadClass = "street"): GeoJSON.Feature {
  return {
    type: "Feature",
    id,
    geometry: { type: "LineString", coordinates: coords },
    properties: { generated: true, generatorId: "city-street", type: "street", roadClass },
  };
}
function block(id: number, ring: [number, number][]): GeoJSON.Feature {
  return {
    type: "Feature",
    id,
    geometry: { type: "Polygon", coordinates: [ring] },
    properties: { generated: true, generatorId: "city-block", type: "block" },
  };
}

/** A square region of exactly 1 km² (1000×1000 m) so per-km² metrics read
 * straight off the raw counts. */
function squareKm2(): ProcgenRegion {
  return makeRegion("sq", [
    [0, 0],
    [1000, 0],
    [1000, 1000],
    [0, 1000],
    [0, 0],
  ]);
}

describe("computeNetworkMetrics — meaningfulness on exact hand geometry", () => {
  it("a 3×3 node grid (100 m spacing) yields the hand-computed nodes/links/intersections", () => {
    // 9 nodes at (i,j)·100, one LineString per grid edge (edges split at nodes,
    // exactly as the generator emits chains). 3 rows × 2 + 3 cols × 2 = 12 edges.
    const feats: GeoJSON.Feature[] = [];
    let id = 1;
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 2; c++) {
        feats.push(street(id++, [[c * 100, r * 100], [(c + 1) * 100, r * 100]]));
      }
    }
    for (let c = 0; c < 3; c++) {
      for (let r = 0; r < 2; r++) {
        feats.push(street(id++, [[c * 100, r * 100], [c * 100, (r + 1) * 100]]));
      }
    }
    const m = computeNetworkMetrics(feats, squareKm2());
    // Degrees: 4 corners=2, 4 edge-mids=3, 1 centre=4 → intersections (≥3) = 5,
    // dead-ends (=1) = 0, nodes = 9, links = 12.
    expect(m.nodeCount).toBe(9);
    expect(m.linkCount).toBe(12);
    expect(m.intersectionCount).toBe(5);
    expect(m.deadEndCount).toBe(0);
    expect(m.permeability).toBeCloseTo(12 / 9, 6);
    // area = 1 km² exactly ⇒ per-km² == raw.
    expect(m.areaKm2).toBeCloseTo(1, 3);
    expect(m.intersectionsPerKm2).toBeCloseTo(5, 3);
    // 12 edges × 100 m = 1200 m = 1.2 km.
    expect(m.streetKm).toBeCloseTo(1.2, 6);
    expect(m.streetKmPerKm2).toBeCloseTo(1.2, 3);
  });

  it("a stub off a line is a dead-end; width bands + land share match the width table", () => {
    // One 300 m arterial (width 18) with a 40 m alley (width 5) stub at its end.
    const feats = [
      street(1, [[0, 500], [300, 500]], "arterial"),
      street(2, [[300, 500], [300, 540]], "alley"),
    ];
    const m = computeNetworkMetrics(feats, squareKm2());
    // Nodes: (0,500) deg1, (300,500) deg2, (300,540) deg1 → 2 dead-ends, 0 intersections.
    expect(m.nodeCount).toBe(3);
    expect(m.deadEndCount).toBe(2);
    expect(m.intersectionCount).toBe(0);
    expect(m.deadEndShare).toBeCloseTo(2 / 3, 6);
    // Width histogram by LENGTH: 300 m in 10–20 band (arterial=18), 40 m <10 (alley=5).
    expect(m.widthHistogram.m10to20).toBeCloseTo(300 / 340, 6);
    expect(m.widthHistogram.lt10).toBeCloseTo(40 / 340, 6);
    expect(m.widthHistogram.gt20).toBe(0);
    // Land share = (300·18 + 40·5) / 1e6 = 5600 / 1e6.
    expect(m.streetLandShare).toBeCloseTo((300 * 18 + 40 * 5) / 1e6, 9);
    // Avenue share = arterial length / total = 300/340.
    expect(m.avenueShare).toBeCloseTo(300 / 340, 6);
  });

  it("blockGrainP50 is √(median block area)", () => {
    // Three square blocks: 100², 200², 300² m² → grains 100, 200, 300 → median 200.
    const feats = [
      block(1, [[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]]),
      block(2, [[0, 0], [200, 0], [200, 200], [0, 200], [0, 0]]),
      block(3, [[0, 0], [300, 0], [300, 300], [0, 300], [0, 0]]),
    ];
    const m = computeNetworkMetrics(feats, squareKm2());
    expect(m.blockCount).toBe(3);
    expect(m.blockGrainP50).toBeCloseTo(200, 3);
  });

  it("prefers an emitted width property over the class table", () => {
    const f = street(1, [[0, 0], [100, 0]], "street");
    (f.properties as Record<string, unknown>).width = 25; // >20 band despite class 'street'
    const m = computeNetworkMetrics([f], squareKm2());
    expect(m.widthHistogram.gt20).toBe(1);
    expect(m.streetLandShare).toBeCloseTo((100 * 25) / 1e6, 9);
    // Sanity: the class fallback would have put it in 10–20.
    expect(WIDTH_BY_CLASS.street).toBe(12);
  });

  it("is a pure deterministic function of its inputs", () => {
    const region = galleryRegion();
    const net = presetNet("euro-medieval", region);
    const a = computeNetworkMetrics(net, region);
    const b = computeNetworkMetrics(net, region);
    expect(b).toEqual(a);
  });

  it("empty / street-less input is well-defined (no NaN/Infinity)", () => {
    const m = computeNetworkMetrics([], squareKm2());
    for (const v of [
      m.intersectionsPerKm2,
      m.streetKmPerKm2,
      m.streetLandShare,
      m.blockGrainP50,
      m.avenueShare,
      m.deadEndShare,
      m.permeability,
    ]) {
      expect(Number.isFinite(v)).toBe(true);
    }
    expect(m.blockGrainP50).toBe(0);
  });
});

describe("computeNetworkMetrics — benchmark gates for the walkable presets", () => {
  const region = galleryRegion();
  // The four WALKABLE presets: the floor/medium-width assertions below are the
  // urbanism-virtue signals that hold for these but DELIBERATELY not for the
  // superblock anti-pattern, so superblock is measured separately.
  const profiles: ProfileId[] = ["euro-medieval", "euro-continental", "na-grid", "na-suburb"];
  const M: Record<string, NetworkMetrics> = {};
  for (const p of [...profiles, "superblock" as ProfileId]) M[p] = computeNetworkMetrics(presetNet(p, region), region);

  for (const p of [...profiles, "superblock" as ProfileId]) {
    it(`${p} lands inside its benchmark band (anchor: ${PRESET_BENCHMARKS[p].anchor})`, () => {
      const violations = benchmarkViolations(p, M[p]);
      expect(violations, violations.join("; ")).toEqual([]);
    });
  }

  it("all presets clear Salat's ≥15 km/km² street-density floor (guideline 18)", () => {
    for (const p of profiles) expect(M[p].streetKmPerKm2).toBeGreaterThanOrEqual(15);
  });

  it("euro-medieval grain sits in Salat's urban-grain window (finer end of 30–120 m)", () => {
    expect(M["euro-medieval"].blockGrainP50).toBeGreaterThanOrEqual(30);
    expect(M["euro-medieval"].blockGrainP50).toBeLessThanOrEqual(120);
  });

  // ── Cross-preset orderings — the strongest research-faithful signals ───────
  it("na-grid is the coarsest grain and the most permeable (the grid signature)", () => {
    const grid = M["na-grid"];
    for (const p of ["euro-medieval", "euro-continental", "na-suburb"] as const) {
      expect(grid.blockGrainP50).toBeGreaterThan(M[p].blockGrainP50);
      expect(grid.permeability).toBeGreaterThan(M[p].permeability);
    }
  });

  it("na-grid is the sparsest: fewest intersections/km² and least street length/km²", () => {
    const grid = M["na-grid"];
    for (const p of ["euro-medieval", "euro-continental", "na-suburb"] as const) {
      expect(grid.intersectionsPerKm2).toBeLessThan(M[p].intersectionsPerKm2);
      expect(grid.streetKmPerKm2).toBeLessThan(M[p].streetKmPerKm2);
    }
  });

  it("euro-medieval is a finer, denser warren than the na-grid (Venice vs Manhattan)", () => {
    expect(M["euro-medieval"].blockGrainP50).toBeLessThan(M["na-grid"].blockGrainP50);
    expect(M["euro-medieval"].intersectionsPerKm2).toBeGreaterThan(M["na-grid"].intersectionsPerKm2);
  });

  it("na-suburb produces more dead-ends than the na-grid (the cul-de-sac signature)", () => {
    expect(M["na-suburb"].deadEndCount).toBeGreaterThan(M["na-grid"].deadEndCount);
  });

  it("every walkable preset's streets are majority medium-width (10–20 m band)", () => {
    for (const p of profiles) expect(M[p].widthHistogram.m10to20).toBeGreaterThanOrEqual(0.85);
  });

  // ── superblock: the research's anti-pattern, asserted AS the genre ─────────
  it("superblock is the SPARSEST preset: fewer intersections/km² than every walkable preset", () => {
    for (const p of profiles) {
      expect(M["superblock"].intersectionsPerKm2).toBeLessThan(M[p].intersectionsPerKm2);
    }
  });

  it("superblock is the LEAST permeable preset: the tree-like low-connectivity signature", () => {
    for (const p of profiles) {
      expect(M["superblock"].permeability).toBeLessThan(M[p].permeability);
    }
  });

  it("superblock streets run BELOW Salat's 18 km/km² floor — the deliberate anti-pattern (all walkable presets clear it)", () => {
    expect(M["superblock"].streetKmPerKm2).toBeLessThan(15);
  });

  it("superblock is the ONLY preset with wide arterial canyons: >15% of street length in the >20 m band", () => {
    expect(M["superblock"].widthHistogram.gt20).toBeGreaterThan(0.15);
    for (const p of profiles) expect(M[p].widthHistogram.gt20).toBe(0);
  });
});

describe("benchmark gates — grid presets (tartan-grid / ward-grid / eixample)", () => {
  const region = galleryRegion();
  // Every preset (all eight) measured once on the pinned gallery ring.
  const ALL: ProfileId[] = [
    "euro-medieval",
    "euro-continental",
    "na-grid",
    "na-suburb",
    "superblock",
    "tartan-grid",
    "ward-grid",
    "eixample",
  ];
  const M: Record<string, NetworkMetrics> = {};
  for (const p of ALL) M[p] = computeNetworkMetrics(presetNet(p, region), region);

  for (const p of ["tartan-grid", "ward-grid", "eixample"] as ProfileId[]) {
    it(`${p} lands inside its benchmark band (anchor: ${PRESET_BENCHMARKS[p].anchor})`, () => {
      const violations = benchmarkViolations(p, M[p]);
      expect(violations, violations.join("; ")).toEqual([]);
    });
  }

  // ── tartan-grid: the two-scale Seoul/Tokyo grid ───────────────────────────
  it("tartan-grid is the DENSEST preset — the highest intersections/km² of ALL presets", () => {
    for (const p of ALL) {
      if (p === "tartan-grid") continue;
      expect(
        M["tartan-grid"].intersectionsPerKm2,
        `tartan-grid ${M["tartan-grid"].intersectionsPerKm2.toFixed(0)} vs ${p} ${M[p].intersectionsPerKm2.toFixed(0)}`
      ).toBeGreaterThan(M[p].intersectionsPerKm2);
    }
  });

  it("tartan-grid is the NARROWEST fabric: majority of street length in the <10 m band", () => {
    expect(M["tartan-grid"].widthHistogram.lt10).toBeGreaterThan(0.5);
    // No walkable/legacy preset is narrow-majority (their streets are 10–20 m).
    for (const p of ["euro-medieval", "euro-continental", "na-grid", "na-suburb", "ward-grid", "eixample"] as ProfileId[]) {
      expect(M[p].widthHistogram.lt10).toBeLessThan(0.5);
    }
  });

  // ── ward-grid: regular walled quarters ────────────────────────────────────
  it("ward-grid clears Salat's ≥15 km/km² street-density floor (a walkable regular grid)", () => {
    expect(M["ward-grid"].streetKmPerKm2).toBeGreaterThanOrEqual(15);
  });

  it("ward-grid shows wide-main width contrast: some street length in the >20 m band (directional asymmetry)", () => {
    // Its 24 m arterials land in the >20 m band; the narrow 10 m standards don't.
    expect(M["ward-grid"].widthHistogram.gt20).toBeGreaterThan(0);
    expect(M["ward-grid"].widthHistogram.gt20).toBeLessThan(0.2);
  });

  // ── eixample: uniform chamfered grid ──────────────────────────────────────
  it("eixample is a permeable, low-dead-end grid (uniform blocks, not a cul-de-sac fabric)", () => {
    expect(M["eixample"].permeability).toBeGreaterThan(1.3);
    expect(M["eixample"].deadEndShare).toBeLessThan(M["na-suburb"].deadEndShare);
  });

  it("all grid presets clear Salat's ≥15 km/km² floor (none is the superblock anti-pattern)", () => {
    for (const p of ["tartan-grid", "ward-grid", "eixample"] as ProfileId[]) {
      expect(M[p].streetKmPerKm2).toBeGreaterThanOrEqual(15);
    }
  });
});

describe("benchmark gates — axial presets (haussmann / baroque-axial)", () => {
  const region = galleryRegion();
  const AXIAL: ProfileId[] = ["haussmann", "baroque-axial"];
  const M: Record<string, NetworkMetrics> = {};
  for (const p of [...AXIAL, "euro-medieval" as ProfileId])
    M[p] = computeNetworkMetrics(presetNet(p, region), region);

  for (const p of AXIAL) {
    it(`${p} lands inside its benchmark band (anchor: ${PRESET_BENCHMARKS[p].anchor})`, () => {
      const violations = benchmarkViolations(p, M[p]);
      expect(violations, violations.join("; ")).toEqual([]);
    });
  }

  // The axial operator only ADDS fabric (boulevards + their crossings), so both
  // presets read DENSER than their euro-medieval organic base — more street
  // length, more intersections. The "cut through, preserve between" story.
  it("both axial presets are denser than plain euro-medieval (the boulevards add fabric)", () => {
    for (const p of AXIAL) {
      expect(
        M[p].streetKmPerKm2,
        `${p} ${M[p].streetKmPerKm2.toFixed(1)} vs euro-medieval ${M["euro-medieval"].streetKmPerKm2.toFixed(1)}`
      ).toBeGreaterThan(M["euro-medieval"].streetKmPerKm2);
      expect(M[p].intersectionsPerKm2).toBeGreaterThan(M["euro-medieval"].intersectionsPerKm2);
    }
  });

  // The wide (30 m) boulevards are the ONLY reason a euro-organic preset shows a
  // >20 m width column — plain euro-medieval has none (its widest street is the
  // 18 m arterial, which lands in the 10–20 band).
  it("the boulevard cuts put a slice of street length in the >20 m band (euro-medieval has none)", () => {
    expect(M["euro-medieval"].widthHistogram.gt20).toBe(0);
    for (const p of AXIAL) {
      expect(M[p].widthHistogram.gt20, `${p} >20 m band`).toBeGreaterThan(0);
    }
  });

  it("both axial presets clear Salat's ≥15 km/km² floor (composed organic fabric, not the anti-pattern)", () => {
    for (const p of AXIAL) expect(M[p].streetKmPerKm2).toBeGreaterThanOrEqual(15);
  });
});

describe("benchmark gates — concentric-ring presets (canal-rings / radial-star)", () => {
  const region = galleryRegion();
  const RINGS: ProfileId[] = ["canal-rings", "radial-star"];
  const M: Record<string, NetworkMetrics> = {};
  for (const p of RINGS) M[p] = computeNetworkMetrics(presetNet(p, region), region);

  for (const p of RINGS) {
    it(`${p} lands inside its benchmark band (anchor: ${PRESET_BENCHMARKS[p].anchor})`, () => {
      const violations = benchmarkViolations(p, M[p]);
      expect(violations, violations.join("; ")).toEqual([]);
    });
  }

  // ── canal-rings: concentric canals crossed by radial bridges ──────────────
  it("canal-rings emits concentric CANAL water lines (city-landmark type=canal)", () => {
    const net = presetNet("canal-rings", region);
    const canals = net.filter(
      (f) => f.properties?.generatorId === "city-landmark" && f.properties?.type === "canal"
    );
    // 3 concentric canals authored (a concave clip could split one, so ≥3).
    expect(canals.length).toBeGreaterThanOrEqual(3);
    // No OTHER preset emits a canal (the water is the canal-rings signature).
    for (const p of ["euro-medieval", "radial-star"] as ProfileId[]) {
      const other = presetNet(p, region).filter((f) => f.properties?.type === "canal");
      expect(other.length, `${p} canals`).toBe(0);
    }
  });

  it("canal-rings BRIDGES its canals: radial arterials cross the water as bridge features", () => {
    const net = presetNet("canal-rings", region);
    const bridges = net.filter((f) => f.properties?.type === "bridge");
    // 6 radials × 3 canals ⇒ many bridges (the Amsterdam radial-bridge read).
    expect(bridges.length).toBeGreaterThan(6);
  });

  // ── radial-star: star spokes + concentric connector rings ─────────────────
  it("radial-star splices concentric connector RINGS: many ring-class street chains", () => {
    const net = presetNet("radial-star", region);
    const ringChains = net.filter(
      (f) => f.properties?.generatorId === "city-street" && f.properties?.roadClass === "ring"
    );
    expect(ringChains.length).toBeGreaterThan(10);
    // radial-star has NO canals (roads, not water).
    expect(net.filter((f) => f.properties?.type === "canal").length).toBe(0);
  });

  it("radial-star is a through-avenue web: high avenueShare (spokes + rings), well-connected", () => {
    expect(M["radial-star"].avenueShare).toBeGreaterThan(0.2);
    expect(M["radial-star"].permeability).toBeGreaterThan(1.1);
  });
});

describe("additive upgrades — seam boulevards (na-grid) + growth rings (euro-medieval)", () => {
  const region = galleryRegion();
  const seed = (p: ProfileId): number => hashSeed(GALLERY_SEED, "gallery", p);

  // Serialize a network to a stable digest (ids + geometry) for byte-comparison.
  const digest = (net: GeoJSON.Feature[]): string =>
    JSON.stringify(net.map((f) => [f.id, f.geometry]));

  it("na-grid seamBoulevard is OFF by default → byte-identical; ON → adds a wide diagonal boulevard", () => {
    const base = generateCityNetwork(seed("na-grid"), region, "na-grid", { worldBounds: WORLD });
    const off = generateCityNetwork(seed("na-grid"), region, "na-grid", { worldBounds: WORLD }, undefined, {
      seamBoulevard: false,
    });
    // Default and explicit-off are byte-identical.
    expect(digest(off)).toBe(digest(base));

    const on = generateCityNetwork(seed("na-grid"), region, "na-grid", { worldBounds: WORLD }, undefined, {
      seamBoulevard: true,
    });
    // The seam adds boulevard-class (30 m) fabric that plain na-grid never has.
    const baseBlvd = base.filter((f) => f.properties?.roadClass === "boulevard").length;
    const onBlvd = on.filter((f) => f.properties?.roadClass === "boulevard").length;
    expect(baseBlvd).toBe(0);
    expect(onBlvd).toBeGreaterThan(0);
    // Determinism: same override twice ⇒ byte-identical.
    const on2 = generateCityNetwork(seed("na-grid"), region, "na-grid", { worldBounds: WORLD }, undefined, {
      seamBoulevard: true,
    });
    expect(digest(on2)).toBe(digest(on));
    expect(allCoordsInside(on, region)).toBe(true);
  });

  it("euro-medieval growthRings defaults to 1 (byte-identical); 2 splices an inner ring road", () => {
    const base = generateCityNetwork(seed("euro-medieval"), region, "euro-medieval", { worldBounds: WORLD });
    const one = generateCityNetwork(seed("euro-medieval"), region, "euro-medieval", { worldBounds: WORLD }, undefined, {
      growthRings: 1,
    });
    expect(digest(one)).toBe(digest(base));

    const two = generateCityNetwork(seed("euro-medieval"), region, "euro-medieval", { worldBounds: WORLD }, undefined, {
      growthRings: 2,
    });
    // The inner ring road adds ring-class fabric + intersections (denser).
    const baseRings = base.filter((f) => f.properties?.roadClass === "ring").length;
    const twoRings = two.filter((f) => f.properties?.roadClass === "ring").length;
    expect(twoRings).toBeGreaterThan(baseRings);
    const two2 = generateCityNetwork(seed("euro-medieval"), region, "euro-medieval", { worldBounds: WORLD }, undefined, {
      growthRings: 2,
    });
    expect(digest(two2)).toBe(digest(two));
    expect(allCoordsInside(two, region)).toBe(true);
  });
});

describe("form-based width — the generator emits an explicit metre width per street", () => {
  const region = galleryRegion();

  it("every city-street feature carries a numeric width matching its profile's class table", () => {
    // The four walkable profiles all share LEGACY_STREET_WIDTHS:
    // arterial 18 · ring 16 · street 12 · alley 5.
    const legacy: Record<string, number> = { arterial: 18, ring: 16, street: 12, alley: 5 };
    const net = presetNet("euro-medieval", region);
    const streets = net.filter((f) => f.properties?.generatorId === "city-street");
    expect(streets.length).toBeGreaterThan(0);
    for (const f of streets) {
      const w = f.properties?.width;
      const cls = String(f.properties?.roadClass);
      expect(typeof w, `street ${f.id} width type`).toBe("number");
      expect(w, `roadClass ${cls}`).toBe(legacy[cls]);
    }
  });

  it("superblock emits its wide 85 m arterial canyons (its own width table, not the legacy one)", () => {
    const net = presetNet("superblock", region);
    const arterials = net.filter(
      (f) => f.properties?.generatorId === "city-street" && f.properties?.roadClass === "arterial"
    );
    expect(arterials.length).toBeGreaterThan(0);
    for (const f of arterials) expect(f.properties?.width).toBe(85);
  });
});
