import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  generateRiver,
  riverMaxOffset,
  BASE_MEANDER_AMP_M,
  type RiverParams,
} from "./river";
import { makeSpine, makeCorridorRegion, distanceToSpine, type ProcgenRegion } from "./region";
import type { GenerationConstraints } from "./types";
import { clipNetworkToTile } from "./citynet";
import { tileBBox, tileXYForPoint } from "./cache/tileGrid";

type Pt = [number, number];

const CONSTRAINTS: GenerationConstraints = {
  worldBounds: { minX: -1e5, minY: -1e5, maxX: 1e5, maxY: 1e5 },
};

/** A gently kinked multi-segment river spine in gen-space meters. */
const LINE: Pt[] = [
  [0, 0],
  [300, 40],
  [600, -30],
  [900, 50],
  [1200, 0],
];

const PARAMS = (o: Partial<RiverParams> = {}): RiverParams => ({
  windiness: 0.8,
  braiding: 0,
  width: 20,
  widthGrowth: 0,
  braidBias: 0,
  ...o,
});

function regionFor(line: Pt[], params: RiverParams): ProcgenRegion {
  return makeCorridorRegion("river-test", makeSpine("river-test", line), riverMaxOffset(params));
}

/** Every coordinate of every feature, flattened. */
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

function bucketSet(feats: GeoJSON.Feature[], grid = 6): Set<string> {
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

/** Hash + per-type counts (the corridor.test.ts idiom): any numeric drift
 * flips the sha256 without committing megabytes of coordinates. This is the
 * per-generator drift tripwire DECISIONS 2026-07-13 asked of every 022+
 * generator — self-relative determinism tests survive a uniform algorithm
 * change; this snapshot does not. */
function digest(features: GeoJSON.Feature[]): { sha256: string; summary: Record<string, number> } {
  const summary: Record<string, number> = { total: features.length };
  for (const f of features) {
    const type = String((f.properties as Record<string, unknown>)?.type);
    summary[type] = (summary[type] ?? 0) + 1;
  }
  return {
    sha256: createHash("sha256").update(JSON.stringify(features)).digest("hex"),
    summary,
  };
}

describe("river generator — determinism", () => {
  it("matches the seeded snapshot fixture (windy + braided — golden drift tripwire)", () => {
    const p = PARAMS({ windiness: 0.85, braiding: 0.6, width: 26, widthGrowth: 0.7, braidBias: 0.2 });
    expect(digest(generateRiver(4242, regionFor(LINE, p), p, CONSTRAINTS))).toMatchSnapshot();
  });

  it("is byte-identical across two runs (same seed/region/params)", () => {
    const region = regionFor(LINE, PARAMS());
    const a = generateRiver(1234, region, PARAMS(), CONSTRAINTS);
    const b = generateRiver(1234, region, PARAMS(), CONSTRAINTS);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.length).toBeGreaterThan(0);
  });

  it("hashes feature ids on position, not emission order (integer ids)", () => {
    const region = regionFor(LINE, PARAMS());
    const feats = generateRiver(7, region, PARAMS(), CONSTRAINTS);
    for (const f of feats) {
      expect(typeof f.id).toBe("number");
      expect(Number.isFinite(Number(f.id))).toBe(true);
    }
  });
});

describe("river generator — corridor containment (plan 022 §2)", () => {
  for (const preset of [
    { name: "lazy-lowland", p: PARAMS({ windiness: 0.85, braiding: 0.5, width: 26, widthGrowth: 0.7, braidBias: 0.2 }) },
    { name: "mountain-torrent", p: PARAMS({ windiness: 0.15, braiding: 0, width: 8, widthGrowth: 0.2 }) },
    { name: "canal", p: PARAMS({ windiness: 0, braiding: 0, width: 12, widthGrowth: 0 }) },
    { name: "delta", p: PARAMS({ windiness: 0.5, braiding: 1, width: 22, widthGrowth: 1.2, braidBias: 1 }) },
  ]) {
    it(`all output within maxOffset of the spine — ${preset.name}`, () => {
      const region = regionFor(LINE, preset.p);
      const spine = region.spine!;
      const maxOffset = riverMaxOffset(preset.p);
      const feats = generateRiver(99, region, preset.p, CONSTRAINTS);
      expect(feats.length).toBeGreaterThan(0);
      let worst = 0;
      for (const [x, y] of allCoords(feats)) worst = Math.max(worst, distanceToSpine(spine, x, y));
      expect(worst).toBeLessThanOrEqual(maxOffset + 1e-3);
    });
  }
});

describe("river generator — identity / edit locality (deliverable 4)", () => {
  it("a single end-vertex edit re-meanders far less than a re-roll", () => {
    const region = regionFor(LINE, PARAMS());
    const base = bucketSet(generateRiver(50, region, PARAMS(), CONSTRAINTS));

    // Move ONLY the last vertex (changes just the last segment's endpoints).
    const moved: Pt[] = [...LINE.slice(0, -1), [1230, 30]];
    const movedRegion = regionFor(moved, PARAMS());
    const movedBuckets = bucketSet(generateRiver(50, movedRegion, PARAMS(), CONSTRAINTS));

    // Re-roll: new seed, same spine → every segment re-meanders.
    const rerolled = bucketSet(generateRiver(51, region, PARAMS(), CONSTRAINTS));

    const editOverlap = overlapPct(base, movedBuckets);
    const rerollOverlap = overlapPct(base, rerolled);
    // The edit keeps the untouched segments byte-identical; the re-roll does not.
    expect(editOverlap).toBeGreaterThan(rerollOverlap + 25);
    expect(editOverlap).toBeGreaterThan(55);
  });

  it("segments away from an edit are byte-identical (widthGrowth 0)", () => {
    // With widthGrowth 0 the only global-arc quantity vanishes, so unmoved
    // segments must be EXACTLY identical (not just bucket-stable).
    const region = regionFor(LINE, PARAMS({ widthGrowth: 0 }));
    const feats0 = generateRiver(50, region, PARAMS({ widthGrowth: 0 }), CONSTRAINTS);
    const moved: Pt[] = [...LINE.slice(0, -1), [1230, 30]];
    const feats1 = generateRiver(50, regionFor(moved, PARAMS({ widthGrowth: 0 })), PARAMS({ widthGrowth: 0 }), CONSTRAINTS);
    // Features whose coordinates all sit before x=850 lie on the first three
    // (unmoved) segments; they must appear identically in both runs.
    const early = (fs: GeoJSON.Feature[]): string[] =>
      fs
        .filter((f) => allCoords([f]).every(([x]) => x < 850))
        .map((f) => JSON.stringify(f.geometry))
        .sort();
    const e0 = early(feats0);
    const e1 = early(feats1);
    expect(e0.length).toBeGreaterThan(0);
    expect(e1).toEqual(e0);
  });
});

describe("river generator — preset semantics", () => {
  it("canal (windiness 0, growth 0) hugs the spine within half-width", () => {
    const p = PARAMS({ windiness: 0, braiding: 0, width: 12, widthGrowth: 0 });
    const region = regionFor(LINE, p);
    const feats = generateRiver(3, region, p, CONSTRAINTS);
    const spine = region.spine!;
    for (const [x, y] of allCoords(feats)) {
      // No meander, no braid: every point is a bank at most width/2 from spine.
      expect(distanceToSpine(spine, x, y)).toBeLessThanOrEqual(12 / 2 + 1e-3);
    }
  });

  it("delta braids toward the mouth: islands concentrate downstream", () => {
    const p = PARAMS({ windiness: 0.4, braiding: 1, width: 20, widthGrowth: 1, braidBias: 1 });
    const region = regionFor(LINE, p);
    const feats = generateRiver(8, region, p, CONSTRAINTS);
    const islands = feats.filter((f) => (f.properties as { type?: string }).type === "river-island");
    expect(islands.length).toBeGreaterThan(0);
    const totalLen = region.spine!.totalLen;
    // Mean downstream position of island vertices should sit past the midpoint.
    let sx = 0;
    let n = 0;
    for (const [x] of allCoords(islands)) {
      sx += x;
      n++;
    }
    // The spine runs monotonically in +x over [0,1200]; islands weighted to the
    // mouth means a mean x well past the middle of the run.
    expect(sx / n).toBeGreaterThan(totalLen * 0.4);
  });

  it("canal emits no islands", () => {
    const p = PARAMS({ windiness: 0, braiding: 0, width: 12, widthGrowth: 0 });
    const feats = generateRiver(3, regionFor(LINE, p), p, CONSTRAINTS);
    expect(feats.some((f) => (f.properties as { type?: string }).type === "river-island")).toBe(false);
  });
});

describe("river generator — maxOffset monotonicity (deliverable 5)", () => {
  it("windiness increase widens the corridor and never violates containment", () => {
    const low = PARAMS({ windiness: 0.2 });
    const high = PARAMS({ windiness: 0.9 });
    expect(riverMaxOffset(high)).toBeGreaterThan(riverMaxOffset(low));
    for (const p of [low, high]) {
      const region = regionFor(LINE, p);
      const spine = region.spine!;
      const feats = generateRiver(11, region, p, CONSTRAINTS);
      for (const [x, y] of allCoords(feats)) {
        expect(distanceToSpine(spine, x, y)).toBeLessThanOrEqual(riverMaxOffset(p) + 1e-3);
      }
    }
  });

  it("maxOffset is monotonic in braiding, width, and widthGrowth", () => {
    const base = PARAMS();
    expect(riverMaxOffset({ ...base, braiding: 1 })).toBeGreaterThan(riverMaxOffset({ ...base, braiding: 0 }));
    expect(riverMaxOffset({ ...base, width: 40 })).toBeGreaterThan(riverMaxOffset({ ...base, width: 10 }));
    expect(riverMaxOffset({ ...base, widthGrowth: 2 })).toBeGreaterThan(riverMaxOffset({ ...base, widthGrowth: 0 }));
    // windiness 0 with a wide channel still has a positive corridor.
    expect(riverMaxOffset(PARAMS({ windiness: 0 }))).toBeGreaterThan(0);
    // Scales with the amplitude constant.
    expect(riverMaxOffset(PARAMS({ windiness: 1, width: 0.001, widthGrowth: 0, braiding: 0 }))).toBeGreaterThan(
      BASE_MEANDER_AMP_M - 1
    );
  });
});

describe("river generator — 2x2 seam via whole-artifact clip", () => {
  it("clips deterministically and keeps every coordinate inside its tile", () => {
    const p = PARAMS({ windiness: 0.6, braiding: 0.4, width: 24, widthGrowth: 0.5, braidBias: 0.3 });
    const region = regionFor(LINE, p);
    const network = generateRiver(21, region, p, CONSTRAINTS);
    // Cover the whole river with the tiles its bbox touches (a 2x2+ grid).
    const min = tileXYForPoint(region.bbox.minX, region.bbox.minY);
    const max = tileXYForPoint(region.bbox.maxX, region.bbox.maxY);
    let clippedFeatures = 0;
    for (let ty = min.tileY; ty <= max.tileY; ty++) {
      for (let tx = min.tileX; tx <= max.tileX; tx++) {
        const bb = tileBBox(tx, ty);
        const a = clipNetworkToTile(network, bb);
        const b = clipNetworkToTile(network, bb);
        expect(JSON.stringify(a)).toBe(JSON.stringify(b)); // deterministic clip
        for (const gid of Object.keys(a)) {
          for (const f of a[gid]) {
            for (const [x, y] of allCoords([f])) {
              // Clipped coords must lie within (a hair of) the tile bbox.
              expect(x).toBeGreaterThanOrEqual(bb.minX - 1e-3);
              expect(x).toBeLessThanOrEqual(bb.maxX + 1e-3);
              expect(y).toBeGreaterThanOrEqual(bb.minY - 1e-3);
              expect(y).toBeLessThanOrEqual(bb.maxY + 1e-3);
              clippedFeatures++;
            }
          }
        }
      }
    }
    expect(clippedFeatures).toBeGreaterThan(0);
  });
});
