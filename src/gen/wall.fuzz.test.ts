import { describe, it, expect } from "vitest";
import { generateWall, wallMaxOffset, type WallParams } from "./wall";
import { makeSpine, makeCorridorRegion, distanceToBoundary } from "./region";
import { mulberry32 } from "./rng";
import type { GenerationConstraints } from "./types";

type Pt = [number, number];

const CONSTRAINTS: GenerationConstraints = {
  worldBounds: { minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 },
};

const PRESETS: WallParams[] = [
  { style: "curtain-wall", towerSpacing: 60, moat: false, gatehouseScale: 1 },
  { style: "palisade", towerSpacing: 60, moat: false, gatehouseScale: 0.8 },
  { style: "bastioned", towerSpacing: 90, moat: true, gatehouseScale: 1.4 },
];

/** A seeded random polyline of `n` points — including degenerate spines: very
 * short, near-duplicate vertices, sharp reversals (self-crossing) and closed
 * loops (first ≈ last). */
function randomLine(seed: number, kind: "tiny" | "short" | "crossing" | "loop" | "normal"): Pt[] {
  const rng = mulberry32(seed);
  const cx = (rng() - 0.5) * 500;
  const cy = (rng() - 0.5) * 500;
  if (kind === "tiny") return [[cx, cy], [cx + rng() * 3, cy + rng() * 3]]; // sub-min-length
  if (kind === "short") return [[cx, cy], [cx + 25 + rng() * 30, cy + rng() * 10]];
  if (kind === "crossing") {
    // A sharp back-and-forth that self-crosses.
    return [[cx, cy], [cx + 200, cy + 10], [cx + 20, cy + 12], [cx + 220, cy - 8]];
  }
  if (kind === "loop") {
    const r = 120 + rng() * 120;
    const pts: Pt[] = [];
    const n = 6 + Math.floor(rng() * 5);
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
    return pts; // first ≈ last (closed loop)
  }
  // normal: gently kinked, several segments
  const n = 3 + Math.floor(rng() * 6);
  const pts: Pt[] = [[cx, cy]];
  let x = cx;
  let y = cy;
  for (let i = 0; i < n; i++) {
    x += 150 + rng() * 250;
    y += (rng() - 0.5) * 160;
    pts.push([x, y]);
  }
  return pts;
}

describe("wall generator — fuzz (degenerate spines × 3 presets)", () => {
  it("never throws and always stays inside the corridor", () => {
    const kinds = ["tiny", "short", "crossing", "loop", "normal"] as const;
    let generated = 0;
    for (let s = 0; s < 60; s++) {
      for (const kind of kinds) {
        const line = randomLine(s + 1, kind);
        for (let pi = 0; pi < PRESETS.length; pi++) {
          const params = PRESETS[pi];
          const region = makeCorridorRegion("fuzz", makeSpine("fuzz", line), wallMaxOffset(params));
          let feats: GeoJSON.Feature[] = [];
          expect(() => {
            feats = generateWall((s * 7 + pi) >>> 0, region, params, CONSTRAINTS);
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

  it("is deterministic on random spines (double-run byte-identical)", () => {
    for (let s = 0; s < 60; s++) {
      const line = randomLine(s + 500, "normal");
      const params = PRESETS[s % PRESETS.length];
      const region = makeCorridorRegion("fuzz", makeSpine("fuzz", line), wallMaxOffset(params));
      const a = generateWall(s + 7, region, params, CONSTRAINTS);
      const b = generateWall(s + 7, region, params, CONSTRAINTS);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  });
});
