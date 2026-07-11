import { describe, expect, it } from "vitest";
import {
  generateCityNetwork,
  clipNetworkToTile,
  makeDomain,
  citySeedFor,
  type ProfileId,
} from "./index";
import type { BBox } from "../spatialHash";
import type { GenerationConstraints } from "../types";
import type { FabricFeature } from "../../model/fabric";
import { RIVER_HALF_WIDTH } from "../fabricConstraints";
import { COST_CELL_M } from "./costField";
import { tileBBox, GENERATION_TILE_SIZE } from "../cache/tileGrid";

const WORLD_BOUNDS: BBox = { minX: -4000, minY: -4000, maxX: 4000, maxY: 4000 };
const CAMPAIGN_SEED = 90210;

function domainAt(cx: number, cy: number, profile: ProfileId = "euro-medieval", radius = 900) {
  return makeDomain(cx, cy, radius, profile, 0);
}

function net(
  cx: number,
  cy: number,
  profile: ProfileId = "euro-medieval",
  constraints: Partial<GenerationConstraints> = {},
  radius = 900
) {
  const domain = domainAt(cx, cy, profile, radius);
  const seed = citySeedFor(CAMPAIGN_SEED, domain);
  return generateCityNetwork(seed, domain, { worldBounds: WORLD_BOUNDS, ...constraints });
}

/** A river line that fully bisects the domain's cost-field bbox horizontally. */
function riverThrough(cy: number): FabricFeature {
  return {
    type: "Feature",
    id: "river-1",
    geometry: { type: "LineString", coordinates: [[-4000, cy], [4000, cy]] },
    properties: { kind: "river" },
  };
}

function lineCoords(f: GeoJSON.Feature): [number, number][] {
  return (f.geometry as GeoJSON.LineString).coordinates as [number, number][];
}

describe("generateCityNetwork determinism (gate a)", () => {
  it("is byte-identical across repeated calls (cache delete + regenerate)", () => {
    const a = net(600, 600);
    const b = net(600, 600);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.length).toBeGreaterThan(0);
  });

  it("differs for a different domain seed", () => {
    const a = JSON.stringify(net(600, 600));
    const b = JSON.stringify(net(6000, 6000));
    expect(a).not.toBe(b);
  });

  it("clips identically regardless of tile call ordering", () => {
    const network = net(600, 600);
    const tiles: BBox[] = [tileBBox(0, 0), tileBBox(1, 0), tileBBox(1, 1)];
    const forward = tiles.map((t) => clipNetworkToTile(network, t));
    const reversed = [...tiles].reverse().map((t) => clipNetworkToTile(network, t));
    // Match each tile's bucket set regardless of the order they were computed.
    expect(JSON.stringify(forward[0])).toBe(JSON.stringify(reversed[2]));
    expect(JSON.stringify(forward[1])).toBe(JSON.stringify(reversed[1]));
    expect(JSON.stringify(forward[2])).toBe(JSON.stringify(reversed[0]));
  });
});

describe("2x2 seam test (gate b)", () => {
  // Domain straddling the shared corner of four generation tiles. Center is
  // offset off the seam (near, not on, the corner) so arterials cross the seams
  // as genuine line crossings rather than all sharing an on-seam origin node.
  const CORNER = GENERATION_TILE_SIZE; // 600
  const network = net(CORNER + 30, CORNER + 30);
  const tiles = {
    sw: tileBBox(0, 0), // [0,600]x[0,600]
    se: tileBBox(1, 0), // [600,1200]x[0,600]
    nw: tileBBox(0, 1), // [0,600]x[600,1200]
    ne: tileBBox(1, 1), // [600,1200]x[600,1200]
  };

  // Per the brief: LineString endpoints on a shared edge must match across it.
  function edgePoints(bucketMap: Record<string, GeoJSON.Feature[]>, axis: "x" | "y", value: number): number[] {
    const other: number[] = [];
    for (const feats of Object.values(bucketMap)) {
      for (const f of feats) {
        const g = f.geometry;
        if (g.type !== "LineString") continue;
        for (const [x, y] of g.coordinates as [number, number][]) {
          const on = axis === "x" ? x === value : y === value;
          if (on) other.push(axis === "x" ? y : x);
        }
      }
    }
    return other.sort((a, b) => a - b);
  }

  it("edge points on shared seams are bit-identical across neighbors", () => {
    const sw = clipNetworkToTile(network, tiles.sw);
    const se = clipNetworkToTile(network, tiles.se);
    const nw = clipNetworkToTile(network, tiles.nw);
    const ne = clipNetworkToTile(network, tiles.ne);

    // Vertical seam x=600: west tiles (sw, nw) vs east tiles (se, ne).
    const west = [...edgePoints(sw, "x", CORNER), ...edgePoints(nw, "x", CORNER)].sort((a, b) => a - b);
    const east = [...edgePoints(se, "x", CORNER), ...edgePoints(ne, "x", CORNER)].sort((a, b) => a - b);
    expect(west.length).toBeGreaterThan(0);
    expect(east).toEqual(west); // exact, not epsilon — clip is deterministic

    // Horizontal seam y=600: south tiles (sw, se) vs north tiles (nw, ne).
    const south = [...edgePoints(sw, "y", CORNER), ...edgePoints(se, "y", CORNER)].sort((a, b) => a - b);
    const north = [...edgePoints(nw, "y", CORNER), ...edgePoints(ne, "y", CORNER)].sort((a, b) => a - b);
    expect(south.length).toBeGreaterThan(0);
    expect(north).toEqual(south);
  });
});

describe("arterial reachability (gate c)", () => {
  it("every arterial reaches the domain circle or is flagged degraded", () => {
    const cx = 600;
    const cy = 600;
    const radius = 900;
    const network = net(cx, cy, "euro-medieval", {}, radius);
    const arterials = network.filter(
      (f) => f.properties?.type === "street" && f.properties?.roadClass === "arterial"
    );
    expect(arterials.length).toBeGreaterThan(0);
    for (const art of arterials) {
      const coords = lineCoords(art);
      const last = coords[coords.length - 1];
      const distFromCircle = Math.abs(Math.hypot(last[0] - cx, last[1] - cy) - radius);
      const reached = distFromCircle < COST_CELL_M * 1.6;
      expect(reached || art.properties?.degraded === true).toBe(true);
    }
  });
});

describe("bridge on river (gate d)", () => {
  it("crosses a bisecting river with bridge features hugging the river line", () => {
    const cy = 600;
    const network = net(600, cy, "euro-medieval", { fabricFeatures: [riverThrough(cy)] });
    const bridges = network.filter((f) => f.properties?.type === "bridge");
    expect(bridges.length).toBeGreaterThan(0);
    const tol = RIVER_HALF_WIDTH + COST_CELL_M + 0.01;
    for (const b of bridges) {
      for (const [, y] of lineCoords(b)) {
        expect(Math.abs(y - cy)).toBeLessThan(tol);
      }
    }
  });
});

describe("waterfront offsets (gate e)", () => {
  it("euro-medieval quays a sketched river; na-grid does not", () => {
    const cy = 600;
    const euro = net(600, cy, "euro-medieval", { fabricFeatures: [riverThrough(cy)] });
    const na = net(600, cy, "na-grid", { fabricFeatures: [riverThrough(cy)] });
    const isQuay = (f: GeoJSON.Feature) =>
      f.properties?.type === "street" && f.properties?.roadClass === "street";
    expect(euro.some(isQuay)).toBe(true);
    expect(na.some(isQuay)).toBe(false);
  });
});

describe("canon avoidance (gate f)", () => {
  it("arterials route clear of a canon Point near the center", () => {
    const cx = 600;
    const cy = 600;
    const canon: GeoJSON.Feature = {
      type: "Feature",
      geometry: { type: "Point", coordinates: [cx + 45, cy] },
      properties: {},
    };
    const network = net(cx, cy, "euro-medieval", { canonFeatures: [canon] });
    const streets = network.filter((f) => f.properties?.generatorId === "city-street");
    for (const s of streets) {
      for (const [x, y] of lineCoords(s)) {
        expect(Math.hypot(x - (cx + 45), y - cy)).toBeGreaterThan(15);
      }
    }
  });
});

describe("profile smoke (gate g)", () => {
  const profiles: ProfileId[] = ["euro-medieval", "euro-continental", "na-grid", "na-suburb"];
  for (const profile of profiles) {
    it(`${profile} generates a bounded network with a plaza`, () => {
      let network: GeoJSON.Feature[] = [];
      expect(() => {
        network = net(1200, -900, profile);
      }).not.toThrow();
      expect(network.length).toBeGreaterThan(0);
      expect(network.length).toBeLessThan(300);
      expect(network.some((f) => f.properties?.type === "plaza")).toBe(true);
    });
  }
});
