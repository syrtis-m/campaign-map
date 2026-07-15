import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { generateMountain, terrace, type MountainParams } from "./mountain";
import { makeRegion, type ProcgenRegion } from "./region";
import type { GenerationConstraints } from "./types";
import { clipNetworkToTile } from "./citynet";
import { tileBBox, tileXYForPoint } from "./cache/tileGrid";
import { heightAt } from "./world/heightmap";
import { expectGeneratorInvariants, expectDeterministic } from "./testkit/invariants";
import { computeMountainMetrics, mountainBandViolations } from "./mountainMetrics";

type Pt = [number, number];

const CONSTRAINTS: GenerationConstraints = {
  worldBounds: { minX: -1e5, minY: -1e5, maxX: 1e5, maxY: 1e5 },
};

/** A 1200 m square mountain region (large ⇒ many hachures + peaks). */
const SQUARE: Pt[] = [
  [0, 0],
  [1200, 0],
  [1200, 1200],
  [0, 1200],
  [0, 0],
];

// L-shape (concave) for containment stress: a straight hachure tick could
// bridge the notch — the segmentCrossesBoundary check must drop those.
const L_SHAPE: Pt[] = [
  [0, 0],
  [1000, 0],
  [1000, 500],
  [500, 500],
  [500, 1000],
  [0, 1000],
  [0, 0],
];

const PARAMS = (o: Partial<MountainParams> = {}): MountainParams => ({
  terrain: "alpine",
  amplitude: 0.6,
  roughness: 0.5,
  ...o,
});

function regionFor(ring: Pt[]): ProcgenRegion {
  return makeRegion("mtn-test", ring);
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

function typeCount(feats: GeoJSON.Feature[], type: string): number {
  return feats.filter((f) => (f.properties as { generatorId?: string }).generatorId === type).length;
}

/** Peak-position buckets — the locality measure. Peaks are local MAXIMA of the
 * elevation field, so their positions are fully field-determined: a re-roll (new
 * seed → new field) relocates the whole set, while a rim vertex edit leaves the
 * flat-mask interior untouched. (Hachure START coords sit on the fixed world
 * lattice ± tiny jitter, so they're a poor discriminator — the field only picks
 * WHICH nodes emit, not where the node is.) */
function peakBuckets(feats: GeoJSON.Feature[]): Set<string> {
  const s = new Set<string>();
  for (const f of feats) {
    if ((f.properties as { generatorId?: string }).generatorId !== "mountain-peak") continue;
    const [x, y] = (f.geometry as unknown as { coordinates: Pt }).coordinates;
    s.add(`${Math.round(x / 45)},${Math.round(y / 45)}`);
  }
  return s;
}

function overlapPct(a: Set<string>, b: Set<string>): number {
  if (a.size === 0) return 0;
  let hit = 0;
  for (const k of a) if (b.has(k)) hit++;
  return (hit / a.size) * 100;
}

function digest(features: GeoJSON.Feature[]): { sha256: string; summary: Record<string, number> } {
  const summary: Record<string, number> = { total: features.length };
  for (const f of features) {
    const type = String((f.properties as Record<string, unknown>)?.generatorId);
    summary[type] = (summary[type] ?? 0) + 1;
  }
  return { sha256: createHash("sha256").update(JSON.stringify(features)).digest("hex"), summary };
}

describe("mountain generator — determinism", () => {
  it("matches the seeded snapshot fixture (alpine — golden drift tripwire)", () => {
    expect(digest(generateMountain(4242, regionFor(SQUARE), PARAMS(), CONSTRAINTS))).toMatchSnapshot();
  });

  it("is byte-identical across two runs (same seed/region/params)", () => {
    const region = regionFor(SQUARE);
    const a = expectDeterministic(() => generateMountain(1234, region, PARAMS(), CONSTRAINTS));
    expect(a.length).toBeGreaterThan(1); // a mountain always emits many layers, never a lone feature
  });

  it("hashes feature ids on position, not emission order (integer ids)", () => {
    const feats = generateMountain(7, regionFor(SQUARE), PARAMS(), CONSTRAINTS);
    for (const f of feats) {
      expect(typeof f.id).toBe("number");
      expect(Number.isFinite(Number(f.id))).toBe(true);
    }
  });

  it("never reads its constraints (base terrain — output identical with busy fabric)", () => {
    const region = regionFor(SQUARE);
    const bare = generateMountain(7, region, PARAMS(), CONSTRAINTS);
    const busy: GenerationConstraints = {
      worldBounds: CONSTRAINTS.worldBounds,
      fabricFeatures: [
        {
          type: "Feature",
          id: "district-x",
          geometry: { type: "Polygon", coordinates: [[[0, 0], [500, 0], [500, 500], [0, 500], [0, 0]]] },
          properties: { kind: "district" },
        },
      ],
    };
    expect(JSON.stringify(generateMountain(7, region, PARAMS(), busy))).toBe(JSON.stringify(bare));
  });
});

describe("mountain generator — contour retirement is BYTE-STABLE (v2, Jonah 2026-07-15)", () => {
  // Contours were removed from the mountain emit (they are now a global surface
  // off the composed terrain field). The massif/hachure/peak dressing must be
  // byte-IDENTICAL across that retirement — only `mountain-contour` disappears.
  // These hexes are the digest of the non-contour subset captured pre-retirement
  // (they matched HEAD's massif/hachure/peak bytes exactly); with contours gone,
  // the WHOLE feature list now hashes to the same value, so a reshape of the
  // remaining dressing flips them.
  const HEAD_NON_CONTOUR: Record<string, string> = {
    alpine: "274c402514b92524a1ed5862d35c2887104127ac29a2526f13dfb89ce17887db",
    mesa: "51d000f400bac39eeac7f21cb6699ee1411044ec3cff07414cf60b6f037f2d34",
    "rolling-hills": "06ed54d80a4efc3d53b4de4ff8b119bd434c72d346c332b0bd4907bd8488c362",
  };
  function nonContourDigest(feats: GeoJSON.Feature[]): string {
    const sub = feats.filter((f) => (f.properties as { generatorId?: string }).generatorId !== "mountain-contour");
    return createHash("sha256").update(JSON.stringify(sub)).digest("hex");
  }
  for (const terrain of ["alpine", "mesa", "rolling-hills"] as const) {
    it(`massif/hachure/peak bytes unchanged by the retirement — ${terrain}`, () => {
      const feats = generateMountain(4242, regionFor(SQUARE), PARAMS({ terrain }), CONSTRAINTS);
      expect(nonContourDigest(feats)).toBe(HEAD_NON_CONTOUR[terrain]);
    });
    it(`emits NO mountain-contour features — ${terrain}`, () => {
      const feats = generateMountain(4242, regionFor(SQUARE), PARAMS({ terrain }), CONSTRAINTS);
      expect(feats.some((f) => (f.properties as { generatorId?: string }).generatorId === "mountain-contour")).toBe(false);
    });
  }
});

describe("mountain generator — terrain (preset) semantics", () => {
  it("always emits exactly one massif polygon (the sketched ring)", () => {
    for (const terrain of ["alpine", "mesa", "rolling-hills"] as const) {
      const feats = generateMountain(9, regionFor(SQUARE), PARAMS({ terrain }), CONSTRAINTS);
      expect(typeCount(feats, "mountain-massif")).toBe(1);
    }
  });

  it("emits hachures + peaks for every terrain", () => {
    for (const terrain of ["alpine", "mesa", "rolling-hills"] as const) {
      const feats = generateMountain(11, regionFor(SQUARE), PARAMS({ terrain }), CONSTRAINTS);
      expect(typeCount(feats, "mountain-hachure")).toBeGreaterThan(0);
      expect(typeCount(feats, "mountain-peak")).toBeGreaterThan(0);
    }
  });

  it("alpine reads more rugged than rolling-hills (more, denser hachures)", () => {
    const alpine = generateMountain(13, regionFor(SQUARE), PARAMS({ terrain: "alpine" }), CONSTRAINTS);
    const rolling = generateMountain(13, regionFor(SQUARE), PARAMS({ terrain: "rolling-hills" }), CONSTRAINTS);
    expect(typeCount(alpine, "mountain-hachure")).toBeGreaterThan(typeCount(rolling, "mountain-hachure"));
  });

  it("higher amplitude raises peak elevations", () => {
    const low = generateMountain(21, regionFor(SQUARE), PARAMS({ amplitude: 0.15 }), CONSTRAINTS);
    const high = generateMountain(21, regionFor(SQUARE), PARAMS({ amplitude: 0.95 }), CONSTRAINTS);
    const maxElev = (fs: GeoJSON.Feature[]): number =>
      Math.max(
        0,
        ...fs
          .filter((f) => (f.properties as { generatorId?: string }).generatorId === "mountain-peak")
          .map((f) => (f.properties as { elevation?: number }).elevation ?? 0)
      );
    expect(maxElev(high)).toBeGreaterThan(maxElev(low));
  });

  it("carries the terrain onto every emitted feature (theme tint hook)", () => {
    const feats = generateMountain(3, regionFor(SQUARE), PARAMS({ terrain: "mesa" }), CONSTRAINTS);
    expect(feats.length).toBeGreaterThan(0);
    for (const f of feats) expect((f.properties as { terrain?: string }).terrain).toBe("mesa");
  });

  it("peaks carry a numeric elevation + sizeN (theme scale hook)", () => {
    const feats = generateMountain(3, regionFor(SQUARE), PARAMS(), CONSTRAINTS);
    const peaks = feats.filter((f) => (f.properties as { generatorId?: string }).generatorId === "mountain-peak");
    expect(peaks.length).toBeGreaterThan(0);
    for (const p of peaks) {
      expect(typeof (p.properties as { elevation?: number }).elevation).toBe("number");
      const sizeN = (p.properties as { sizeN?: number }).sizeN ?? -1;
      expect(sizeN).toBeGreaterThanOrEqual(0);
      expect(sizeN).toBeLessThanOrEqual(1);
    }
  });
});

describe("mountain — terrace transform (mesa signature is LIVE, not a no-op)", () => {
  it("steps=0 is the identity", () => {
    for (const v of [0, 0.13, 0.5, 0.87, 1]) expect(terrace(v, 0)).toBe(v);
  });

  it("buckets values toward flat plateaus with sharp risers (steps=4)", () => {
    // Within the [0.25,0.5) step the low end is a near-flat plateau (cubic frac),
    // so 0.30/0.35 compress toward the step floor 0.25 — well below their linear
    // values. A no-op terrace would return them unchanged (0.30/0.35).
    expect(terrace(0.3, 4)).toBeLessThan(0.28);
    expect(terrace(0.35, 4)).toBeLessThan(0.30);
    // The plateau floors sit on the step lattice (0, .25, .5, .75).
    expect(terrace(0.25, 4)).toBeCloseTo(0.25, 6);
    expect(terrace(0.5, 4)).toBeCloseTo(0.5, 6);
    // Monotonic non-decreasing.
    let prev = -1;
    for (let v = 0; v <= 1.0001; v += 0.05) {
      const t = terrace(v, 4);
      expect(t).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = t;
    }
  });
});

describe("mountain generator — structural invariants (containment · closed rings · mm lattice)", () => {
  for (const terrain of ["alpine", "mesa", "rolling-hills"] as const) {
    it(`all output inside the ring — ${terrain}`, () => {
      const region = regionFor(SQUARE);
      expectGeneratorInvariants(generateMountain(99, region, PARAMS({ terrain }), CONSTRAINTS), region);
    });
  }

  it("stays inside a strongly concave (L-shaped) region — no tick bridges the notch", () => {
    const region = regionFor(L_SHAPE);
    expectGeneratorInvariants(generateMountain(42, region, PARAMS(), CONSTRAINTS), region);
  });
});

describe("mountain generator — identity / edit locality", () => {
  it("a single vertex edit changes the relief far less than a re-roll", () => {
    const base = peakBuckets(generateMountain(50, regionFor(SQUARE), PARAMS(), CONSTRAINTS));
    // Move ONE corner outward — only boundary peaks near it change; every
    // interior peak is byte-identical (absolute-world lattice, mask≡1 inside).
    const moved: Pt[] = [
      [0, 0],
      [1320, 0],
      [1200, 1200],
      [0, 1200],
      [0, 0],
    ];
    const movedBuckets = peakBuckets(generateMountain(50, regionFor(moved), PARAMS(), CONSTRAINTS));
    // Re-roll: a new seed regenerates the whole elevation field.
    const rerolled = peakBuckets(generateMountain(51, regionFor(SQUARE), PARAMS(), CONSTRAINTS));
    const editOverlap = overlapPct(base, movedBuckets);
    const rerollOverlap = overlapPct(base, rerolled);
    expect(base.size).toBeGreaterThan(3); // enough peaks for a meaningful ratio
    expect(editOverlap).toBeGreaterThan(rerollOverlap + 25);
    expect(editOverlap).toBeGreaterThan(80);
  });
});

describe("mountain generator — 2x2 seam via whole-artifact clip", () => {
  it("clips deterministically and keeps every coordinate inside its tile", () => {
    const region = regionFor(SQUARE);
    const network = generateMountain(21, region, PARAMS(), CONSTRAINTS);
    const min = tileXYForPoint(region.bbox.minX, region.bbox.minY);
    const max = tileXYForPoint(region.bbox.maxX, region.bbox.maxY);
    let clipped = 0;
    let hachureTiles = 0; // hachures span multiple tiles — the seam clip poster child now
    for (let ty = min.tileY; ty <= max.tileY; ty++) {
      for (let tx = min.tileX; tx <= max.tileX; tx++) {
        const bb = tileBBox(tx, ty);
        const a = clipNetworkToTile(network, bb);
        const b = clipNetworkToTile(network, bb);
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
        if (a["mountain-hachure"]?.length) hachureTiles++;
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
    // Hachures span multiple tiles; clipping the network into each tile is the
    // seam story (adjacent tiles cut the same bytes → they agree on edges).
    expect(hachureTiles).toBeGreaterThan(1);
  });
});

describe("plan 023 §3 compatibility — world-tier heightAt is UNTOUCHED", () => {
  // The new elevation field is a NEW function consumed only by NEW features
  // (the mountain generator); world-tier regions/biomes keep the old cubic
  // heightAt until a deliberate, flagged migration. This snapshot is the
  // tripwire: any reshape of heightAt's guts (which would silently re-roll every
  // existing campaign's world tier) flips it.
  it("heightAt produces its committed values for fixed samples (bit-exact guard)", () => {
    const bounds = { minX: -5000, minY: -5000, maxX: 5000, maxY: 5000 };
    const samples = ([[0, 0], [1234.5, -678.9], [-3200, 2100], [4800, 4800]] as Pt[]).map(([x, y]) =>
      heightAt(987654, x, y, bounds)
    );
    expect(samples).toMatchSnapshot();
  });
});

describe("mountain generator — metric bands (regression net)", () => {
  // The band is the tunable safety net that replaces byte-eternity for tuning:
  // it survives a terrain retune but catches hachures that thin out. Measured on
  // the committed golden (alpine, seed 4242).
  it("golden fixture (alpine) lands inside its metric band", () => {
    const region = regionFor(SQUARE);
    const v = mountainBandViolations(computeMountainMetrics(generateMountain(4242, region, PARAMS(), CONSTRAINTS), region));
    expect(v, v.join("; ")).toEqual([]);
  });

  it("a rugged high-amplitude alpine massif shades denser than low rolling hills (same region/seed)", () => {
    const region = regionFor(SQUARE);
    const alpine = computeMountainMetrics(generateMountain(3, region, PARAMS({ terrain: "alpine", amplitude: 0.9 }), CONSTRAINTS), region);
    const rolling = computeMountainMetrics(generateMountain(3, region, PARAMS({ terrain: "rolling-hills", amplitude: 0.3 }), CONSTRAINTS), region);
    expect(alpine.hachureDensityPerKm2).toBeGreaterThan(rolling.hachureDensityPerKm2);
  });
});
