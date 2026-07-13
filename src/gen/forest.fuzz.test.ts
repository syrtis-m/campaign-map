import { describe, it, expect } from "vitest";
import { generateForest, type ForestParams } from "./forest";
import { makeRegion, distanceToBoundary } from "./region";
import { mulberry32 } from "./rng";
import type { GenerationConstraints } from "./types";

type Pt = [number, number];

const CONSTRAINTS: GenerationConstraints = {
  worldBounds: { minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 },
};

const PRESETS: ForestParams[] = [
  { variety: "broadleaf", density: 0.7, clearings: 0.12, edgeRaggedness: 0.45 },
  { variety: "conifer", density: 0.8, clearings: 0.08, edgeRaggedness: 0.3 },
  { variety: "mixed", density: 0.6, clearings: 0.18, edgeRaggedness: 0.5 },
  { variety: "swamp", density: 0.5, clearings: 0.3, edgeRaggedness: 0.65 },
  { variety: "dead-wood", density: 0.35, clearings: 0.35, edgeRaggedness: 0.7 },
];

/** A seeded random simple convex-ish polygon: a jittered N-gon around a center,
 * radius 150–500 m (never degenerate). */
function randomRing(seed: number): Pt[] {
  const rng = mulberry32(seed);
  const n = 4 + Math.floor(rng() * 6);
  const cx = (rng() - 0.5) * 400;
  const cy = (rng() - 0.5) * 400;
  const baseR = 150 + rng() * 350;
  const ring: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = baseR * (0.7 + rng() * 0.6);
    ring.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  ring.push(ring[0]);
  return ring;
}

describe("forest generator — fuzz (seeded random polygons × 5 presets)", () => {
  it("never throws and always stays inside the ring", () => {
    let generated = 0;
    for (let s = 0; s < 200; s++) {
      const ring = randomRing(s + 1);
      const region = makeRegion("fuzz", ring);
      for (let pi = 0; pi < PRESETS.length; pi++) {
        const params = PRESETS[pi];
        let feats: GeoJSON.Feature[] = [];
        expect(() => {
          feats = generateForest(hashLike(s, pi), region, params, CONSTRAINTS);
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
    expect(generated).toBeGreaterThan(0);
  });

  it("is deterministic on random polygons (double-run byte-identical)", () => {
    for (let s = 0; s < 60; s++) {
      const region = makeRegion("fuzz", randomRing(s + 500));
      const params = PRESETS[s % PRESETS.length];
      const a = generateForest(s + 7, region, params, CONSTRAINTS);
      const b = generateForest(s + 7, region, params, CONSTRAINTS);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  });
});

function hashLike(a: number, b: number): number {
  return ((a * 2654435761) ^ (b * 40503)) >>> 0;
}
