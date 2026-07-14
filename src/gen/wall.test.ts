import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { generateWall, wallMaxOffset, type WallParams } from "./wall";
import { makeSpine, makeCorridorRegion, distanceToBoundary, type ProcgenRegion } from "./region";
import type { GenerationConstraints } from "./types";
import type { FabricFeature } from "../model/fabric";
import { clipNetworkToTile } from "./citynet";
import { tileBBox, tileXYForPoint } from "./cache/tileGrid";

type Pt = [number, number];

const CONSTRAINTS: GenerationConstraints = {
  worldBounds: { minX: -1e5, minY: -1e5, maxX: 1e5, maxY: 1e5 },
};

/** A long, gently angular multi-segment wall spine in gen-space meters — long
 * enough (with a tight towerSpacing) that the along-run tower field dominates
 * the corner accents, so the locality statistic is stable (advisor 2026-07-13). */
const LINE: Pt[] = [
  [0, 0],
  [400, 60],
  [800, -40],
  [1200, 40],
  [1600, 0],
];

const PARAMS = (o: Partial<WallParams> = {}): WallParams => ({
  style: "curtain-wall",
  towerSpacing: 40,
  moat: false,
  gatehouseScale: 1,
  ...o,
});

function regionFor(line: Pt[], params: WallParams): ProcgenRegion {
  return makeCorridorRegion("wall-test", makeSpine("wall-test", line), wallMaxOffset(params));
}

/** A road that crosses the spine near x≈400 (between vertices 0 and 1). */
function roadConstraints(): GenerationConstraints {
  const road: FabricFeature = {
    type: "Feature",
    id: "road-1",
    geometry: { type: "LineString", coordinates: [[400, -200], [400, 200]] },
    properties: { kind: "road" },
  } as unknown as FabricFeature;
  return { ...CONSTRAINTS, fabricFeatures: [road] };
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

/** Coordinate buckets for a single generatorId — the locality measure. */
function bucketsOf(feats: GeoJSON.Feature[], gid: string, grid = 6): Set<string> {
  const s = new Set<string>();
  for (const f of feats) {
    if ((f.properties as { generatorId?: string }).generatorId !== gid) continue;
    for (const [x, y] of allCoords([f])) s.add(`${Math.round(x / grid)},${Math.round(y / grid)}`);
  }
  return s;
}

function overlapPct(a: Set<string>, b: Set<string>): number {
  if (a.size === 0) return 0;
  let hit = 0;
  for (const k of a) if (b.has(k)) hit++;
  return (hit / a.size) * 100;
}

function typeCount(feats: GeoJSON.Feature[], gid: string): number {
  return feats.filter((f) => (f.properties as { generatorId?: string }).generatorId === gid).length;
}

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

describe("wall generator — determinism", () => {
  it("matches the seeded snapshot fixture (bastioned + moat — golden drift tripwire)", () => {
    const p = PARAMS({ style: "bastioned", towerSpacing: 90, moat: true, gatehouseScale: 1.4 });
    expect(digest(generateWall(4242, regionFor(LINE, p), p, roadConstraints()))).toMatchSnapshot();
  });

  it("is byte-identical across two runs (same seed/region/params)", () => {
    const region = regionFor(LINE, PARAMS());
    const a = generateWall(1234, region, PARAMS(), CONSTRAINTS);
    const b = generateWall(1234, region, PARAMS(), CONSTRAINTS);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.length).toBeGreaterThan(0);
  });

  it("hashes feature ids on position, not emission order (integer ids)", () => {
    const feats = generateWall(7, regionFor(LINE, PARAMS()), PARAMS(), CONSTRAINTS);
    for (const f of feats) {
      expect(typeof f.id).toBe("number");
      expect(Number.isFinite(Number(f.id))).toBe(true);
    }
  });
});

describe("wall generator — preset semantics", () => {
  it("curtain-wall emits a masonry band AND towers, no moat", () => {
    const feats = generateWall(9, regionFor(LINE, PARAMS()), PARAMS({ style: "curtain-wall" }), CONSTRAINTS);
    expect(typeCount(feats, "wall-quad")).toBeGreaterThan(0);
    expect(typeCount(feats, "wall-tower")).toBeGreaterThan(0);
    expect(typeCount(feats, "wall-moat")).toBe(0);
  });

  it("palisade emits a band but NO towers (timber stockade)", () => {
    const p = PARAMS({ style: "palisade" });
    const feats = generateWall(9, regionFor(LINE, p), p, CONSTRAINTS);
    expect(typeCount(feats, "wall-quad")).toBeGreaterThan(0);
    expect(typeCount(feats, "wall-tower")).toBe(0);
  });

  it("bastioned emits towers AND (when moat=true) an outboard moat channel", () => {
    const p = PARAMS({ style: "bastioned", moat: true });
    const feats = generateWall(9, regionFor(LINE, p), p, CONSTRAINTS);
    expect(typeCount(feats, "wall-tower")).toBeGreaterThan(0);
    expect(typeCount(feats, "wall-moat")).toBeGreaterThan(0);
  });

  it("carries the style onto every emitted feature (theme tint hook)", () => {
    const p = PARAMS({ style: "bastioned", moat: true });
    const feats = generateWall(3, regionFor(LINE, p), p, roadConstraints());
    expect(feats.length).toBeGreaterThan(0);
    for (const f of feats) expect((f.properties as { wallStyle?: string }).wallStyle).toBe("bastioned");
  });

  it("a tighter towerSpacing places MORE towers", () => {
    const sparse = PARAMS({ towerSpacing: 120 });
    const dense = PARAMS({ towerSpacing: 25 });
    const nSparse = typeCount(generateWall(3, regionFor(LINE, sparse), sparse, CONSTRAINTS), "wall-tower");
    const nDense = typeCount(generateWall(3, regionFor(LINE, dense), dense, CONSTRAINTS), "wall-tower");
    expect(nDense).toBeGreaterThan(nSparse);
  });
});

describe("wall generator — gates at road crossings (plan 022 §3.4)", () => {
  it("emits a wall-gate where a sketched road crosses the spine", () => {
    const feats = generateWall(11, regionFor(LINE, PARAMS()), PARAMS(), roadConstraints());
    const gates = feats.filter((f) => (f.properties as { generatorId?: string }).generatorId === "wall-gate");
    expect(gates.length).toBe(1);
    const [gx] = (gates[0].geometry as unknown as { coordinates: Pt }).coordinates;
    expect(Math.abs(gx - 400)).toBeLessThan(2); // at the crossing
  });

  it("no gates when no road crosses the wall", () => {
    const feats = generateWall(11, regionFor(LINE, PARAMS()), PARAMS(), CONSTRAINTS);
    expect(typeCount(feats, "wall-gate")).toBe(0);
  });

  it("opens a gap in the band at the gate (fewer band quads than an ungated wall)", () => {
    const gated = typeCount(generateWall(11, regionFor(LINE, PARAMS()), PARAMS(), roadConstraints()), "wall-quad");
    const solid = typeCount(generateWall(11, regionFor(LINE, PARAMS()), PARAMS(), CONSTRAINTS), "wall-quad");
    expect(gated).toBeLessThan(solid);
  });
});

describe("wall generator — containment (every coordinate inside the corridor)", () => {
  for (const preset of [
    { name: "curtain-wall", p: PARAMS({ style: "curtain-wall" }) },
    { name: "palisade", p: PARAMS({ style: "palisade" }) },
    { name: "bastioned+moat", p: PARAMS({ style: "bastioned", moat: true, gatehouseScale: 2 }) },
  ]) {
    it(`all output inside the corridor — ${preset.name}`, () => {
      const region = regionFor(LINE, preset.p);
      const feats = generateWall(99, region, preset.p, roadConstraints());
      expect(feats.length).toBeGreaterThan(0);
      for (const [x, y] of allCoords(feats)) {
        expect(distanceToBoundary(region, x, y)).toBeGreaterThanOrEqual(-1);
      }
    });
  }

  it("wallMaxOffset grows monotonically when a moat / bigger gatehouse is added", () => {
    const base = wallMaxOffset(PARAMS({ style: "palisade" }));
    const towers = wallMaxOffset(PARAMS({ style: "curtain-wall" }));
    const moated = wallMaxOffset(PARAMS({ style: "bastioned", moat: true }));
    expect(towers).toBeGreaterThanOrEqual(base);
    expect(moated).toBeGreaterThan(towers);
  });
});

describe("wall generator — identity / edit locality (per-segment tower phase)", () => {
  it("a single vertex edit keeps towers on untouched segments far more than a re-roll", () => {
    const base = bucketsOf(generateWall(50, regionFor(LINE, PARAMS()), PARAMS(), CONSTRAINTS), "wall-tower");

    // Move the LAST vertex — only the last segment re-phases; every earlier
    // segment's tower run is byte-identical.
    const moved: Pt[] = [...LINE.slice(0, -1), [1600, 120]];
    const movedBuckets = bucketsOf(generateWall(50, regionFor(moved, PARAMS()), PARAMS(), CONSTRAINTS), "wall-tower");

    // Re-roll: a new seed re-phases EVERY segment's tower run.
    const rerolled = bucketsOf(generateWall(51, regionFor(LINE, PARAMS()), PARAMS(), CONSTRAINTS), "wall-tower");

    const editOverlap = overlapPct(base, movedBuckets);
    const rerollOverlap = overlapPct(base, rerolled);
    expect(editOverlap).toBeGreaterThan(rerollOverlap + 25);
    expect(editOverlap).toBeGreaterThan(75);
  });
});

describe("wall generator — 2x2 seam via whole-artifact clip", () => {
  it("clips deterministically and keeps every coordinate inside its tile", () => {
    const p = PARAMS({ style: "bastioned", moat: true });
    const region = regionFor(LINE, p);
    const network = generateWall(21, region, p, roadConstraints());
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
