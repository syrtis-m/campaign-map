// Plan 038 item 4 — forest terrain reading (timberline + conifer-upslope + sag).
//
// The MACRO terrain field (mountains + base) reshapes the wood by RELATIVE
// elevation within the region: a timberline thins the canopy + drops trees above
// the treeline, upslope stands carry a `standConifer` paint hook, and the canopy
// sags a little denser in hollows. Pinned seeds; within-file relative checks:
//   (a) an overlapping mountain COUPLES the wood (coupled ≠ uncoupled),
//   (b) TIMBERLINE: fewer trees sit above the treeline than the uncoupled wood,
//   (c) CONIFER-UPSLOPE: standConifer trees exist and skew high,
//   (d) NO terrain / a DISJOINT mountain ⇒ byte-identical (23-E).
import { describe, expect, it } from "vitest";
import { generateForest, type ForestParams } from "./forest";
import { makeRegion } from "./region";
import { macroTerrainField } from "./fields/terrain";
import type { GenerationConstraints } from "./types";
import type { FabricFeature } from "../model/fabric";
import type { BBox } from "./spatialHash";

type Pt = [number, number];

const WORLD: BBox = { minX: -1e5, minY: -1e5, maxX: 1e5, maxY: 1e5 };

const REGION_RING: Pt[] = [
  [0, 0],
  [800, 0],
  [800, 800],
  [0, 800],
  [0, 0],
];
const REGION = makeRegion("ft-forest", REGION_RING);
const PARAMS: ForestParams = { variety: "mixed", density: 0.7, clearings: 0.12, edgeRaggedness: 0.4 };
const SEED = 4242;

/** An alpine mountain covering the region (steep relief ⇒ a real treeline). */
const MOUNTAIN_OVER = {
  type: "Feature",
  id: "mtn",
  geometry: { type: "Polygon", coordinates: [[[-300, -300], [1100, -300], [1100, 1100], [-300, 1100], [-300, -300]]] },
  properties: { kind: "mountain", procgen: { algorithm: "mountain", seed: 91, version: 1, params: { terrain: "alpine", amplitude: 0.9, roughness: 0.5 } } },
} as FabricFeature;

const COUPLED: GenerationConstraints = { worldBounds: WORLD, fabricFeatures: [MOUNTAIN_OVER] };

function trees(feats: GeoJSON.Feature[]): Pt[] {
  return feats.filter((f) => (f.properties as { generatorId?: string }).generatorId === "forest-tree").map((f) => (f.geometry as GeoJSON.Point).coordinates as Pt);
}
function coniferTrees(feats: GeoJSON.Feature[]): Pt[] {
  return feats
    .filter((f) => (f.properties as { standConifer?: boolean }).standConifer === true)
    .map((f) => (f.geometry as GeoJSON.Point).coordinates as Pt);
}

// The region relative-elevation, computed the same way the generator does.
const terrain = macroTerrainField([MOUNTAIN_OVER])!;
function relRange(): { eMin: number; eMax: number } {
  let eMin = Infinity;
  let eMax = -Infinity;
  for (let x = 0; x <= 800; x += 30) for (let y = 0; y <= 800; y += 30) {
    const v = terrain(x, y).v;
    if (v < eMin) eMin = v;
    if (v > eMax) eMax = v;
  }
  return { eMin, eMax };
}
const { eMin, eMax } = relRange();
function rel(p: Pt): number {
  return (terrain(p[0], p[1]).v - eMin) / (eMax - eMin);
}

describe("forest terrain reading (plan 038 item 4)", () => {
  const coupled = generateForest(SEED, REGION, PARAMS, COUPLED);
  const uncoupled = generateForest(SEED, REGION, PARAMS, { worldBounds: WORLD });

  it("the mountain fixture yields real relief in the region", () => {
    expect(eMax - eMin).toBeGreaterThan(50);
  });

  it("(a) an overlapping mountain couples the wood", () => {
    expect(JSON.stringify(coupled)).not.toBe(JSON.stringify(uncoupled));
  });

  it("(b) timberline: fewer trees above the treeline than the uncoupled wood", () => {
    const TIMBER = 0.72;
    const above = (ps: Pt[]): number => ps.filter((p) => rel(p) > TIMBER).length;
    const coupledHigh = above(trees(coupled));
    const uncoupledHigh = above(trees(uncoupled));
    expect(uncoupledHigh).toBeGreaterThan(0); // the uncoupled wood does put trees up high
    expect(coupledHigh).toBeLessThan(uncoupledHigh); // the treeline thinned them
  });

  it("(c) conifer-upslope: standConifer trees exist and skew high", () => {
    const conifers = coniferTrees(coupled);
    expect(conifers.length).toBeGreaterThan(0);
    // Every conifer-tagged tree sits at/above the CONIFER_REL threshold (0.5).
    for (const p of conifers) expect(rel(p)).toBeGreaterThanOrEqual(0.5 - 1e-6);
  });

  it("(d) no terrain / a disjoint mountain ⇒ byte-identical", () => {
    const base = JSON.stringify(uncoupled);
    expect(JSON.stringify(generateForest(SEED, REGION, PARAMS, { worldBounds: WORLD, fabricFeatures: [] }))).toBe(base);
    const farMtn = {
      type: "Feature",
      id: "mtn-far",
      geometry: { type: "Polygon", coordinates: [[[-6000, -6000], [-3000, -6000], [-3000, -3000], [-6000, -3000], [-6000, -6000]]] },
      properties: { kind: "mountain", procgen: { algorithm: "mountain", seed: 91, version: 1, params: { terrain: "alpine", amplitude: 0.9, roughness: 0.5 } } },
    } as FabricFeature;
    expect(JSON.stringify(generateForest(SEED, REGION, PARAMS, { worldBounds: WORLD, fabricFeatures: [farMtn] }))).toBe(base);
  });

  it("is deterministic (double-run byte-identical) with terrain", () => {
    expect(JSON.stringify(generateForest(SEED, REGION, PARAMS, COUPLED))).toBe(JSON.stringify(coupled));
  });
});
