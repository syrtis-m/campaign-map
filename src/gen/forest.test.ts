import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { generateForest, type ForestParams } from "./forest";
import { makeRegion, distanceToBoundary, type ProcgenRegion } from "./region";
import type { GenerationConstraints } from "./types";
import { clipNetworkToTile } from "./citynet";
import { tileBBox, tileXYForPoint } from "./cache/tileGrid";

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
    const a = generateForest(1234, region, PARAMS(), CONSTRAINTS);
    const b = generateForest(1234, region, PARAMS(), CONSTRAINTS);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.length).toBeGreaterThan(0);
  });

  it("hashes feature ids on position, not emission order (integer ids)", () => {
    const feats = generateForest(7, regionFor(SQUARE), PARAMS(), CONSTRAINTS);
    for (const f of feats) {
      expect(typeof f.id).toBe("number");
      expect(Number.isFinite(Number(f.id))).toBe(true);
    }
  });

  it("emits canopy, clearings, and trees for a mixed woodland", () => {
    const feats = generateForest(9, regionFor(SQUARE), PARAMS({ clearings: 0.3 }), CONSTRAINTS);
    expect(typeCount(feats, "forest-canopy")).toBeGreaterThan(0);
    expect(typeCount(feats, "forest-clearing")).toBeGreaterThan(0);
    expect(typeCount(feats, "forest-tree")).toBeGreaterThan(0);
  });
});

describe("forest generator — containment (every coordinate inside the ring)", () => {
  for (const preset of [
    { name: "broadleaf", p: PARAMS({ variety: "broadleaf", density: 0.7, clearings: 0.12, edgeRaggedness: 0.45 }) },
    { name: "conifer", p: PARAMS({ variety: "conifer", density: 0.8, clearings: 0.08, edgeRaggedness: 0.3 }) },
    { name: "swamp", p: PARAMS({ variety: "swamp", density: 0.5, clearings: 0.3, edgeRaggedness: 0.65 }) },
    { name: "dead-wood", p: PARAMS({ variety: "dead-wood", density: 0.35, clearings: 0.35, edgeRaggedness: 0.7 }) },
  ]) {
    it(`all output inside the ring — ${preset.name}`, () => {
      const region = regionFor(SQUARE);
      const feats = generateForest(99, region, preset.p, CONSTRAINTS);
      expect(feats.length).toBeGreaterThan(0);
      for (const [x, y] of allCoords(feats)) {
        expect(distanceToBoundary(region, x, y)).toBeGreaterThanOrEqual(-1);
      }
    });
  }

  it("stays inside a strongly concave (L-shaped) region", () => {
    const region = regionFor(L_SHAPE);
    const feats = generateForest(42, region, PARAMS(), CONSTRAINTS);
    expect(feats.length).toBeGreaterThan(0);
    for (const [x, y] of allCoords(feats)) {
      expect(distanceToBoundary(region, x, y)).toBeGreaterThanOrEqual(-1);
    }
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
  it("denser presets emit more canopy than sparse ones (same region/seed)", () => {
    const region = regionFor(SQUARE);
    const dense = generateForest(3, region, PARAMS({ density: 0.9, clearings: 0.05 }), CONSTRAINTS);
    const sparse = generateForest(3, region, PARAMS({ density: 0.3, clearings: 0.05 }), CONSTRAINTS);
    expect(typeCount(dense, "forest-canopy")).toBeGreaterThan(typeCount(sparse, "forest-canopy"));
  });

  it("carries the variety onto emitted features (theme tint hook)", () => {
    const feats = generateForest(3, regionFor(SQUARE), PARAMS({ variety: "conifer" }), CONSTRAINTS);
    expect(feats.length).toBeGreaterThan(0);
    for (const f of feats) expect((f.properties as { forestType?: string }).forestType).toBe("conifer");
  });

  it("no clearings when clearings = 0", () => {
    const feats = generateForest(3, regionFor(SQUARE), PARAMS({ clearings: 0 }), CONSTRAINTS);
    expect(typeCount(feats, "forest-clearing")).toBe(0);
    expect(typeCount(feats, "forest-canopy")).toBeGreaterThan(0);
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
