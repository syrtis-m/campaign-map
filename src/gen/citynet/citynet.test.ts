import { describe, expect, it } from "vitest";
import {
  generateCityNetwork,
  clipNetworkToTile,
  makeDomain,
  citySeedFor,
  PROFILES,
  type ProfileId,
} from "./index";
import type { BBox } from "../spatialHash";
import type { GenerationConstraints } from "../types";
import { hashSeed, mulberry32 } from "../rng";
import type { FabricFeature } from "../../model/fabric";
import { RIVER_HALF_WIDTH } from "../fabricConstraints";
import { COST_CELL_M, makeCostField } from "./costField";
import { buildSkeleton } from "./skeleton";
import { growNetwork } from "./growth";
import { extractBlocks } from "./faces";
import { subdivideBlocks } from "./parcels";
import { makeCityness } from "./cityness";
import { toMeters, type StreetGraph } from "./graph";
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
  // Since v3.1 grown streets share `roadClass: "street"` with quays, so quays
  // are identified geometrically: long streets running parallel to the river
  // in one of the profile's offset bands (20 m / 55 m), which the growth loop
  // cannot produce by accident over a >100 m run.
  function hasQuay(network: GeoJSON.Feature[], riverY: number): boolean {
    return network.some((f) => {
      if (f.properties?.type !== "street" || f.properties?.roadClass !== "street") return false;
      const coords = lineCoords(f);
      let len = 0;
      for (let i = 1; i < coords.length; i++) {
        len += Math.hypot(coords[i][0] - coords[i - 1][0], coords[i][1] - coords[i - 1][1]);
      }
      if (len < 100) return false;
      const inBand = (off: number) => coords.every(([, y]) => Math.abs(Math.abs(y - riverY) - off) < 2);
      return inBand(20) || inBand(55);
    });
  }

  it("euro-medieval quays a sketched river; na-grid does not", () => {
    const cy = 600;
    const euro = net(600, cy, "euro-medieval", { fabricFeatures: [riverThrough(cy)] });
    const na = net(600, cy, "na-grid", { fabricFeatures: [riverThrough(cy)] });
    expect(hasQuay(euro, cy)).toBe(true);
    expect(hasQuay(na, cy)).toBe(false);
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

// ── v3.1 Stage-B gates ──────────────────────────────────────────────────────

/** Run the growth pipeline directly (skeleton → growth) for graph metrics. */
function grownGraph(
  cx: number,
  cy: number,
  radius = 900,
  constraints: Partial<GenerationConstraints> = {}
): { graph: StreetGraph; seed: number; domain: ReturnType<typeof makeDomain> } {
  const domain = domainAt(cx, cy, "euro-medieval", radius);
  const seed = citySeedFor(CAMPAIGN_SEED, domain);
  const cons: GenerationConstraints = { worldBounds: WORLD_BOUNDS, ...constraints };
  const profile = PROFILES["euro-medieval"];
  const cost = makeCostField(seed, domain, cons);
  const skel = buildSkeleton(seed, domain, profile, cons, cost);
  const { graph } = growNetwork(seed, domain, profile, cons, skel);
  return { graph, seed, domain };
}

describe("v3.1 junction histogram (gate c)", () => {
  it("euro-medieval: T-junctions (degree 3) outnumber 4-ways (degree 4+)", () => {
    const { graph } = grownGraph(600, 600);
    let deg3 = 0;
    let deg4 = 0;
    for (const key of graph.sortedNodeKeys()) {
      const d = graph.degree(key);
      if (d === 3) deg3++;
      else if (d >= 4) deg4++;
    }
    expect(deg3).toBeGreaterThan(0);
    expect(deg3).toBeGreaterThan(deg4);
  });
});

describe("v3.1 connectivity (gate d)", () => {
  it("dangling endpoints < 15% of grown endpoints inside the growth extent", () => {
    const { graph, domain } = grownGraph(600, 600);
    const extent = domain.radius * 0.6;
    let total = 0;
    let dangling = 0;
    const counted = new Set<string>();
    for (const e of graph.sortedEdges()) {
      if (!e.props.grown) continue;
      for (const key of [e.a, e.b]) {
        if (counted.has(key)) continue;
        counted.add(key);
        const n = graph.getNode(key)!;
        if (Math.hypot(toMeters(n.x) - domain.cx, toMeters(n.y) - domain.cy) > extent) continue;
        total++;
        if (graph.degree(key) === 1) dangling++;
      }
    }
    expect(total).toBeGreaterThan(50);
    expect(dangling / total).toBeLessThan(0.15);
  });
});

describe("v3.1 200-domain fuzz (gate e, anti-Watabou)", () => {
  it("200 hashed domains generate without throwing, each within budget", () => {
    const t0 = Date.now();
    for (let i = 0; i < 200; i++) {
      const rng = mulberry32(hashSeed(4242, "fuzz", i));
      const cx = Math.round((rng() - 0.5) * 5000);
      const cy = Math.round((rng() - 0.5) * 5000);
      const radius = 400 + Math.round(rng() * 1100);
      const fabric: FabricFeature[] = [];
      if (i % 5 === 0) fabric.push(riverThrough(cy + Math.round((rng() - 0.5) * radius)));
      if (i % 7 === 0) {
        fabric.push({
          type: "Feature",
          id: `road-${i}`,
          geometry: {
            type: "LineString",
            coordinates: [
              [cx - radius, cy - Math.round(radius * 0.4)],
              [cx + radius, cy + Math.round(radius * 0.4)],
            ],
          },
          properties: { kind: "road" },
        });
      }
      const runStart = Date.now();
      const network = net(cx, cy, "euro-medieval", { fabricFeatures: fabric }, radius);
      expect(network.length).toBeGreaterThan(0);
      expect(Date.now() - runStart).toBeLessThan(5000); // per-run wall clock sane
    }
    expect(Date.now() - t0).toBeLessThan(180000);
  }, 240000);
});

describe("v3.1 budget (gate f, §8)", () => {
  it("radius-900 euro-medieval full network in ≤ 2000 ms", () => {
    net(600, 600); // warm module/JIT paths
    const t0 = Date.now();
    const network = net(-1500, 900);
    const ms = Date.now() - t0;
    expect(network.length).toBeGreaterThan(100);
    expect(ms).toBeLessThanOrEqual(2000);
  });
});

describe("v3.1 sketched-road pre-seed (gate g)", () => {
  const cx = 600;
  const cy = 600;
  // Straight sketched road through the domain (straight ⇒ Chaikin-invariant,
  // so "on the sketch" can be asserted against the raw line).
  const roadY = cy + 150;
  const road: FabricFeature = {
    type: "Feature",
    id: "road-1",
    geometry: { type: "LineString", coordinates: [[cx - 2000, roadY], [cx + 2000, roadY]] },
    properties: { kind: "road" },
  };

  it("generated streets snap onto the sketched road; the sketch is not re-emitted", () => {
    const network = net(cx, cy, "euro-medieval", { fabricFeatures: [road] });
    const streets = network.filter(
      (f) => f.properties?.generatorId === "city-street" && f.geometry.type === "LineString"
    );

    // (1) Snap happened: some street endpoint lies ON the road polyline.
    let snapped = 0;
    for (const s of streets) {
      const coords = lineCoords(s);
      for (const end of [coords[0], coords[coords.length - 1]]) {
        if (Math.abs(end[1] - roadY) < 0.02 && Math.abs(end[0] - cx) < 2000) snapped++;
      }
    }
    expect(snapped).toBeGreaterThan(0);

    // (2) The sketch itself is not re-emitted: no long street lies entirely
    // on the road line (snapped streets only touch it at an endpoint).
    for (const s of streets) {
      const coords = lineCoords(s);
      const allOnRoad = coords.every(([, y]) => Math.abs(y - roadY) < 0.1);
      if (!allOnRoad) continue;
      let len = 0;
      for (let i = 1; i < coords.length; i++) {
        len += Math.hypot(coords[i][0] - coords[i - 1][0], coords[i][1] - coords[i - 1][1]);
      }
      expect(len).toBeLessThan(100);
    }
  });
});

// ── v3.2 Stage-C gates ──────────────────────────────────────────────────────

describe("v3.2 blocks + parcels (gates a–d)", () => {
  const { graph, seed, domain } = grownGraph(600, 600);
  const { blocks, stats } = extractBlocks(graph, domain);

  it("extracts a substantial block set with counted (not thrown) degenerates", () => {
    expect(blocks.length).toBeGreaterThan(100);
    expect(stats.degenerate).toBeGreaterThanOrEqual(0); // counted, never thrown
    // Every block ring is closed and CCW-positive by construction.
    for (const b of blocks.slice(0, 50)) {
      expect(b.ring[0]).toEqual(b.ring[b.ring.length - 1]);
      expect(b.area).toBeGreaterThanOrEqual(40);
    }
  });

  it("block-shape entropy (gate c): quads are < 70% of blocks", () => {
    // Sides = corners with a direction change > 25° (block rings carry
    // near-collinear resample vertices that are not corners).
    const cornersOf = (ring: [number, number][]): number => {
      const n = ring.length - 1;
      let corners = 0;
      for (let i = 0; i < n; i++) {
        const p = ring[(i - 1 + n) % n];
        const q = ring[i];
        const r = ring[(i + 1) % n];
        const a1 = Math.atan2(q[1] - p[1], q[0] - p[0]);
        const a2 = Math.atan2(r[1] - q[1], r[0] - q[0]);
        let d = Math.abs(a2 - a1) % (2 * Math.PI);
        if (d > Math.PI) d = 2 * Math.PI - d;
        if (d > (25 * Math.PI) / 180) corners++;
      }
      return corners;
    };
    let quads = 0;
    for (const b of blocks) {
      if (cornersOf(b.ring as [number, number][]) === 4) quads++;
    }
    expect(blocks.length).toBeGreaterThan(0);
    expect(quads / blocks.length).toBeLessThan(0.7);
  });

  it("alignment (gate d): mean footprint long-axis vs frontage deviation < 15°", () => {
    const cityness = makeCityness(seed, domain);
    const { footprints, stats: pStats } = subdivideBlocks(seed, blocks, PROFILES["euro-medieval"], cityness);
    expect(footprints.length).toBeGreaterThan(100);
    const devs = pStats.alignmentDeviations;
    expect(devs.length).toBe(footprints.length);
    const meanDeg = ((devs.reduce((a, b) => a + b, 0) / devs.length) * 180) / Math.PI;
    expect(meanDeg).toBeLessThan(15);
  });

  it("parcels/footprints are byte-deterministic (gate a)", () => {
    const cityness = makeCityness(seed, domain);
    const a = subdivideBlocks(seed, blocks, PROFILES["euro-medieval"], cityness);
    const b = subdivideBlocks(seed, blocks, PROFILES["euro-medieval"], cityness);
    expect(JSON.stringify(a.parcels)).toBe(JSON.stringify(b.parcels));
    expect(JSON.stringify(a.footprints)).toBe(JSON.stringify(b.footprints));
  });
});

describe("v3.2 wards", () => {
  it("emits a handful of tagged district polygons clipped to the disc", () => {
    const network = net(600, 600);
    const wards = network.filter((f) => f.properties?.generatorId === "city-district");
    expect(wards.length).toBeGreaterThanOrEqual(3);
    expect(wards.length).toBeLessThan(40);
    const tags = new Set(wards.map((w) => String(w.properties?.ward)));
    expect([...tags].every((t) => ["market", "craft", "temple", "slum"].includes(t))).toBe(true);
    expect(wards.some((w) => w.properties?.ward === "market")).toBe(true);
    // Clipped to the disc: every vertex within radius (+ε for the 48-gon chord).
    for (const w of wards) {
      const ring = (w.geometry as GeoJSON.Polygon).coordinates[0] as [number, number][];
      for (const [x, y] of ring) {
        expect(Math.hypot(x - 600, y - 600)).toBeLessThanOrEqual(900 + 0.01);
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
      expect(network.length).toBeLessThan(30000); // incl. blocks/parcels/footprints since v3.2
      expect(network.some((f) => f.properties?.type === "plaza")).toBe(true);
    });
  }
});
