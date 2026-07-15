// Ruling 2026-07-15 — "no more mountain polygons, only the global terrain
// system". A relief RIDGE and a landform PLATEAU are terrain stamps that reach
// the SAME consumers a mountain does (forest timberline / farmland pasture +
// paddy / river slope), via the composed `macroTerrainField` — with NO mountain
// polygon present. Each coupling: (1) changes output vs the uncoupled control,
// (2) is byte-inert when the stamp is disjoint/absent (the variable-support
// invariant the 033 harness + fingerprint scope now key on).
import { describe, expect, it } from "vitest";
import { generateForest, type ForestParams } from "./forest";
import { generateFarmland, type FarmlandParams } from "./farmland";
import { generateRiver, riverMaxOffset, type RiverParams } from "./river";
import { makeRegion, makeSpine, makeCorridorRegion } from "./region";
import { macroTerrainField } from "./fields/terrain";
import type { GenerationConstraints } from "./types";
import type { FabricFeature } from "../model/fabric";
import type { BBox } from "./spatialHash";

type Pt = [number, number];
const WORLD: BBox = { minX: -1e5, minY: -1e5, maxX: 1e5, maxY: 1e5 };

/** A relief ridge stamp (LineString + `relief` procgen block) — no mountain. */
function reliefRidge(id: string, spine: Pt[], height: number, halfWidth: number): FabricFeature {
  return {
    type: "Feature",
    id,
    geometry: { type: "LineString", coordinates: spine },
    properties: { kind: "relief", procgen: { algorithm: "relief", seed: 31, version: 1, params: { polarity: "ridge", height, halfWidth } } },
  } as FabricFeature;
}
/** A landform plateau stamp (Polygon + `landform` procgen block) — no mountain. */
function landformPlateau(id: string, ring: Pt[], target: number, band: number): FabricFeature {
  return {
    type: "Feature",
    id,
    geometry: { type: "Polygon", coordinates: [ring] },
    properties: { kind: "landform", procgen: { algorithm: "landform", seed: 41, version: 1, params: { mode: "plateau", target, band, priority: 0 } } },
  } as FabricFeature;
}

// ─── Forest: a relief ridge thins the canopy above its treeline (no mountain) ─
describe("forest timberline reads a RELIEF ridge (no mountain polygon)", () => {
  const RING: Pt[] = [[0, 0], [800, 0], [800, 800], [0, 800], [0, 0]];
  const REGION = makeRegion("ts-forest", RING);
  const PARAMS: ForestParams = { variety: "mixed", density: 0.7, clearings: 0.12, edgeRaggedness: 0.4 };
  const SEED = 909;
  // A raised spine across the middle (y≈400); the field peaks on the spine and
  // decays to 0 by the region's top/bottom edges (dist > halfWidth).
  const RIDGE = reliefRidge("ridge", [[-100, 400], [900, 400]], 500, 300);

  const coupled = generateForest(SEED, REGION, PARAMS, { worldBounds: WORLD, fabricFeatures: [RIDGE] });
  const uncoupled = generateForest(SEED, REGION, PARAMS, { worldBounds: WORLD });

  const terrain = macroTerrainField([RIDGE])!;
  let eMin = Infinity;
  let eMax = -Infinity;
  for (let x = 0; x <= 800; x += 30) for (let y = 0; y <= 800; y += 30) {
    const v = terrain(x, y).v;
    if (v < eMin) eMin = v;
    if (v > eMax) eMax = v;
  }
  const rel = (p: Pt): number => (terrain(p[0], p[1]).v - eMin) / (eMax - eMin);
  const trees = (feats: GeoJSON.Feature[]): Pt[] =>
    feats.filter((f) => (f.properties as { generatorId?: string }).generatorId === "forest-tree").map((f) => (f.geometry as GeoJSON.Point).coordinates as Pt);

  it("the relief-only campaign has real in-region relief (macro field is non-null and spans)", () => {
    expect(macroTerrainField([RIDGE])).not.toBeNull();
    expect(eMax - eMin).toBeGreaterThan(50);
  });

  it("couples the wood: coupled ≠ uncoupled", () => {
    expect(JSON.stringify(coupled)).not.toBe(JSON.stringify(uncoupled));
  });

  it("timberline: fewer trees sit above the treeline than the uncoupled wood", () => {
    const TIMBER = 0.72;
    const above = (ps: Pt[]): number => ps.filter((p) => rel(p) > TIMBER).length;
    const uncoupledHigh = above(trees(uncoupled));
    expect(uncoupledHigh).toBeGreaterThan(0);
    expect(above(trees(coupled))).toBeLessThan(uncoupledHigh);
  });

  it("a DISJOINT relief ridge is byte-identical (variable support: past halfWidth ⇒ inert)", () => {
    const base = JSON.stringify(uncoupled);
    // Ridge ~4 km away — well past its 300 m half-width.
    const far = reliefRidge("ridge-far", [[3900, 4000], [4900, 4000]], 500, 300);
    expect(JSON.stringify(generateForest(SEED, REGION, PARAMS, { worldBounds: WORLD, fabricFeatures: [far] }))).toBe(base);
  });
});

// ─── Farmland: a relief slope tags fields as pasture (no mountain) ───────────
describe("farmland pasture tag from RELIEF slope (no mountain polygon)", () => {
  const RING: Pt[] = [[0, 0], [600, 0], [600, 600], [0, 600], [0, 0]];
  const REGION = makeRegion("ts-farm", RING);
  const PARAMS: FarmlandParams = { fieldType: "enclosed-patchwork", fieldSize: 0.5, hedging: "hedgerows", laneDensity: 0.5, farmsteads: 0.3 };
  const SEED = 77;
  // A steep ridge (|∇| ≈ 1.5·height/halfWidth = 5 m/m ≫ the 0.3 pasture gate).
  const RIDGE = reliefRidge("farm-ridge", [[-100, 300], [700, 300]], 500, 150);

  // The SLOPE-GATED tag is `pasture: true` (props.crop === "pasture" is ALSO a
  // random crop, so filter on the boolean the slope gate sets).
  const pastureCount = (feats: GeoJSON.Feature[]): number =>
    feats.filter((f) => (f.properties as { pasture?: boolean }).pasture === true).length;

  it("steep relief ground is left as untilled pasture; flat ground has none", () => {
    const coupled = generateFarmland(SEED, REGION, PARAMS, { worldBounds: WORLD, fabricFeatures: [RIDGE] });
    const flat = generateFarmland(SEED, REGION, PARAMS, { worldBounds: WORLD });
    expect(pastureCount(flat)).toBe(0);
    expect(pastureCount(coupled)).toBeGreaterThan(0);
  });

  it("a DISJOINT relief ridge is byte-identical", () => {
    const base = JSON.stringify(generateFarmland(SEED, REGION, PARAMS, { worldBounds: WORLD }));
    const far = reliefRidge("farm-ridge-far", [[5000, 5300], [5800, 5300]], 500, 150);
    expect(JSON.stringify(generateFarmland(SEED, REGION, PARAMS, { worldBounds: WORLD, fabricFeatures: [far] }))).toBe(base);
  });
});

// ─── Farmland paddy: banks follow a landform PLATEAU edge (no mountain) ──────
describe("paddy terraces read a landform PLATEAU edge (no mountain polygon)", () => {
  const RING: Pt[] = [[0, 0], [700, 0], [700, 700], [0, 700], [0, 0]];
  const REGION = makeRegion("ts-paddy", RING);
  const PARAMS: FarmlandParams = { fieldType: "paddy-terraces", fieldSize: 0.35, hedging: "none", laneDensity: 0.4, farmsteads: 0.25 };
  const SEED = 55;
  // A plateau whose ring edge runs through the region: the band ramp gives the
  // paddy contour-following banks real relief to key on.
  const PLATEAU = landformPlateau("plateau", [[-200, -200], [400, -200], [400, 900], [-200, 900], [-200, -200]], 500, 250);

  const banks = (feats: GeoJSON.Feature[]): number =>
    feats.filter((f) => (f.properties as { generatorId?: string }).generatorId === "farm-bank").length;

  it("a landform plateau edge changes the paddy banks vs the flat control", () => {
    const coupled = generateFarmland(SEED, REGION, PARAMS, { worldBounds: WORLD, fabricFeatures: [PLATEAU] });
    const flat = generateFarmland(SEED, REGION, PARAMS, { worldBounds: WORLD });
    expect(banks(coupled)).toBeGreaterThan(0);
    expect(JSON.stringify(coupled)).not.toBe(JSON.stringify(flat));
  });

  it("a DISJOINT landform plateau is byte-identical (support strictly inside the ring)", () => {
    const base = JSON.stringify(generateFarmland(SEED, REGION, PARAMS, { worldBounds: WORLD }));
    const far = landformPlateau("plateau-far", [[5000, 5000], [5400, 5000], [5400, 5400], [5000, 5400], [5000, 5000]], 500, 250);
    expect(JSON.stringify(generateFarmland(SEED, REGION, PARAMS, { worldBounds: WORLD, fabricFeatures: [far] }))).toBe(base);
  });
});

// ─── River: opt-in slope coupling reads a relief ridge (no mountain) ─────────
describe("river slope coupling reads a RELIEF ridge (no mountain polygon)", () => {
  const LINE: Pt[] = [[0, 0], [1600, 0], [3200, 0], [4800, 0], [6400, 0]];
  // slopeSensitivity 1 + windy: the opt-in terrain read is ON (river v2 default OFF).
  const P: RiverParams = { windiness: 0.8, braiding: 0, width: 20, widthGrowth: 0, braidBias: 0, slopeSensitivity: 1 };
  const REGION = makeCorridorRegion("ts-river", makeSpine("ts-river", LINE), riverMaxOffset(P));
  const SEED = 50;
  // A ridge crossing the river's path (perpendicular), no mountain anywhere.
  const RIDGE = reliefRidge("river-ridge", [[3200, -800], [3200, 800]], 600, 500);

  it("steep relief ground reshapes the river vs the flat control", () => {
    const coupled = generateRiver(SEED, REGION, P, { worldBounds: WORLD, fabricFeatures: [RIDGE] });
    const flat = generateRiver(SEED, REGION, P, { worldBounds: WORLD });
    expect(JSON.stringify(coupled)).not.toBe(JSON.stringify(flat));
  });

  it("a DISJOINT relief ridge (past its half-width) is byte-identical", () => {
    const base = JSON.stringify(generateRiver(SEED, REGION, P, { worldBounds: WORLD }));
    const far = reliefRidge("river-ridge-far", [[3200, 6000], [3200, 7000]], 600, 500);
    expect(JSON.stringify(generateRiver(SEED, REGION, P, { worldBounds: WORLD, fabricFeatures: [far] }))).toBe(base);
  });

  it("slopeSensitivity 0 over the ridge is byte-identical to the flat control (opt-in only)", () => {
    const off: RiverParams = { ...P, slopeSensitivity: 0 };
    const base = JSON.stringify(generateRiver(SEED, REGION, off, { worldBounds: WORLD }));
    expect(JSON.stringify(generateRiver(SEED, REGION, off, { worldBounds: WORLD, fabricFeatures: [RIDGE] }))).toBe(base);
  });
});
