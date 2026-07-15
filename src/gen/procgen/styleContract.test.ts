import { describe, it, expect } from "vitest";
import {
  ALL_STYLE_CONTRACTS,
  CITY_STYLE_CONTRACT,
  RIVER_STYLE_CONTRACT,
  FOREST_STYLE_CONTRACT,
  PARK_STYLE_CONTRACT,
  WALL_STYLE_CONTRACT,
  FARMLAND_STYLE_CONTRACT,
  MOUNTAIN_STYLE_CONTRACT,
  WORLD_STYLE_CONTRACT,
  contractGids,
  type BucketStyle,
} from "./styleContract";
import { allAlgorithms, type ProcgenAlgorithm } from "./registry";
import { makeRegion, makeSpine, makeCorridorRegion, type ProcgenRegion } from "../region";
import type { GenerationConstraints } from "../types";
import { generateWorldRegions } from "../world/regions";
import { generateRoutes } from "../world/routes";
import type { BBox } from "../spatialHash";

type Pt = [number, number];

const CONSTRAINTS: GenerationConstraints = {
  worldBounds: { minX: -1e5, minY: -1e5, maxX: 1e5, maxY: 1e5 },
};

/** An 800 m square in gen-space meters for the polygon algorithms. */
const SQUARE: Pt[] = [
  [0, 0],
  [800, 0],
  [800, 800],
  [0, 800],
  [0, 0],
];
/** A spine for the corridor (LINE) algorithms. */
const SPINE: Pt[] = [
  [0, 400],
  [400, 420],
  [800, 380],
];

const CONTRACT_BY_ID: Record<string, readonly BucketStyle[]> = {
  city: CITY_STYLE_CONTRACT,
  river: RIVER_STYLE_CONTRACT,
  forest: FOREST_STYLE_CONTRACT,
  park: PARK_STYLE_CONTRACT,
  wall: WALL_STYLE_CONTRACT,
  farmland: FARMLAND_STYLE_CONTRACT,
  mountain: MOUNTAIN_STYLE_CONTRACT,
};

function regionFor(algo: ProcgenAlgorithm, params: Record<string, unknown>): ProcgenRegion {
  if (algo.corridorMaxOffset) {
    return makeCorridorRegion(`${algo.id}-test`, makeSpine(`${algo.id}-test`, SPINE), algo.corridorMaxOffset(params));
  }
  return makeRegion(`${algo.id}-test`, SQUARE);
}

function emittedGids(feats: GeoJSON.Feature[]): Set<string> {
  const out = new Set<string>();
  for (const f of feats) {
    const gid = (f.properties as { generatorId?: unknown } | null)?.generatorId;
    if (typeof gid === "string") out.add(gid);
  }
  return out;
}

describe("style contract — every emitted gid is bound (kills the silent-drop trap)", () => {
  for (const algo of allAlgorithms()) {
    it(`${algo.id}: emitted generatorIds ⊆ contract gids across every preset`, () => {
      const allowed = new Set(contractGids(CONTRACT_BY_ID[algo.id]));
      // The derived cache-key list and the contract are one and the same.
      expect([...allowed].sort()).toEqual([...algo.tileGeneratorIds].sort());
      for (const preset of algo.presets) {
        for (const seed of [1, 4242]) {
          const region = regionFor(algo, preset.params);
          const feats = algo.generate(seed, region, preset.params, CONSTRAINTS) as GeoJSON.Feature[];
          for (const gid of emittedGids(feats)) {
            expect(allowed.has(gid), `${algo.id}/${preset.id} emits unbound gid "${gid}"`).toBe(true);
          }
        }
      }
    });
  }

  it("world-tier: generated regions + routes emit only world contract gids", () => {
    const allowed = new Set(contractGids(WORLD_STYLE_CONTRACT));
    const bbox: BBox = { minX: 0, minY: 0, maxX: 1500, maxY: 1500 };
    for (const seed of [1, 4242]) {
      for (const gid of emittedGids(generateWorldRegions(seed, bbox, CONSTRAINTS))) {
        expect(allowed.has(gid), `world-region generator emits unbound gid "${gid}"`).toBe(true);
      }
      for (const gid of emittedGids(generateRoutes(seed, bbox, CONSTRAINTS))) {
        expect(allowed.has(gid), `world-route generator emits unbound gid "${gid}"`).toBe(true);
      }
    }
  });

  it("z-slots are globally unique across all contracts (paint order is total)", () => {
    const zs = ALL_STYLE_CONTRACTS.flat()
      .filter((b) => !b.unpainted)
      .map((b) => b.z);
    expect(new Set(zs).size, "duplicate z-slot in the global contract").toBe(zs.length);
  });
});
