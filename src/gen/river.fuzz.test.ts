import { describe, it, expect } from "vitest";
import { generateRiver, riverMaxOffset, type RiverParams } from "./river";
import { makeSpine, makeCorridorRegion, distanceToSpine } from "./region";
import { mulberry32 } from "./rng";
import type { GenerationConstraints } from "./types";

type Pt = [number, number];

const CONSTRAINTS: GenerationConstraints = {
  worldBounds: { minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 },
};

const PRESETS: RiverParams[] = [
  { windiness: 0.85, braiding: 0.5, width: 26, widthGrowth: 0.7, braidBias: 0.2 }, // lazy-lowland
  { windiness: 0.15, braiding: 0, width: 8, widthGrowth: 0.2, braidBias: 0 }, // mountain-torrent
  { windiness: 0, braiding: 0, width: 12, widthGrowth: 0, braidBias: 0 }, // canal
  { windiness: 0.5, braiding: 1, width: 22, widthGrowth: 1.2, braidBias: 1 }, // delta
];

/** A seeded random polyline: 2–8 vertices, each step 40–400 m in a wandering
 * direction (never zero-length; can double back and self-cross). */
function randomLine(seed: number): Pt[] {
  const rng = mulberry32(seed);
  const n = 2 + Math.floor(rng() * 7);
  const pts: Pt[] = [[0, 0]];
  let angle = rng() * Math.PI * 2;
  for (let i = 1; i < n; i++) {
    angle += (rng() - 0.5) * 2.2;
    const step = 40 + rng() * 360;
    const [px, py] = pts[i - 1];
    pts.push([px + Math.cos(angle) * step, py + Math.sin(angle) * step]);
  }
  return pts;
}

describe("river generator — fuzz (seeded random polylines × 4 presets)", () => {
  it("never throws and always stays inside the corridor", () => {
    let generated = 0;
    for (let s = 0; s < 300; s++) {
      const line = randomLine(s + 1);
      for (let pi = 0; pi < PRESETS.length; pi++) {
        const params = PRESETS[pi];
        const region = makeCorridorRegion("fuzz", makeSpine("fuzz", line), riverMaxOffset(params));
        const spine = region.spine!;
        if (spine.totalLen < 1) continue; // degenerate line — skip
        const maxOffset = riverMaxOffset(params);
        let feats: GeoJSON.Feature[] = [];
        expect(() => {
          feats = generateRiver(hashLike(s, pi), region, params, CONSTRAINTS);
        }).not.toThrow();
        for (const f of feats) {
          const scan = (c: unknown): void => {
            if (!Array.isArray(c)) return;
            if (typeof c[0] === "number" && typeof c[1] === "number") {
              const d = distanceToSpine(spine, c[0] as number, c[1] as number);
              expect(d).toBeLessThanOrEqual(maxOffset + 1e-2);
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

  it("is deterministic on random polylines (double-run byte-identical)", () => {
    for (let s = 0; s < 60; s++) {
      const line = randomLine(s + 500);
      const params = PRESETS[s % PRESETS.length];
      const region = makeCorridorRegion("fuzz", makeSpine("fuzz", line), riverMaxOffset(params));
      const a = generateRiver(s + 7, region, params, CONSTRAINTS);
      const b = generateRiver(s + 7, region, params, CONSTRAINTS);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  });
});

function hashLike(a: number, b: number): number {
  return ((a * 2654435761) ^ (b * 40503)) >>> 0;
}
