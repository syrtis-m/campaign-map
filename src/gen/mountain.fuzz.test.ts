import { describe, it, expect } from "vitest";
import { generateMountain, type MountainParams } from "./mountain";
import { makeRegion, distanceToBoundary } from "./region";
import { mulberry32 } from "./rng";
import type { GenerationConstraints } from "./types";

type Pt = [number, number];

const CONSTRAINTS: GenerationConstraints = {
  worldBounds: { minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 },
};

const PRESETS: MountainParams[] = [
  { terrain: "alpine", amplitude: 0.85, roughness: 0.6 },
  { terrain: "mesa", amplitude: 0.55, roughness: 0.4 },
  { terrain: "rolling-hills", amplitude: 0.3, roughness: 0.35 },
];

/** A seeded random simple polygon: a jittered N-gon (concavity via radius
 * jitter, never self-intersecting). */
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

/** A deliberately concave L-shape at a given scale (containment stress: a
 * straight hachure tick could bridge the notch). */
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

describe("mountain generator — fuzz (seeded random polygons × 3 terrains × region sizes)", () => {
  it("never throws and always stays inside the ring (incl. tiny + concave regions)", () => {
    let generated = 0;
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
          let feats: GeoJSON.Feature[] = [];
          expect(() => {
            feats = generateMountain(hashLike(s, pi + lo), region, PRESETS[pi], CONSTRAINTS);
          }).not.toThrow();
          assertContained(feats, region);
          // The massif is always emitted, so every region yields ≥1 feature.
          expect(feats.length).toBeGreaterThanOrEqual(1);
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
          feats = generateMountain(s + 3, region, params, CONSTRAINTS);
        }).not.toThrow();
        assertContained(feats, region);
      }
    }
  });

  it("is deterministic on random polygons across ALL size bands (double-run byte-identical)", () => {
    // Determinism is size-independent, but the DoD enumerates tiny/degenerate
    // regions explicitly (contours on a sub-lattice region must still be
    // byte-stable), so span the small bands here too.
    const bands: [number, number][] = [
      [20, 60],
      [60, 140],
      [120, 500],
    ];
    for (let s = 0; s < 60; s++) {
      for (const [lo, hi] of bands) {
        const region = makeRegion("fuzz", randomRing(s + 500 + lo, lo, hi));
        const params = PRESETS[s % PRESETS.length];
        const a = generateMountain(s + 7, region, params, CONSTRAINTS);
        const b = generateMountain(s + 7, region, params, CONSTRAINTS);
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      }
    }
  });
});

function hashLike(a: number, b: number): number {
  return ((a * 2654435761) ^ (b * 40503)) >>> 0;
}
