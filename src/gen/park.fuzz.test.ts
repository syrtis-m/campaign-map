import { describe, it, expect } from "vitest";
import { generatePark, type ParkParams } from "./park";
import { makeRegion, distanceToBoundary } from "./region";
import { mulberry32 } from "./rng";
import type { GenerationConstraints } from "./types";

type Pt = [number, number];

const CONSTRAINTS: GenerationConstraints = {
  worldBounds: { minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 },
};

const PRESETS: ParkParams[] = [
  { variety: "formal-garden", pathDensity: 0.6, pond: false },
  { variety: "city-park", pathDensity: 0.5, pond: true },
  { variety: "wild-common", pathDensity: 0.3, pond: false },
  { variety: "japanese-garden", pathDensity: 0.4, pond: true },
];

function typeCount(feats: GeoJSON.Feature[], type: string): number {
  return feats.filter((f) => (f.properties as { generatorId?: string }).generatorId === type).length;
}

/** A seeded random simple convex-ish polygon: a jittered N-gon around a center,
 * radius `min`–`max` m (never degenerate). */
function randomRing(seed: number, min: number, max: number): Pt[] {
  const rng = mulberry32(seed);
  const n = 4 + Math.floor(rng() * 6);
  const cx = (rng() - 0.5) * 300;
  const cy = (rng() - 0.5) * 300;
  const baseR = min + rng() * (max - min);
  const ring: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = baseR * (0.75 + rng() * 0.5);
    ring.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  ring.push(ring[0]);
  return ring;
}

describe("park generator — fuzz (seeded random polygons × 4 presets × region sizes)", () => {
  it("never throws and always stays inside the ring", () => {
    let generated = 0;
    // A range of region sizes, including small ones that force the japanese
    // graceful-degradation ladder (court → island → pond-only).
    const sizeBands: [number, number][] = [
      [40, 90],
      [90, 170],
      [170, 350],
      [350, 600],
    ];
    for (let s = 0; s < 60; s++) {
      for (const [lo, hi] of sizeBands) {
        const ring = randomRing(s + 1 + lo, lo, hi);
        const region = makeRegion("fuzz", ring);
        for (let pi = 0; pi < PRESETS.length; pi++) {
          const params = PRESETS[pi];
          let feats: GeoJSON.Feature[] = [];
          expect(() => {
            feats = generatePark(hashLike(s, pi + lo), region, params, CONSTRAINTS);
          }).not.toThrow();
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
            generated++;
          }
        }
      }
    }
    expect(generated).toBeGreaterThan(0);
  });

  it("japanese-garden degrades gracefully: island/court only appear on large regions", () => {
    const jp: ParkParams = { variety: "japanese-garden", pathDensity: 0.4, pond: true };
    // Tiny regions (maxInteriorDistance well under the island/court thresholds)
    // must never emit an island or a court — and must not throw.
    for (let s = 0; s < 40; s++) {
      const region = makeRegion("fuzz-small", randomRing(s + 7, 30, 70));
      const feats = generatePark(s + 11, region, jp, CONSTRAINTS);
      expect(typeCount(feats, "park-island")).toBe(0);
      expect(typeCount(feats, "park-court")).toBe(0);
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
  });

  it("is deterministic on random polygons (double-run byte-identical)", () => {
    for (let s = 0; s < 60; s++) {
      const region = makeRegion("fuzz", randomRing(s + 500, 120, 500));
      const params = PRESETS[s % PRESETS.length];
      const a = generatePark(s + 7, region, params, CONSTRAINTS);
      const b = generatePark(s + 7, region, params, CONSTRAINTS);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  });
});

function hashLike(a: number, b: number): number {
  return ((a * 2654435761) ^ (b * 40503)) >>> 0;
}
