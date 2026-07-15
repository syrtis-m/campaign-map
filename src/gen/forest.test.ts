import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { generateForest, type ForestParams } from "./forest";
import { makeRegion, distanceToBoundary, type ProcgenRegion } from "./region";
import type { GenerationConstraints } from "./types";
import { clipNetworkToTile } from "./citynet";
import { tileBBox, tileXYForPoint } from "./cache/tileGrid";
import { expectGeneratorInvariants, expectDeterministic } from "./testkit/invariants";
import { computeForestMetrics, forestBandViolations } from "./forestMetrics";

type Pt = [number, number];

const CONSTRAINTS: GenerationConstraints = {
  worldBounds: { minX: -1e5, minY: -1e5, maxX: 1e5, maxY: 1e5 },
};

/** An 800 m square forest region in gen-space meters. */
const SQUARE: Pt[] = [
  [0, 0],
  [800, 0],
  [800, 800],
  [0, 800],
  [0, 0],
];

// L-shape (concave) for containment stress: 900×900 minus the NE 450×450.
const L_SHAPE: Pt[] = [
  [0, 0],
  [900, 0],
  [900, 450],
  [450, 450],
  [450, 900],
  [0, 900],
  [0, 0],
];

const PARAMS = (o: Partial<ForestParams> = {}): ForestParams => ({
  variety: "mixed",
  density: 0.6,
  clearings: 0.15,
  edgeRaggedness: 0.5,
  ...o,
});

function regionFor(ring: Pt[]): ProcgenRegion {
  return makeRegion("forest-test", ring);
}

function allCoords(feats: GeoJSON.Feature[]): Pt[] {
  const out: Pt[] = [];
  const scan = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === "number" && typeof c[1] === "number") {
      out.push([c[0], c[1]]);
      return;
    }
    for (const x of c) scan(x);
  };
  for (const f of feats) scan((f.geometry as { coordinates: unknown }).coordinates);
  return out;
}

function bucketSet(feats: GeoJSON.Feature[], grid = 26): Set<string> {
  const s = new Set<string>();
  for (const [x, y] of allCoords(feats)) s.add(`${Math.round(x / grid)},${Math.round(y / grid)}`);
  return s;
}

function overlapPct(a: Set<string>, b: Set<string>): number {
  if (a.size === 0) return 0;
  let hit = 0;
  for (const k of a) if (b.has(k)) hit++;
  return (hit / a.size) * 100;
}

function typeCount(feats: GeoJSON.Feature[], type: string): number {
  return feats.filter((f) => (f.properties as { generatorId?: string }).generatorId === type).length;
}

function canopyFeature(feats: GeoJSON.Feature[]): GeoJSON.Feature | undefined {
  return feats.find((f) => (f.properties as { generatorId?: string }).generatorId === "forest-canopy");
}

/** Interior holes across every polygon of a canopy MultiPolygon. */
function holeCount(canopy: GeoJSON.Feature): number {
  const mp = (canopy.geometry as unknown as { coordinates: Pt[][][] }).coordinates;
  return mp.reduce((n, poly) => n + (poly.length - 1), 0);
}

/** Total absolute shoelace area of every exterior ring of a canopy MultiPolygon
 * (holes not subtracted) — a stable "how much canopy" proxy for preset compares. */
function canopyExteriorArea(canopy: GeoJSON.Feature | undefined): number {
  if (!canopy) return 0;
  const mp = (canopy.geometry as unknown as { coordinates: Pt[][][] }).coordinates;
  let area = 0;
  for (const poly of mp) {
    const ring = poly[0];
    let a = 0;
    for (let i = 0; i < ring.length - 1; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    area += Math.abs(a / 2);
  }
  return area;
}

/** Hash + per-type counts (the 022 golden tripwire idiom): any numeric drift
 * flips the sha256; self-relative tests survive a uniform change, this does
 * not. */
function digest(features: GeoJSON.Feature[]): { sha256: string; summary: Record<string, number> } {
  const summary: Record<string, number> = { total: features.length };
  for (const f of features) {
    const type = String((f.properties as Record<string, unknown>)?.generatorId);
    summary[type] = (summary[type] ?? 0) + 1;
  }
  return {
    sha256: createHash("sha256").update(JSON.stringify(features)).digest("hex"),
    summary,
  };
}

describe("forest generator — determinism", () => {
  it("matches the seeded snapshot fixture (mixed woodland — golden drift tripwire)", () => {
    const p = PARAMS({ variety: "broadleaf", density: 0.7, clearings: 0.15, edgeRaggedness: 0.45 });
    expect(digest(generateForest(4242, regionFor(SQUARE), p, CONSTRAINTS))).toMatchSnapshot();
  });

  it("is byte-identical across two runs (same seed/region/params)", () => {
    const region = regionFor(SQUARE);
    expectDeterministic(() => generateForest(1234, region, PARAMS(), CONSTRAINTS));
  });

  it("hashes feature ids on position, not emission order (integer ids)", () => {
    const feats = generateForest(7, regionFor(SQUARE), PARAMS(), CONSTRAINTS);
    for (const f of feats) {
      expect(typeof f.id).toBe("number");
      expect(Number.isFinite(Number(f.id))).toBe(true);
    }
  });

  it("emits ONE canopy MultiPolygon (with clearing holes) + trees for a mixed woodland", () => {
    const feats = generateForest(9, regionFor(SQUARE), PARAMS({ clearings: 0.3 }), CONSTRAINTS);
    const canopy = feats.filter((f) => (f.properties as { generatorId?: string }).generatorId === "forest-canopy");
    expect(canopy.length).toBe(1); // a single organic mass, not a cell soup
    expect(canopy[0].geometry.type).toBe("MultiPolygon");
    // Clearings are now interior HOLES on the canopy polygons (no forest-clearing
    // features are emitted any more).
    expect(typeCount(feats, "forest-clearing")).toBe(0);
    expect(holeCount(canopy[0])).toBeGreaterThan(0);
    expect(typeCount(feats, "forest-tree")).toBeGreaterThan(0);
  });
});

describe("forest generator — structural invariants (containment · closed rings · mm lattice)", () => {
  for (const preset of [
    { name: "broadleaf", p: PARAMS({ variety: "broadleaf", density: 0.7, clearings: 0.12, edgeRaggedness: 0.45 }) },
    { name: "conifer", p: PARAMS({ variety: "conifer", density: 0.8, clearings: 0.08, edgeRaggedness: 0.3 }) },
    { name: "swamp", p: PARAMS({ variety: "swamp", density: 0.5, clearings: 0.3, edgeRaggedness: 0.65 }) },
    { name: "dead-wood", p: PARAMS({ variety: "dead-wood", density: 0.35, clearings: 0.35, edgeRaggedness: 0.7 }) },
  ]) {
    it(`all output inside the ring — ${preset.name}`, () => {
      const region = regionFor(SQUARE);
      expectGeneratorInvariants(generateForest(99, region, preset.p, CONSTRAINTS), region);
    });
  }

  it("stays inside a strongly concave (L-shaped) region", () => {
    const region = regionFor(L_SHAPE);
    expectGeneratorInvariants(generateForest(42, region, PARAMS(), CONSTRAINTS), region);
  });
});

describe("forest generator — identity / edit locality", () => {
  it("a single vertex edit changes output far less than a re-roll", () => {
    const base = generateForest(50, regionFor(SQUARE), PARAMS(), CONSTRAINTS);
    const baseBuckets = bucketSet(base);

    // Move ONE corner outward — only boundary cells near it change containment.
    const moved: Pt[] = [
      [0, 0],
      [860, 0],
      [800, 800],
      [0, 800],
      [0, 0],
    ];
    const movedBuckets = bucketSet(generateForest(50, regionFor(moved), PARAMS(), CONSTRAINTS));

    // Re-roll: a new seed re-rolls the whole canopy noise field.
    const rerolled = bucketSet(generateForest(51, regionFor(SQUARE), PARAMS(), CONSTRAINTS));

    const editOverlap = overlapPct(baseBuckets, movedBuckets);
    const rerollOverlap = overlapPct(baseBuckets, rerolled);
    expect(editOverlap).toBeGreaterThan(rerollOverlap + 25);
    expect(editOverlap).toBeGreaterThan(80);
  });
});

describe("forest generator — preset semantics", () => {
  it("denser presets cover more canopy area than sparse ones (same region/seed)", () => {
    const region = regionFor(SQUARE);
    const dense = generateForest(3, region, PARAMS({ density: 0.9, clearings: 0.05 }), CONSTRAINTS);
    const sparse = generateForest(3, region, PARAMS({ density: 0.3, clearings: 0.05 }), CONSTRAINTS);
    expect(canopyExteriorArea(canopyFeature(dense))).toBeGreaterThan(canopyExteriorArea(canopyFeature(sparse)));
  });

  it("carries the variety onto emitted features (theme tint hook)", () => {
    const feats = generateForest(3, regionFor(SQUARE), PARAMS({ variety: "conifer" }), CONSTRAINTS);
    expect(feats.length).toBeGreaterThan(0);
    for (const f of feats) expect((f.properties as { forestType?: string }).forestType).toBe("conifer");
  });

  it("clearings = 0 yields far fewer holes than a glade-heavy preset (canopy still present)", () => {
    const region = regionFor(SQUARE);
    // With clearings 0 the only interior holes are natural low-noise gaps; a
    // glade-heavy preset punches many more.
    const none = canopyFeature(generateForest(3, region, PARAMS({ density: 0.85, clearings: 0 }), CONSTRAINTS))!;
    const glades = canopyFeature(generateForest(3, region, PARAMS({ density: 0.85, clearings: 0.6 }), CONSTRAINTS))!;
    expect(none).toBeDefined();
    expect(holeCount(none)).toBeLessThan(holeCount(glades));
  });
});

describe("forest generator — organic canopy topology (plan 026-B)", () => {
  it("dead-wood emits NO canopy but still scatters trees (bare stand)", () => {
    const feats = generateForest(9, regionFor(SQUARE), PARAMS({ variety: "dead-wood", density: 0.5 }), CONSTRAINTS);
    expect(canopyFeature(feats)).toBeUndefined();
    expect(typeCount(feats, "forest-tree")).toBeGreaterThan(0);
  });

  it("every living variety emits exactly one canopy MultiPolygon feature", () => {
    for (const variety of ["broadleaf", "conifer", "mixed", "swamp"] as const) {
      const feats = generateForest(9, regionFor(SQUARE), PARAMS({ variety, density: 0.7 }), CONSTRAINTS);
      expect(typeCount(feats, "forest-canopy"), variety).toBe(1);
      expect(canopyFeature(feats)!.geometry.type, variety).toBe("MultiPolygon");
    }
  });

  it("canopy stays comfortably inside the ring (no clip needed — containment floor)", () => {
    const region = regionFor(SQUARE);
    const canopy = canopyFeature(generateForest(9, region, PARAMS({ density: 0.8 }), CONSTRAINTS))!;
    for (const [x, y] of allCoords([canopy])) {
      // The sdf containment floor keeps every canopy vertex metres inside.
      expect(distanceToBoundary(region, x, y)).toBeGreaterThan(0);
    }
  });

  it("Chaikin-smoothed canopy is byte-identical across two runs (determinism)", () => {
    const region = regionFor(SQUARE);
    const a = canopyFeature(generateForest(77, region, PARAMS(), CONSTRAINTS))!;
    const b = canopyFeature(generateForest(77, region, PARAMS(), CONSTRAINTS))!;
    expect(JSON.stringify(a.geometry)).toBe(JSON.stringify(b.geometry));
  });

  it("emits one rim LineString per canopy ring (exterior + holes), seam-safe outline", () => {
    const feats = generateForest(9, regionFor(SQUARE), PARAMS({ clearings: 0.3 }), CONSTRAINTS);
    const canopy = canopyFeature(feats)!;
    const rings = (canopy.geometry as unknown as { coordinates: Pt[][][] }).coordinates.reduce(
      (n, poly) => n + poly.length,
      0
    );
    const rims = feats.filter((f) => (f.properties as { generatorId?: string }).generatorId === "forest-canopy-rim");
    expect(rims.length).toBe(rings); // one rim line per exterior + hole ring
    for (const r of rims) expect(r.geometry.type).toBe("LineString");
  });

  it("higher clearings punches more interior holes (same region/seed)", () => {
    const region = regionFor(SQUARE);
    const many = canopyFeature(generateForest(5, region, PARAMS({ clearings: 0.6 }), CONSTRAINTS))!;
    const few = canopyFeature(generateForest(5, region, PARAMS({ clearings: 0.05 }), CONSTRAINTS))!;
    expect(holeCount(many)).toBeGreaterThan(holeCount(few));
  });
});

describe("forest generator — 2x2 seam via whole-artifact clip", () => {
  it("clips deterministically and keeps every coordinate inside its tile", () => {
    const region = regionFor(SQUARE);
    const network = generateForest(21, region, PARAMS(), CONSTRAINTS);
    const min = tileXYForPoint(region.bbox.minX, region.bbox.minY);
    const max = tileXYForPoint(region.bbox.maxX, region.bbox.maxY);
    let clipped = 0;
    for (let ty = min.tileY; ty <= max.tileY; ty++) {
      for (let tx = min.tileX; tx <= max.tileX; tx++) {
        const bb = tileBBox(tx, ty);
        const a = clipNetworkToTile(network, bb);
        const b = clipNetworkToTile(network, bb);
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
        for (const gid of Object.keys(a)) {
          for (const f of a[gid]) {
            for (const [x, y] of allCoords([f])) {
              expect(x).toBeGreaterThanOrEqual(bb.minX - 1e-3);
              expect(x).toBeLessThanOrEqual(bb.maxX + 1e-3);
              expect(y).toBeGreaterThanOrEqual(bb.minY - 1e-3);
              expect(y).toBeLessThanOrEqual(bb.maxY + 1e-3);
              clipped++;
            }
          }
        }
      }
    }
    expect(clipped).toBeGreaterThan(0);
  });
});

// ── hashed Thomas-cluster tree placement ─────────────────────────────────────

/** A large region for stable placement statistics. */
const BIG: Pt[] = [
  [0, 0],
  [1600, 0],
  [1600, 1600],
  [0, 1600],
  [0, 0],
];

type TreeProps = { forestType: string; sizeN: number; rank: number; variant: number };
function treesOf(feats: GeoJSON.Feature[]): GeoJSON.Feature[] {
  return feats.filter((f) => (f.properties as { generatorId?: string }).generatorId === "forest-tree");
}
function treeProps(f: GeoJSON.Feature): TreeProps {
  return f.properties as unknown as TreeProps;
}

/** Index of dispersion (variance/mean) of tree counts over a `bin`-metre grid
 * across the region bbox. ≈1 for a Poisson/uniform-grid process, >1 clumped,
 * <1 regular. The statistical signature that separates Thomas clusters from a
 * plain stipple grid. */
function dispersionIndex(feats: GeoJSON.Feature[], region: ProcgenRegion, bin: number): number {
  const counts = new Map<string, number>();
  for (const f of treesOf(feats)) {
    const [x, y] = (f.geometry as { coordinates: unknown }).coordinates as Pt;
    const k = `${Math.floor(x / bin)},${Math.floor(y / bin)}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const { minX, minY, maxX, maxY } = region.bbox;
  const vals: number[] = [];
  for (let ix = Math.floor(minX / bin); ix <= Math.floor(maxX / bin); ix++) {
    for (let iy = Math.floor(minY / bin); iy <= Math.floor(maxY / bin); iy++) {
      vals.push(counts.get(`${ix},${iy}`) ?? 0);
    }
  }
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  if (mean === 0) return 0;
  const varr = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
  return varr / mean;
}

describe("forest generator — tree placement is clumped, not a grid (plan 026-A §1.1)", () => {
  const BIN = 80; // ~clump-spread scale: a bin catches a clump core or a gap

  it("broadleaf clumps strongly — dispersion ≫ 1 (a uniform grid would sit at ≈1)", () => {
    const region = regionFor(BIG);
    const feats = generateForest(4242, region, PARAMS({ variety: "broadleaf", density: 0.7 }), CONSTRAINTS);
    expect(treesOf(feats).length).toBeGreaterThan(200);
    expect(dispersionIndex(feats, region, BIN)).toBeGreaterThan(2);
  });

  it("conifer is more regular than broadleaf (the per-variety clustering knob works)", () => {
    const region = regionFor(BIG);
    const broad = dispersionIndex(
      generateForest(4242, region, PARAMS({ variety: "broadleaf", density: 0.7 }), CONSTRAINTS),
      region,
      BIN
    );
    const coni = dispersionIndex(
      generateForest(4242, region, PARAMS({ variety: "conifer", density: 0.7 }), CONSTRAINTS),
      region,
      BIN
    );
    expect(broad).toBeGreaterThan(coni + 0.5);
  });

  it("dead-wood is loners only — every tree rank 2, low dispersion (no clumps)", () => {
    const region = regionFor(BIG);
    const feats = generateForest(9, region, PARAMS({ variety: "dead-wood", density: 0.5 }), CONSTRAINTS);
    const trees = treesOf(feats);
    expect(trees.length).toBeGreaterThan(0);
    for (const t of trees) expect(treeProps(t).rank).toBe(2);
    expect(dispersionIndex(feats, region, BIN)).toBeLessThan(1.5);
  });
});

describe("forest generator — tree property carry (plan 026-A §1.1)", () => {
  it("every tree carries forestType/sizeN/rank/variant in range", () => {
    const region = regionFor(BIG);
    const trees = treesOf(generateForest(4242, region, PARAMS({ variety: "broadleaf", density: 0.7 }), CONSTRAINTS));
    expect(trees.length).toBeGreaterThan(0);
    for (const t of trees) {
      const p = treeProps(t);
      expect(p.forestType).toBe("broadleaf");
      expect(p.sizeN).toBeGreaterThanOrEqual(0);
      expect(p.sizeN).toBeLessThanOrEqual(1);
      expect([0, 1, 2]).toContain(p.rank);
      expect([0, 1, 2, 3]).toContain(p.variant);
    }
  });

  it("tree size varies (sizeN spread wide enough for a ≥2× rendered radius)", () => {
    const region = regionFor(BIG);
    const sizes = treesOf(
      generateForest(4242, region, PARAMS({ variety: "broadleaf", density: 0.7 }), CONSTRAINTS)
    ).map((t) => treeProps(t).sizeN);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeGreaterThan(0.4);
    const mean = sizes.reduce((a, b) => a + b, 0) / sizes.length;
    const varr = sizes.reduce((a, b) => a + (b - mean) ** 2, 0) / sizes.length;
    expect(varr).toBeGreaterThan(0);
  });

  it("clump trees include both cores (rank 0) and fringe (rank 1)", () => {
    const region = regionFor(BIG);
    const ranks = new Set(
      treesOf(generateForest(4242, region, PARAMS({ variety: "broadleaf", density: 0.7 }), CONSTRAINTS)).map(
        (t) => treeProps(t).rank
      )
    );
    expect(ranks.has(0)).toBe(true);
    expect(ranks.has(1)).toBe(true);
  });
});

describe("forest generator — metric bands (regression net)", () => {
  // The band is a tunable safety net: it survives a canopy/clearing retune but
  // catches a gross regression (a canopy that collapses, a tree scatter that
  // vanishes). Measured on the committed golden fixture (broadleaf, seed 4242).
  it("golden fixture (broadleaf) lands inside its metric band", () => {
    const region = regionFor(SQUARE);
    const p = PARAMS({ variety: "broadleaf", density: 0.7, clearings: 0.15, edgeRaggedness: 0.45 });
    const v = forestBandViolations(computeForestMetrics(generateForest(4242, region, p, CONSTRAINTS), region));
    expect(v, v.join("; ")).toEqual([]);
  });

  it("a denser preset covers a greater canopy area fraction than a sparse one (same region/seed)", () => {
    const region = regionFor(SQUARE);
    const dense = computeForestMetrics(generateForest(3, region, PARAMS({ density: 0.9, clearings: 0.05 }), CONSTRAINTS), region);
    const sparse = computeForestMetrics(generateForest(3, region, PARAMS({ density: 0.3, clearings: 0.05 }), CONSTRAINTS), region);
    expect(dense.canopyCoverFrac).toBeGreaterThan(sparse.canopyCoverFrac);
  });
});
