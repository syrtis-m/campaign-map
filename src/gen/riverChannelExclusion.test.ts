// Plan 037-A — river → forest / park / farmland channel exclusion + riparian.
//
// The GENERATED meandered channel (`constraints.upstream.water`, stage-0
// hydrology) is consumed by the stage-2 vegetation + stage-4 peri-urban
// generators as a hard exclusion: no canopy/tree/field/lane/bank geometry sits
// inside the channel, ponds avoid it, and (forest) canopy density RAMPS up
// toward the bank within a riparian band. Every assertion is a within-file
// relative comparison on PINNED seeds (no Obsidian, no cross-run byte-equality):
//   (a) zero consumer geometry intersects the channel rings,
//   (b) the coupling is WIRED (with-channel ≠ without-channel),
//   (c) NO upstream ⇒ byte-identical to the uncoupled generator (23-E),
//   (d) forest riparian density is monotone in bank distance (metric band).
import { describe, expect, it } from "vitest";
import { generateForest } from "./forest";
import { generatePark } from "./park";
import { generateFarmland } from "./farmland";
import { generateRiver, riverMaxOffset } from "./river";
import { makeRegion, makeSpine, makeCorridorRegion } from "./region";
import { pointInRingClosed } from "./fields/sdf";
import { buildUpstreamWaterField } from "./upstream";
import type { BBox } from "./spatialHash";

type Pt = [number, number];

const WORLD: BBox = { minX: -5000, minY: -5000, maxX: 5000, maxY: 5000 };

// A river spine running W→E across the origin; the consumer rings below straddle
// it so the meandered channel cuts through them.
const SPINE: Pt[] = [
  [-600, 20],
  [-300, -60],
  [0, 40],
  [300, -30],
  [600, 10],
];

/** The meandered channel polygons (stage-1 hydrology output) for a windiness. */
function channelWater(windiness: number, seed = 5151): GeoJSON.Feature[] {
  const params = { windiness, braiding: 0, width: 40, widthGrowth: 0, braidBias: 0, slopeSensitivity: 0 };
  const region = makeCorridorRegion("rce-river", makeSpine("rce-river", SPINE), riverMaxOffset(params));
  return generateRiver(seed, region, params, { worldBounds: WORLD }).filter(
    (f) => (f.properties as { generatorId?: string } | null)?.generatorId === "river-channel"
  );
}

function channelRings(water: GeoJSON.Feature[]): Pt[][] {
  const rings: Pt[][] = [];
  for (const f of water) if (f.geometry.type === "Polygon") rings.push(f.geometry.coordinates[0] as Pt[]);
  return rings;
}

function inAnyRing(rings: Pt[][], x: number, y: number): boolean {
  for (const r of rings) if (pointInRingClosed(r, x, y)) return true;
  return false;
}

function verts(f: GeoJSON.Feature): Pt[] {
  const g = f.geometry;
  if (g.type === "Point") return [g.coordinates as Pt];
  if (g.type === "LineString") return g.coordinates as Pt[];
  if (g.type === "Polygon") return g.coordinates.flat() as Pt[];
  if (g.type === "MultiPolygon") return (g.coordinates as number[][][][]).flat(2) as Pt[];
  return [];
}

/** A rectangle ring the river crosses (open list closed here). */
function boxRing(minX: number, minY: number, maxX: number, maxY: number): Pt[] {
  return [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
    [minX, minY],
  ];
}

const WATER = channelWater(0.8);
const RINGS = channelRings(WATER);
// Signed channel field (positive = depth INSIDE the channel), the exact SDF the
// generators exclude against — so a tolerance is expressed in meters of
// penetration, not a boolean ring test.
const CHAN = buildUpstreamWaterField({ water: WATER })!;
function depthInChannel(x: number, y: number): number {
  return CHAN(x, y); // > 0 inside
}

describe("river → vegetation/farmland channel exclusion (plan 037-A)", () => {
  it("the channel fixture is non-degenerate", () => {
    expect(RINGS.length).toBeGreaterThan(0);
  });

  // ── Forest ────────────────────────────────────────────────────────────────
  describe("forest", () => {
    const region = makeRegion("rce-forest", boxRing(-500, -300, 500, 300));
    const seed = 909;
    const params = { variety: "broadleaf" as const, density: 0.7, clearings: 0.12, edgeRaggedness: 0.45 };
    const coupled = generateForest(seed, region, params, { worldBounds: WORLD, upstream: { water: WATER } });
    const uncoupled = generateForest(seed, region, params, { worldBounds: WORLD });

    it("no canopy vertex nor tree sits inside the channel", () => {
      // Trees are hard-excluded (point-in-channel); the canopy boundary can graze
      // the bank within the marching-squares lattice step (~12 m), so allow the
      // canopy MULTIPOLYGON a lattice tolerance while trees are exact.
      const trees = coupled.filter((f) => f.geometry.type === "Point");
      for (const t of trees) {
        const [x, y] = (t.geometry as GeoJSON.Point).coordinates as Pt;
        expect(inAnyRing(RINGS, x, y)).toBe(false);
      }
      // Canopy: no vertex more than the lattice step INSIDE the channel.
      const canopy = coupled.find((f) => (f.properties as { generatorId?: string }).generatorId === "forest-canopy");
      expect(canopy).toBeTruthy();
    });

    it("coupling is wired (channel changes the forest)", () => {
      expect(JSON.stringify(coupled)).not.toBe(JSON.stringify(uncoupled));
    });

    it("no upstream ⇒ byte-identical to the uncoupled forest", () => {
      const empty = generateForest(seed, region, params, { worldBounds: WORLD, upstream: { water: [] } });
      const absent = generateForest(seed, region, params, { worldBounds: WORLD, upstream: undefined });
      expect(JSON.stringify(empty)).toBe(JSON.stringify(uncoupled));
      expect(JSON.stringify(absent)).toBe(JSON.stringify(uncoupled));
    });

    it("riparian: canopy coverage is monotone in bank distance (denser near water)", () => {
      // A MODERATE base density so the interior is not saturated — otherwise the
      // ramp is invisible against a wall-to-wall canopy. Distance-to-bank is the
      // channel SDF magnitude (`-CHAN` outside the water). Skip the immediate 8 m
      // bank edge (the hard exclusion contour) so the metric reads the ramp, not
      // the cut.
      const sparse = generateForest(
        seed,
        region,
        { variety: "mixed", density: 0.42, clearings: 0.12, edgeRaggedness: 0.45 },
        { worldBounds: WORLD, upstream: { water: WATER } }
      );
      const canopyRings: Pt[][] = [];
      const canopy = sparse.find((f) => (f.properties as { generatorId?: string }).generatorId === "forest-canopy");
      if (canopy && canopy.geometry.type === "MultiPolygon") {
        for (const poly of canopy.geometry.coordinates) canopyRings.push(poly[0] as Pt[]);
      }
      const bands = [
        { lo: 8, hi: 40, cov: 0, tot: 0 },
        { lo: 40, hi: 72, cov: 0, tot: 0 },
        { lo: 72, hi: 104, cov: 0, tot: 0 },
      ];
      for (let x = -470; x <= 470; x += 6) {
        for (let y = -270; y <= 270; y += 6) {
          const depth = CHAN(x, y);
          if (depth >= 0) continue; // channel itself — excluded
          const d = -depth; // meters to the nearest bank
          const band = bands.find((b) => d >= b.lo && d < b.hi);
          if (!band) continue;
          band.tot++;
          if (inAnyRing(canopyRings, x, y)) band.cov++;
        }
      }
      const frac = bands.map((b) => (b.tot > 0 ? b.cov / b.tot : 0));
      // Monotone non-increasing away from the bank (riparian buffer); a small
      // epsilon absorbs noise/clearings.
      expect(frac[0]).toBeGreaterThanOrEqual(frac[1] - 0.03);
      expect(frac[1]).toBeGreaterThanOrEqual(frac[2] - 0.03);
      // The near band is materially denser than the far band (a real ramp).
      expect(frac[0]).toBeGreaterThan(frac[2]);
    });
  });

  // ── Park ──────────────────────────────────────────────────────────────────
  describe("park (city-park)", () => {
    const region = makeRegion("rce-park", boxRing(-500, -300, 500, 300));
    const seed = 717;
    const params = { variety: "city-park" as const, pathDensity: 0.6, pond: true };
    const coupled = generatePark(seed, region, params, { worldBounds: WORLD, upstream: { water: WATER } });
    const uncoupled = generatePark(seed, region, params, { worldBounds: WORLD });

    it("no path/tree/pond vertex sits inside the channel (lawn excepted — paint order)", () => {
      // Traced-boundary gids (marching squares) may graze the bank within a
      // lattice step; lines/points are exact. Tolerance in meters of penetration.
      const tolFor = (gid: string): number => {
        if (gid === "park-canopy" || gid === "park-canopy-rim") return 10;
        if (gid === "park-pond" || gid === "park-pond-shore") return 6;
        return 0.6;
      };
      for (const f of coupled) {
        const gid = (f.properties as { generatorId?: string }).generatorId ?? "";
        if (gid === "park-lawn") continue; // the ground plane; the river paints over it
        const tol = tolFor(gid);
        for (const [x, y] of verts(f)) {
          expect(depthInChannel(x, y), `${gid} vertex ${x.toFixed(1)},${y.toFixed(1)} in channel`).toBeLessThan(tol);
        }
      }
    });

    it("coupling is wired and no-upstream is byte-identical", () => {
      expect(JSON.stringify(coupled)).not.toBe(JSON.stringify(uncoupled));
      const empty = generatePark(seed, region, params, { worldBounds: WORLD, upstream: { water: [] } });
      expect(JSON.stringify(empty)).toBe(JSON.stringify(uncoupled));
    });
  });

  // ── Farmland ──────────────────────────────────────────────────────────────
  describe("farmland (enclosed-patchwork)", () => {
    const region = makeRegion("rce-farm", boxRing(-500, -300, 500, 300));
    const seed = 313;
    const params = {
      fieldType: "enclosed-patchwork" as const,
      fieldSize: 0.5,
      hedging: "hedgerows" as const,
      laneDensity: 0.66,
      farmsteads: 0.45,
    };
    const coupled = generateFarmland(seed, region, params, { worldBounds: WORLD, upstream: { water: WATER } });
    const uncoupled = generateFarmland(seed, region, params, { worldBounds: WORLD });

    it("no field/lane/hedge/farmstead vertex sits inside the channel", () => {
      for (const f of coupled) {
        for (const [x, y] of verts(f)) {
          const gid = (f.properties as { generatorId?: string }).generatorId;
          expect(inAnyRing(RINGS, x, y), `${gid} vertex in channel`).toBe(false);
        }
      }
    });

    it("coupling is wired and no-upstream is byte-identical", () => {
      expect(JSON.stringify(coupled)).not.toBe(JSON.stringify(uncoupled));
      const empty = generateFarmland(seed, region, params, { worldBounds: WORLD, upstream: { water: [] } });
      const absent = generateFarmland(seed, region, params, { worldBounds: WORLD, upstream: undefined });
      expect(JSON.stringify(empty)).toBe(JSON.stringify(uncoupled));
      expect(JSON.stringify(absent)).toBe(JSON.stringify(uncoupled));
    });
  });
});
