import { describe, it, expect } from "vitest";
import { generateFarmland, type FarmlandParams } from "./farmland";
import { makeRegion, distanceToBoundary } from "./region";
import { mulberry32 } from "./rng";
import type { GenerationConstraints } from "./types";

type Pt = [number, number];

const CONSTRAINTS: GenerationConstraints = {
  worldBounds: { minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 },
};

const PRESETS: FarmlandParams[] = [
  { fieldType: "open-field-strips", fieldSize: 0.55, hedging: "none", laneDensity: 0.66, farmsteads: 0.3 },
  { fieldType: "enclosed-patchwork", fieldSize: 0.5, hedging: "hedgerows", laneDensity: 0.4, farmsteads: 0.45 },
  { fieldType: "grid-quarters", fieldSize: 0.7, hedging: "fences", laneDensity: 0.66, farmsteads: 0.35 },
  { fieldType: "orchard", fieldSize: 0.4, hedging: "hedgerows", laneDensity: 0.5, farmsteads: 0.3 },
];

/** A seeded random simple polygon: a jittered N-gon around a center, radius
 * `min`–`max` m (never self-intersecting; concavity via the radius jitter). */
function randomRing(seed: number, min: number, max: number): Pt[] {
  const rng = mulberry32(seed);
  const n = 4 + Math.floor(rng() * 6);
  const cx = (rng() - 0.5) * 300;
  const cy = (rng() - 0.5) * 300;
  const baseR = min + rng() * (max - min);
  const ring: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = baseR * (0.7 + rng() * 0.6);
    ring.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  ring.push(ring[0]);
  return ring;
}

/** A deliberately concave L-shape at a given scale (containment stress). */
function lShape(side: number): Pt[] {
  const h = side / 2;
  return [
    [0, 0],
    [side, 0],
    [side, h],
    [h, h],
    [h, side],
    [0, side],
    [0, 0],
  ];
}

function assertContained(feats: GeoJSON.Feature[], region: ReturnType<typeof makeRegion>): void {
  for (const f of feats) {
    const scan = (c: unknown): void => {
      if (!Array.isArray(c)) return;
      if (typeof c[0] === "number" && typeof c[1] === "number") {
        expect(distanceToBoundary(region, c[0] as number, c[1] as number)).toBeGreaterThanOrEqual(-1.01);
        return;
      }
      for (const x of c) scan(x);
    };
    scan((f.geometry as { coordinates: unknown }).coordinates);
  }
}

describe("farmland generator — fuzz (seeded random polygons × 4 presets × region sizes)", () => {
  it("never throws and always stays inside the ring (incl. tiny + concave regions)", () => {
    let generated = 0;
    // A range of region sizes, including tiny ones that legitimately yield
    // nothing (no cell fits inside) — assert the AGGREGATE is non-empty, never
    // per-region (a tiny farmland patch is a valid degenerate result).
    const sizeBands: [number, number][] = [
      [20, 60],
      [60, 140],
      [140, 320],
      [320, 600],
    ];
    for (let s = 0; s < 60; s++) {
      for (const [lo, hi] of sizeBands) {
        const ring = randomRing(s + 1 + lo, lo, hi);
        const region = makeRegion("fuzz", ring);
        for (let pi = 0; pi < PRESETS.length; pi++) {
          const params = PRESETS[pi];
          let feats: GeoJSON.Feature[] = [];
          expect(() => {
            feats = generateFarmland(hashLike(s, pi + lo), region, params, CONSTRAINTS);
          }).not.toThrow();
          assertContained(feats, region);
          generated += feats.length;
        }
      }
    }
    expect(generated).toBeGreaterThan(0);
  });

  it("degrades gracefully on strongly concave L-shapes (no throw, no notch bridge)", () => {
    for (let s = 0; s < 30; s++) {
      const side = 120 + (s % 6) * 90;
      const region = makeRegion("fuzz-L", lShape(side));
      for (const params of PRESETS) {
        let feats: GeoJSON.Feature[] = [];
        expect(() => {
          feats = generateFarmland(s + 3, region, params, CONSTRAINTS);
        }).not.toThrow();
        assertContained(feats, region);
      }
    }
  });

  it("is deterministic on random polygons (double-run byte-identical)", () => {
    for (let s = 0; s < 60; s++) {
      const region = makeRegion("fuzz", randomRing(s + 500, 120, 500));
      const params = PRESETS[s % PRESETS.length];
      const a = generateFarmland(s + 7, region, params, CONSTRAINTS);
      const b = generateFarmland(s + 7, region, params, CONSTRAINTS);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  });
});

function hashLike(a: number, b: number): number {
  return ((a * 2654435761) ^ (b * 40503)) >>> 0;
}
