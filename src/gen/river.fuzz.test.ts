import { describe, it, expect } from "vitest";
import { generateRiver, riverMaxOffset, RC_MIN_WIDTHS, type RiverParams } from "./river";
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

  it("slope-coupled to a random MOUNTAIN sketch: never throws, contained, byte-deterministic", () => {
    // Random spines crossing random mountains at full sensitivity — the
    // coupling only SHRINKS amplitude / stretches wavelength, so the corridor
    // bound must keep holding, and the coupled output must be a pure function
    // of (seed, spine, params, mountain sketch).
    const rng = mulberry32(24601);
    for (let s = 0; s < 60; s++) {
      const line = randomLine(s + 700);
      const params = PRESETS[s % PRESETS.length];
      const region = makeCorridorRegion("fuzz-s", makeSpine("fuzz-s", line), riverMaxOffset(params));
      const spine = region.spine!;
      if (spine.totalLen < 1) continue;
      const cx = (rng() - 0.5) * 800;
      const cy = (rng() - 0.5) * 800;
      const r = 200 + rng() * 600;
      const mring: Pt[] = [
        [cx - r, cy - r],
        [cx + r, cy - r],
        [cx + r, cy + r],
        [cx - r, cy + r],
        [cx - r, cy - r],
      ];
      const constraints = {
        worldBounds: CONSTRAINTS.worldBounds,
        fabricFeatures: [
          {
            type: "Feature",
            id: `m-${s}`,
            geometry: { type: "Polygon", coordinates: [mring] },
            properties: {
              kind: "mountain",
              procgen: {
                algorithm: "mountain",
                seed: s * 17 + 3,
                version: 1,
                params: { terrain: (["alpine", "mesa", "rolling-hills"] as const)[s % 3], amplitude: 0.3 + (s % 5) * 0.15, roughness: 0.5 },
              },
            },
          },
        ],
      } as GenerationConstraints;
      const maxOffset = riverMaxOffset(params);
      let a: GeoJSON.Feature[] = [];
      expect(() => {
        a = generateRiver(hashLike(s, 23), region, params, constraints);
      }).not.toThrow();
      for (const f of a) {
        const scan = (c: unknown): void => {
          if (!Array.isArray(c)) return;
          if (typeof c[0] === "number" && typeof c[1] === "number") {
            expect(distanceToSpine(spine, c[0] as number, c[1] as number)).toBeLessThanOrEqual(maxOffset + 1e-2);
            return;
          }
          for (const x of c) scan(x);
        };
        scan((f.geometry as { coordinates: unknown }).coordinates);
      }
      const b = generateRiver(hashLike(s, 23), region, params, constraints);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  });
});

// ─── extreme-params grid — containment under the R_c-clamped meander, no
// self-intersection, curvature floor ─────────────────────────────────────────

/** Proper segment intersection (strict — shared endpoints don't count). */
function properIntersect(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const x = (p: Pt, q: Pt, r: Pt): number => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = x(c, d, a);
  const d2 = x(c, d, b);
  const d3 = x(a, b, c);
  const d4 = x(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Whether a closed ring self-intersects (non-adjacent edge pairs only). */
function ringSelfIntersects(ring: Pt[]): boolean {
  const n = ring.length - 1; // closed: last === first
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // adjacent around the closure
      if (properIntersect(ring[i], ring[i + 1], ring[j], ring[j + 1])) return true;
    }
  }
  return false;
}

describe("river generator — extreme-params fuzz (R_c clamp as containment)", () => {
  it("extreme windiness×braiding×width×growth grid: never throws, always contained", () => {
    // The schema's corners (windiness/braiding 1, width up to 120, growth up
    // to the zod max 4) exercise the new amplitude caps at their harshest.
    const grid: RiverParams[] = [];
    for (const width of [8, 120]) {
      for (const widthGrowth of [0, 4]) {
        grid.push({ windiness: 1, braiding: 1, width, widthGrowth, braidBias: 1 });
        grid.push({ windiness: 1, braiding: 0, width, widthGrowth, braidBias: 0 });
      }
    }
    let generated = 0;
    for (let s = 0; s < 40; s++) {
      const line = randomLine(s + 900);
      for (const params of grid) {
        const region = makeCorridorRegion("fuzz-x", makeSpine("fuzz-x", line), riverMaxOffset(params));
        const spine = region.spine!;
        if (spine.totalLen < 1) continue;
        const maxOffset = riverMaxOffset(params);
        let feats: GeoJSON.Feature[] = [];
        expect(() => {
          feats = generateRiver(hashLike(s, params.width + params.widthGrowth), region, params, CONSTRAINTS);
        }).not.toThrow();
        for (const f of feats) {
          const scan = (c: unknown): void => {
            if (!Array.isArray(c)) return;
            if (typeof c[0] === "number" && typeof c[1] === "number") {
              expect(distanceToSpine(spine, c[0] as number, c[1] as number)).toBeLessThanOrEqual(maxOffset + 1e-2);
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

  it("single-segment extremes: channel rings stay simple and the R_c ≥ 2W floor holds", () => {
    // Single straight segments isolate the meander math from fillet-corner
    // interactions: random direction + length ×
    // the windiness-1 grid. Rings must be simple polygons (the R_c clamp is
    // the bank self-intersection guard), and on long segments (envelope
    // negligible) the measured curvature radius must respect the floor.
    for (let s = 0; s < 15; s++) {
      const rng = mulberry32(s + 4000);
      const angle = rng() * Math.PI * 2;
      const len = 150 + rng() * 1200;
      const line: Pt[] = [
        [0, 0],
        [Math.cos(angle) * len, Math.sin(angle) * len],
      ];
      for (const params of [
        { windiness: 1, braiding: 0, width: 8, widthGrowth: 0, braidBias: 0 },
        { windiness: 1, braiding: 0, width: 8, widthGrowth: 1.2, braidBias: 0 },
        { windiness: 1, braiding: 0, width: 30, widthGrowth: 0, braidBias: 0 },
        { windiness: 0.7, braiding: 0, width: 30, widthGrowth: 1.2, braidBias: 0 },
      ] satisfies RiverParams[]) {
        const region = makeCorridorRegion("fuzz-1seg", makeSpine("fuzz-1seg", line), riverMaxOffset(params));
        const feats = generateRiver(hashLike(s, params.width), region, params, CONSTRAINTS);
        const channels = feats.filter((f) => (f.properties as { type?: string }).type === "river-channel");
        expect(channels.length).toBe(1);
        const ring = (channels[0].geometry as GeoJSON.Polygon).coordinates[0] as Pt[];
        expect(ringSelfIntersects(ring)).toBe(false);
        // Curvature floor, measured on the bank-midpoint centerline; only on
        // segments long enough that the sin²(πt) envelope's own curvature is
        // negligible next to the bend curvature.
        if (len >= 25 * params.width) {
          const banks = feats.filter((f) => (f.properties as { type?: string }).type === "river-bank");
          const L = (banks[0].geometry as GeoJSON.LineString).coordinates as Pt[];
          const R = (banks[1].geometry as GeoJSON.LineString).coordinates as Pt[];
          let minR = Infinity;
          for (let i = 1; i + 1 < L.length; i++) {
            const c = (k: number): Pt => [(L[k][0] + R[k][0]) / 2, (L[k][1] + R[k][1]) / 2];
            const [a, b, cc] = [c(i - 1), c(i), c(i + 1)];
            const dd = (u: Pt, v: Pt): number => Math.hypot(u[0] - v[0], u[1] - v[1]);
            const area2 = Math.abs((b[0] - a[0]) * (cc[1] - a[1]) - (cc[0] - a[0]) * (b[1] - a[1]));
            if (area2 > 1e-12) minR = Math.min(minR, (dd(a, b) * dd(b, cc) * dd(cc, a)) / (2 * area2));
          }
          expect(minR).toBeGreaterThanOrEqual(RC_MIN_WIDTHS * params.width * 0.8);
        }
      }
    }
  });
});

function hashLike(a: number, b: number): number {
  return ((a * 2654435761) ^ (b * 40503)) >>> 0;
}

// ─── junction / delta / estuary fuzz ─────────────────────────────────────────
// Random spines meeting random partner rivers and random water polygons at
// their mouths, at delta braidBias — the confluence/delta/estuary code paths
// on degenerate configurations. The additive containment guard must keep every
// appended vertex inside the corridor, and the whole thing must be a pure
// function of (seed, spine, params, sketch layer).

type FF = NonNullable<GenerationConstraints["fabricFeatures"]>[number];

const byT = (fs: GeoJSON.Feature[], t: string): number => fs.filter((f) => (f.properties as { type?: string }).type === t).length;

describe("river generator — junction/mouth/dressing fuzz", () => {
  it("random confluences + deltas + estuaries: never throws, always contained, deterministic", () => {
    const rng = mulberry32(90210);
    let sawConfluence = 0;
    let sawDelta = 0;
    let sawEstuary = 0;
    for (let s = 0; s < 120; s++) {
      const line = randomLine(s + 1300);
      // Delta braidBias so the mouth path is exercised; vary the other knobs.
      const params: RiverParams = {
        windiness: rng(),
        braiding: rng(),
        width: 6 + rng() * 40,
        widthGrowth: rng() * 3,
        braidBias: rng() < 0.5 ? 1 : rng(), // half the runs are delta-strength
      };
      const region = makeCorridorRegion("fz", makeSpine("fz", line), riverMaxOffset(params));
      const spine = region.spine!;
      if (spine.totalLen < 1) continue;
      const M = spine.points[spine.points.length - 1];
      const feats: FF[] = [];
      const mode = s % 3;
      if (mode === 0 || mode === 2) {
        // A partner river ending exactly at the mouth (confluence).
        feats.push({
          type: "Feature",
          id: `p-${s}`,
          geometry: { type: "LineString", coordinates: [[M[0], M[1]], [M[0] + 200, M[1] + 150]] },
          properties: { kind: "river", procgen: { algorithm: "river", seed: s, version: 1, params: { width: 5 + rng() * 30 } } },
        } as FF);
      }
      if (mode === 1) {
        // A water polygon straddling the mouth (estuary signal).
        const r = 100 + rng() * 300;
        feats.push({
          type: "Feature",
          id: `w-${s}`,
          geometry: { type: "Polygon", coordinates: [[[M[0] - r, M[1] - r], [M[0] + r, M[1] - r], [M[0] + r, M[1] + r], [M[0] - r, M[1] + r], [M[0] - r, M[1] - r]]] },
          properties: { kind: "water" },
        } as FF);
      }
      const constraints = { worldBounds: CONSTRAINTS.worldBounds, fabricFeatures: feats } as GenerationConstraints;
      const maxOffset = riverMaxOffset(params);
      let a: GeoJSON.Feature[] = [];
      expect(() => {
        a = generateRiver(hashLike(s, 28), region, params, constraints);
      }).not.toThrow();
      for (const f of a) {
        const scan = (c: unknown): void => {
          if (!Array.isArray(c)) return;
          if (typeof c[0] === "number" && typeof c[1] === "number") {
            expect(distanceToSpine(spine, c[0] as number, c[1] as number)).toBeLessThanOrEqual(maxOffset + 1e-2);
            return;
          }
          for (const x of c) scan(x);
        };
        scan((f.geometry as { coordinates: unknown }).coordinates);
      }
      const b = generateRiver(hashLike(s, 28), region, params, constraints);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      sawConfluence += byT(a, "river-confluence") > 0 ? 1 : 0;
      sawDelta += byT(a, "river-distributary") > 0 ? 1 : 0;
      sawEstuary += byT(a, "river-estuary") > 0 ? 1 : 0;
    }
    // The fuzz actually exercised each mouth path (not vacuously green).
    expect(sawConfluence).toBeGreaterThan(0);
    expect(sawDelta).toBeGreaterThan(0);
    expect(sawEstuary).toBeGreaterThan(0);
  });

  it("degenerate: a partner river coincident with the whole spine still never throws or spills", () => {
    for (let s = 0; s < 40; s++) {
      const line = randomLine(s + 1700);
      const params = PRESETS[s % PRESETS.length];
      const region = makeCorridorRegion("fzd", makeSpine("fzd", line), riverMaxOffset(params));
      const spine = region.spine!;
      if (spine.totalLen < 1) continue;
      // The partner IS this spine's own polyline (a pathological overlap) plus a
      // zero-length water polygon at the mouth.
      const M = spine.points[spine.points.length - 1];
      const constraints = {
        worldBounds: CONSTRAINTS.worldBounds,
        fabricFeatures: [
          { type: "Feature", id: `dup-${s}`, geometry: { type: "LineString", coordinates: spine.points.map((p) => [p[0], p[1]]) }, properties: { kind: "river", procgen: { algorithm: "river", seed: s, version: 1, params: { width: 12 } } } },
          { type: "Feature", id: `wz-${s}`, geometry: { type: "Polygon", coordinates: [[[M[0], M[1]], [M[0], M[1]], [M[0], M[1]], [M[0], M[1]]]] }, properties: { kind: "water" } },
        ],
      } as GenerationConstraints;
      const maxOffset = riverMaxOffset(params);
      let feats: GeoJSON.Feature[] = [];
      expect(() => {
        feats = generateRiver(hashLike(s, 99), region, params, constraints);
      }).not.toThrow();
      for (const f of feats) {
        const scan = (c: unknown): void => {
          if (!Array.isArray(c)) return;
          if (typeof c[0] === "number" && typeof c[1] === "number") {
            expect(distanceToSpine(spine, c[0] as number, c[1] as number)).toBeLessThanOrEqual(maxOffset + 1e-2);
            return;
          }
          for (const x of c) scan(x);
        };
        scan((f.geometry as { coordinates: unknown }).coordinates);
      }
    }
  });
});
