import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { generatePark, type ParkParams } from "./park";
import { makeRegion, distanceToBoundary, type ProcgenRegion } from "./region";
import type { GenerationConstraints } from "./types";
import { clipNetworkToTile } from "./citynet";
import { tileBBox, tileXYForPoint } from "./cache/tileGrid";

type Pt = [number, number];

const CONSTRAINTS: GenerationConstraints = {
  worldBounds: { minX: -1e5, minY: -1e5, maxX: 1e5, maxY: 1e5 },
};

/** A 1000 m square park region in gen-space meters (large ⇒ every japanese
 * element fits: pond + island + rocks + court). */
const SQUARE: Pt[] = [
  [0, 0],
  [1000, 0],
  [1000, 1000],
  [0, 1000],
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

const PARAMS = (o: Partial<ParkParams> = {}): ParkParams => ({
  variety: "city-park",
  pathDensity: 0.5,
  pond: true,
  ...o,
});

function regionFor(ring: Pt[]): ProcgenRegion {
  return makeRegion("park-test", ring);
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

/** Coordinate buckets for a single generatorId — the locality measure (a fine
 * grid so the seed-driven placement jitter registers under a re-roll). Since
 * 027-A the lawn is ONE polygon = the region ring (seed-independent), so
 * edit-locality is now measured on the seed-driven `park-tree` scatter (a
 * far-vertex edit leaves interior trees identical; a re-roll re-places all). */
function bucketsFor(feats: GeoJSON.Feature[], gid: string, grid: number): Set<string> {
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

function typeCount(feats: GeoJSON.Feature[], type: string): number {
  return feats.filter((f) => (f.properties as { generatorId?: string }).generatorId === type).length;
}

/** Hash + per-type counts (the 022 golden tripwire idiom): any numeric drift
 * flips the sha256. */
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

describe("park generator — determinism", () => {
  it("matches the seeded snapshot fixture (japanese garden — golden drift tripwire)", () => {
    const p = PARAMS({ variety: "japanese-garden", pathDensity: 0.4, pond: true });
    expect(digest(generatePark(4242, regionFor(SQUARE), p, CONSTRAINTS))).toMatchSnapshot();
  });

  it("is byte-identical across two runs (same seed/region/params)", () => {
    const region = regionFor(SQUARE);
    const a = generatePark(1234, region, PARAMS(), CONSTRAINTS);
    const b = generatePark(1234, region, PARAMS(), CONSTRAINTS);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.length).toBeGreaterThan(0);
  });

  it("hashes feature ids on position, not emission order (integer ids)", () => {
    const feats = generatePark(7, regionFor(SQUARE), PARAMS(), CONSTRAINTS);
    for (const f of feats) {
      expect(typeof f.id).toBe("number");
      expect(Number.isFinite(Number(f.id))).toBe(true);
    }
  });

  it("japanese-garden emits ground, path, pond, island, bridge, rock and court", () => {
    const feats = generatePark(9, regionFor(SQUARE), PARAMS({ variety: "japanese-garden" }), CONSTRAINTS);
    expect(typeCount(feats, "park-lawn")).toBeGreaterThan(0);
    expect(typeCount(feats, "park-path")).toBeGreaterThan(0);
    expect(typeCount(feats, "park-pond")).toBe(1);
    expect(typeCount(feats, "park-island")).toBe(1);
    expect(typeCount(feats, "park-bridge")).toBeGreaterThan(0);
    expect(typeCount(feats, "park-rock")).toBeGreaterThan(0);
    expect(typeCount(feats, "park-court")).toBe(1);
  });

  it("formal-garden emits axial paths + symmetric beds + rows of trees, no pond", () => {
    const feats = generatePark(9, regionFor(SQUARE), PARAMS({ variety: "formal-garden", pond: false }), CONSTRAINTS);
    expect(typeCount(feats, "park-path")).toBeGreaterThan(0);
    expect(typeCount(feats, "park-bed")).toBeGreaterThan(0);
    expect(typeCount(feats, "park-tree")).toBeGreaterThan(0);
    expect(typeCount(feats, "park-pond")).toBe(0);
  });
});

describe("park generator — containment (every coordinate inside the ring)", () => {
  for (const preset of [
    { name: "formal-garden", p: PARAMS({ variety: "formal-garden", pond: false }) },
    { name: "city-park", p: PARAMS({ variety: "city-park", pond: true }) },
    { name: "wild-common", p: PARAMS({ variety: "wild-common", pond: false }) },
    { name: "japanese-garden", p: PARAMS({ variety: "japanese-garden", pond: true }) },
  ]) {
    it(`all output inside the ring — ${preset.name}`, () => {
      const region = regionFor(SQUARE);
      const feats = generatePark(99, region, preset.p, CONSTRAINTS);
      expect(feats.length).toBeGreaterThan(0);
      for (const [x, y] of allCoords(feats)) {
        expect(distanceToBoundary(region, x, y)).toBeGreaterThanOrEqual(-1);
      }
    });
  }

  it("stays inside a strongly concave (L-shaped) region", () => {
    const region = regionFor(L_SHAPE);
    const feats = generatePark(42, region, PARAMS({ variety: "japanese-garden" }), CONSTRAINTS);
    expect(feats.length).toBeGreaterThan(0);
    for (const [x, y] of allCoords(feats)) {
      expect(distanceToBoundary(region, x, y)).toBeGreaterThanOrEqual(-1);
    }
  });
});

describe("park generator — identity / edit locality", () => {
  it("a single vertex edit changes the tree scatter far less than a re-roll", () => {
    // city-park (PARAMS default) scatters trees on an ABSOLUTE-world lattice —
    // the seed-driven signal that carries edit-locality now that the lawn is the
    // (seed-independent) ring itself.
    const base = bucketsFor(generatePark(50, regionFor(SQUARE), PARAMS(), CONSTRAINTS), "park-tree", 20);

    // Move ONE corner outward — only trees near it change containment.
    const moved: Pt[] = [
      [0, 0],
      [1080, 0],
      [1000, 1000],
      [0, 1000],
      [0, 0],
    ];
    const movedBuckets = bucketsFor(generatePark(50, regionFor(moved), PARAMS(), CONSTRAINTS), "park-tree", 20);

    // Re-roll: a new seed re-places the whole tree scatter.
    const rerolled = bucketsFor(generatePark(51, regionFor(SQUARE), PARAMS(), CONSTRAINTS), "park-tree", 20);

    const editOverlap = overlapPct(base, movedBuckets);
    const rerollOverlap = overlapPct(base, rerolled);
    expect(base.size).toBeGreaterThan(0);
    expect(editOverlap).toBeGreaterThan(rerollOverlap + 25);
    expect(editOverlap).toBeGreaterThan(80);
  });
});

describe("park generator — 027-A figure-ground topology", () => {
  it("emits exactly ONE merged lawn polygon per park (no per-cell lattice)", () => {
    for (const v of ["formal-garden", "city-park", "wild-common", "japanese-garden"] as const) {
      const feats = generatePark(77, regionFor(SQUARE), PARAMS({ variety: v }), CONSTRAINTS);
      expect(typeCount(feats, "park-lawn"), `${v}: expected one merged lawn`).toBe(1);
      const lawn = feats.find((f) => (f.properties as { generatorId?: string }).generatorId === "park-lawn")!;
      expect(lawn.geometry.type).toBe("Polygon");
    }
  });

  it("city-park emits canopy clumps (the second green) as their own polygons", () => {
    const feats = generatePark(88, regionFor(SQUARE), PARAMS({ variety: "city-park" }), CONSTRAINTS);
    expect(typeCount(feats, "park-canopy")).toBeGreaterThan(0);
    for (const f of feats) {
      if ((f.properties as { generatorId?: string }).generatorId !== "park-canopy") continue;
      expect(f.geometry.type).toBe("Polygon");
    }
  });

  it("re-emits paths as classed LineStrings (cased-path pairing hook), not span quads", () => {
    const feats = generatePark(88, regionFor(SQUARE), PARAMS({ variety: "city-park" }), CONSTRAINTS);
    const paths = feats.filter((f) => (f.properties as { generatorId?: string }).generatorId === "park-path");
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) {
      expect(p.geometry.type).toBe("LineString");
      expect(typeof (p.properties as { class?: string }).class).toBe("string");
    }
  });
});

describe("park generator — graceful degradation (japanese-garden, shrinking regions)", () => {
  // court (≥130) → island (≥80) → pond (≥25) → pond-only, never throwing.
  const squareOf = (side: number): Pt[] => [
    [0, 0],
    [side, 0],
    [side, side],
    [0, side],
    [0, 0],
  ];
  it("drops the court, then the island, then the pond as the region shrinks", () => {
    const p = PARAMS({ variety: "japanese-garden" });
    // maxInteriorDistance ≈ side/2 for a square.
    const big = generatePark(3, regionFor(squareOf(600)), p, CONSTRAINTS); // ~300
    const mid = generatePark(3, regionFor(squareOf(320)), p, CONSTRAINTS); // ~160 (court dropped)
    const small = generatePark(3, regionFor(squareOf(200)), p, CONSTRAINTS); // ~100 (island dropped)
    const tiny = generatePark(3, regionFor(squareOf(90)), p, CONSTRAINTS); // ~45 (pond only, no island/court)

    expect(typeCount(big, "park-court")).toBe(1);
    expect(typeCount(big, "park-island")).toBe(1);

    expect(typeCount(mid, "park-court")).toBe(0);
    expect(typeCount(mid, "park-island")).toBe(1);

    expect(typeCount(small, "park-court")).toBe(0);
    expect(typeCount(small, "park-island")).toBe(0);
    expect(typeCount(small, "park-pond")).toBe(1);

    expect(typeCount(tiny, "park-island")).toBe(0);
    expect(typeCount(tiny, "park-court")).toBe(0);
    // tiny may or may not fit a pond; it must not throw and stays contained.
    const region = regionFor(squareOf(90));
    for (const [x, y] of allCoords(tiny)) {
      expect(distanceToBoundary(region, x, y)).toBeGreaterThanOrEqual(-1);
    }
  });
});

describe("park generator — preset semantics", () => {
  it("carries the variety onto emitted features (theme tint hook)", () => {
    const feats = generatePark(3, regionFor(SQUARE), PARAMS({ variety: "wild-common" }), CONSTRAINTS);
    expect(feats.length).toBeGreaterThan(0);
    for (const f of feats) expect((f.properties as { parkType?: string }).parkType).toBe("wild-common");
  });

  it("wild-common scatters more trees than a formal garden's rows", () => {
    const wild = generatePark(3, regionFor(SQUARE), PARAMS({ variety: "wild-common" }), CONSTRAINTS);
    const formal = generatePark(3, regionFor(SQUARE), PARAMS({ variety: "formal-garden" }), CONSTRAINTS);
    expect(typeCount(wild, "park-tree")).toBeGreaterThan(typeCount(formal, "park-tree"));
  });

  it("no pond when pond=false and variety is not japanese", () => {
    const feats = generatePark(3, regionFor(SQUARE), PARAMS({ variety: "city-park", pond: false }), CONSTRAINTS);
    expect(typeCount(feats, "park-pond")).toBe(0);
  });

  it("japanese-garden ponds even when pond=false (its composition anchor)", () => {
    const feats = generatePark(3, regionFor(SQUARE), PARAMS({ variety: "japanese-garden", pond: false }), CONSTRAINTS);
    expect(typeCount(feats, "park-pond")).toBe(1);
  });
});

describe("park generator — 2x2 seam via whole-artifact clip", () => {
  it("clips deterministically and keeps every coordinate inside its tile", () => {
    const region = regionFor(SQUARE);
    const network = generatePark(21, region, PARAMS(), CONSTRAINTS);
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
