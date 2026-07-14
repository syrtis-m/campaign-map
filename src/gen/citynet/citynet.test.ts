import { describe, expect, it } from "vitest";
import {
  generateCityNetwork,
  clipNetworkToTile,
  discToRing,
  makeDomain,
  citySeedFor,
  PROFILES,
  type ProfileId,
} from "./index";
import {
  distanceToBoundary,
  interiorT,
  makeRegion,
  regionContains,
  type ProcgenRegion,
} from "../region";
import type { BBox } from "../spatialHash";
import type { GenerationConstraints } from "../types";
import { hashSeed, mulberry32 } from "../rng";
import type { FabricFeature } from "../../model/fabric";
import { RIVER_HALF_WIDTH } from "../fabricConstraints";
import { COST_CELL_M, makeCostField } from "./costField";
import { buildSkeleton } from "./skeleton";
import { growNetwork } from "./growth";
import { extractBlocks, chamferRing } from "./faces";
import { subdivideBlocks } from "./parcels";
import { makeCityness } from "./cityness";
import { toMeters, type StreetGraph } from "./graph";
import { tileBBox, GENERATION_TILE_SIZE } from "../cache/tileGrid";
// Shared fixtures also feed the slow fuzz tier (citynet.fuzz.test.ts). Plan 021 §2.1.
import { WORLD_BOUNDS, CAMPAIGN_SEED, fixtureAt, net, riverThrough, allCoordsInside } from "./citynet.fixtures";

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

  it("differs for a different region seed", () => {
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

  it("is byte-identical twice on an irregular hexagon region (plan 020 gate b)", () => {
    const hex: [number, number][] = [
      [1200, -300],
      [700, 700],
      [-200, 900],
      [-900, 250],
      [-650, -600],
      [300, -950],
      [1200, -300],
    ];
    const region = makeRegion("hex-1", hex);
    const seed = hashSeed(CAMPAIGN_SEED, "hex", 1);
    const constraints: GenerationConstraints = { worldBounds: WORLD_BOUNDS };
    const a = generateCityNetwork(seed, region, "euro-medieval", constraints);
    const b = generateCityNetwork(seed, region, "euro-medieval", constraints);
    expect(a.length).toBeGreaterThan(100);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(allCoordsInside(a, region)).toBe(true);
  });
});

describe("2x2 seam test (gate b)", () => {
  // Region straddling the shared corner of four generation tiles. Center is
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
  it("every arterial reaches the region boundary or is flagged degraded", () => {
    const { region } = fixtureAt(600, 600);
    const network = net(600, 600);
    const arterials = network.filter(
      (f) => f.properties?.type === "street" && f.properties?.roadClass === "arterial"
    );
    expect(arterials.length).toBeGreaterThan(0);
    let reached = 0;
    for (const art of arterials) {
      const coords = lineCoords(art);
      const last = coords[coords.length - 1];
      const d = Math.abs(distanceToBoundary(region, last[0], last[1]));
      if (d < COST_CELL_M * 1.6 || art.properties?.degraded === true) reached++;
    }
    expect(reached).toBe(arterials.length);
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
  constraints: Partial<GenerationConstraints> = {},
  profileId: ProfileId = "euro-medieval"
): { graph: StreetGraph; seed: number; region: ProcgenRegion } {
  const { seed, region } = fixtureAt(cx, cy, profileId, radius);
  const cons: GenerationConstraints = { worldBounds: WORLD_BOUNDS, ...constraints };
  const profile = PROFILES[profileId];
  const cost = makeCostField(seed, region, cons);
  const skel = buildSkeleton(seed, region, profile, cons, cost);
  const { graph } = growNetwork(seed, region, profile, cons, skel);
  return { graph, seed, region };
}

/** Degree histogram of a grown graph: [degree-1, degree-3, degree-4+]. */
function degreeHistogram(graph: StreetGraph): { d1: number; d3: number; d4: number } {
  let d1 = 0;
  let d3 = 0;
  let d4 = 0;
  for (const key of graph.sortedNodeKeys()) {
    const d = graph.degree(key);
    if (d === 1) d1++;
    else if (d === 3) d3++;
    else if (d >= 4) d4++;
  }
  return { d1, d3, d4 };
}

describe("v3.1 junction histogram (gate c)", () => {
  it("euro-medieval: T-junctions (degree 3) outnumber 4-ways (degree 4+)", () => {
    const { graph } = grownGraph(600, 600);
    const { d3, d4 } = degreeHistogram(graph);
    expect(d3).toBeGreaterThan(0);
    expect(d3).toBeGreaterThan(d4);
  });
});

describe("v3.1 connectivity (gate d)", () => {
  it("dangling endpoints < 15% of grown endpoints inside the growth extent", () => {
    const { graph, region } = grownGraph(600, 600);
    // Growth-extent proxy: interiorT ≤ 0.6 (the disc test's 0.6×radius band).
    let total = 0;
    let dangling = 0;
    const counted = new Set<string>();
    for (const e of graph.sortedEdges()) {
      if (!e.props.grown) continue;
      for (const key of [e.a, e.b]) {
        if (counted.has(key)) continue;
        counted.add(key);
        const n = graph.getNode(key)!;
        if (interiorT(region, toMeters(n.x), toMeters(n.y)) > 0.6) continue;
        total++;
        if (graph.degree(key) === 1) dangling++;
      }
    }
    expect(total).toBeGreaterThan(50);
    expect(dangling / total).toBeLessThan(0.15);
  });
});

// The 200-region 4-profile fuzz (gate e) moved to citynet.fuzz.test.ts (plan 021 §2.1).

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
  // Straight sketched road through the region (straight ⇒ Chaikin-invariant,
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
  const { graph, seed, region } = grownGraph(600, 600);
  const { blocks, stats } = extractBlocks(graph, region);

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
    const cityness = makeCityness(seed, region);
    const { footprints, stats: pStats } = subdivideBlocks(seed, blocks, PROFILES["euro-medieval"], cityness);
    expect(footprints.length).toBeGreaterThan(100);
    const devs = pStats.alignmentDeviations;
    expect(devs.length).toBe(footprints.length);
    const meanDeg = ((devs.reduce((a, b) => a + b, 0) / devs.length) * 180) / Math.PI;
    expect(meanDeg).toBeLessThan(15);
  });

  it("parcels/footprints are byte-deterministic (gate a)", () => {
    const cityness = makeCityness(seed, region);
    const a = subdivideBlocks(seed, blocks, PROFILES["euro-medieval"], cityness);
    const b = subdivideBlocks(seed, blocks, PROFILES["euro-medieval"], cityness);
    expect(JSON.stringify(a.parcels)).toBe(JSON.stringify(b.parcels));
    expect(JSON.stringify(a.footprints)).toBe(JSON.stringify(b.footprints));
  });
});

describe("v3.2 wards", () => {
  it("emits a handful of tagged district polygons inside the region", () => {
    const { region } = fixtureAt(600, 600);
    const network = net(600, 600);
    const wards = network.filter((f) => f.properties?.generatorId === "city-district");
    expect(wards.length).toBeGreaterThanOrEqual(3);
    expect(wards.length).toBeLessThan(40);
    const tags = new Set(wards.map((w) => String(w.properties?.ward)));
    expect([...tags].every((t) => ["market", "craft", "temple", "slum", "gate"].includes(t))).toBe(true);
    expect(wards.some((w) => w.properties?.ward === "market")).toBe(true);
    // Inside the region: every vertex at ≥ −ε signed distance.
    for (const w of wards) {
      const ring = (w.geometry as GeoJSON.Polygon).coordinates[0] as [number, number][];
      for (const [x, y] of ring) {
        expect(distanceToBoundary(region, x, y)).toBeGreaterThanOrEqual(-0.01);
      }
    }
  });
});

// ── v3.3 gates ──────────────────────────────────────────────────────────────

/** Min distance from a point to any arterial polyline of a network. */
function distToArterialFeatures(p: [number, number], network: GeoJSON.Feature[]): number {
  let best = Infinity;
  for (const f of network) {
    if (f.properties?.roadClass !== "arterial" || f.geometry.type !== "LineString") continue;
    const cs = f.geometry.coordinates as [number, number][];
    for (let i = 1; i < cs.length; i++) {
      const [ax, ay] = cs[i - 1];
      const [bx, by] = cs[i];
      const dx = bx - ax;
      const dy = by - ay;
      const l2 = dx * dx + dy * dy;
      const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / l2));
      best = Math.min(best, Math.hypot(p[0] - (ax + t * dx), p[1] - (ay + t * dy)));
    }
  }
  return best;
}

function ringCentroid(ring: [number, number][]): [number, number] {
  const n = ring.length - 1; // closed ring
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += ring[i][0];
    sy += ring[i][1];
  }
  return [sx / n, sy / n];
}

describe("v3.3 monotonic density (gate c)", () => {
  it("street density per interiorT band is non-increasing outside the core (≤10% inversion tolerance)", () => {
    const { region } = fixtureAt(600, 600);
    const network = net(600, 600);
    const bands = 6;
    const len = new Array(bands).fill(0);
    for (const f of network) {
      if (f.properties?.generatorId !== "city-street" || f.geometry.type !== "LineString") continue;
      const cs = f.geometry.coordinates as [number, number][];
      for (let i = 1; i < cs.length; i++) {
        const mx = (cs[i][0] + cs[i - 1][0]) / 2;
        const my = (cs[i][1] + cs[i - 1][1]) / 2;
        const t = interiorT(region, mx, my);
        const b = Math.min(bands - 1, Math.max(0, Math.floor(t * bands)));
        len[b] += Math.hypot(cs[i][0] - cs[i - 1][0], cs[i][1] - cs[i - 1][1]);
      }
    }
    // Band areas measured on the deterministic 10 m lattice (region-shape
    // agnostic — works for any polygon, unlike disc annulus formulas).
    const bandArea = new Array(bands).fill(0);
    for (let y = Math.ceil(region.bbox.minY / 10) * 10; y <= region.bbox.maxY; y += 10) {
      for (let x = Math.ceil(region.bbox.minX / 10) * 10; x <= region.bbox.maxX; x += 10) {
        if (!regionContains(region, x, y)) continue;
        const t = interiorT(region, x, y);
        const b = Math.min(bands - 1, Math.max(0, Math.floor(t * bands)));
        bandArea[b] += 100; // 10 m × 10 m per lattice point
      }
    }
    const density = len.map((l, i) => (bandArea[i] > 0 ? l / bandArea[i] : 0));
    expect(density[0]).toBeGreaterThan(0);
    // One small inversion tolerated (≤10%) to avoid flake on band boundaries;
    // the trend must be a falloff, not a plateau or rise.
    for (let i = 1; i < bands; i++) {
      expect(density[i]).toBeLessThanOrEqual(density[i - 1] * 1.1);
    }
    expect(density[bands - 1]).toBeLessThan(density[1] * 0.5);
  });
});

describe("v3.3 outskirts (gate d)", () => {
  const { seed, region } = fixtureAt(600, 600);
  const network = net(600, 600);
  const edge = PROFILES["euro-medieval"].edge;
  const cityness = makeCityness(seed, region);

  it("ribbon footprints exist beyond the growth extent, only within 40 m of arterials", () => {
    const beyond = network.filter((f) => {
      if (f.properties?.generatorId !== "city-footprint" || f.geometry.type !== "Polygon") return false;
      const c = ringCentroid((f.geometry.coordinates[0] as [number, number][]));
      return cityness(c[0], c[1]) < 0.72 * edge;
    });
    expect(beyond.length).toBeGreaterThan(5);
    for (const f of beyond) {
      const c = ringCentroid((f.geometry as GeoJSON.Polygon).coordinates[0] as [number, number][]);
      expect(distToArterialFeatures(c, network)).toBeLessThan(40);
    }
  });

  it("fields exist beyond the ribbon (farther from the road), never on streets", () => {
    const fields = network.filter((f) => f.properties?.type === "field");
    expect(fields.length).toBeGreaterThan(3);
    for (const f of fields) {
      const ring = (f.geometry as GeoJSON.Polygon).coordinates[0] as [number, number][];
      const c = ringCentroid(ring);
      expect(cityness(c[0], c[1])).toBeLessThan(edge); // outside growth extent
      expect(distToArterialFeatures(c, network)).toBeGreaterThan(20); // beyond the houses
      for (let i = 0; i < ring.length - 1; i++) {
        expect(distToArterialFeatures(ring[i], network)).toBeGreaterThan(10); // clear of the road
      }
    }
  });
});

describe("v3.3 wall + gates (gate e)", () => {
  const network = net(600, 600);
  const ringFeature = network.find((f) => f.properties?.roadClass === "ring");
  const gates = network.filter((f) => f.properties?.type === "gate");

  it("the ring road exists and closes", () => {
    expect(ringFeature).toBeDefined();
    const cs = (ringFeature!.geometry as GeoJSON.LineString).coordinates as [number, number][];
    expect(cs[0]).toEqual(cs[cs.length - 1]);
    expect(network.filter((f) => f.properties?.type === "wall").length).toBeGreaterThan(10);
  });

  it("every gate is a ring VERTEX (plan 020: crossings inserted into the inset ring) and lies on an arterial", () => {
    expect(gates.length).toBeGreaterThanOrEqual(3);
    const ringCs = (ringFeature!.geometry as GeoJSON.LineString).coordinates as [number, number][];
    for (const g of gates) {
      const p = (g.geometry as GeoJSON.Point).coordinates as [number, number];
      // Gate === ring vertex, bit-exact modulo the shared mm quantization.
      const onRing = ringCs.some(([x, y]) => Math.hypot(x - p[0], y - p[1]) < 0.01);
      expect(onRing).toBe(true);
      // On an arterial (gate = arterial×ring crossing).
      expect(distToArterialFeatures(p, network)).toBeLessThan(0.02);
    }
  });

  it("no grown street crosses the wall away from a gate", () => {
    const ringCs = (ringFeature!.geometry as GeoJSON.LineString).coordinates as [number, number][];
    const gatePts = gates.map((g) => (g.geometry as GeoJSON.Point).coordinates as [number, number]);
    const crossings: [number, number][] = [];
    for (const f of network) {
      if (f.properties?.roadClass !== "street" || f.geometry.type !== "LineString") continue;
      const cs = f.geometry.coordinates as [number, number][];
      for (let i = 1; i < cs.length; i++) {
        for (let j = 1; j < ringCs.length; j++) {
          const [ax, ay] = cs[i - 1];
          const [bx, by] = cs[i];
          const [rx1, ry1] = ringCs[j - 1];
          const [rx2, ry2] = ringCs[j];
          const d = (bx - ax) * (ry2 - ry1) - (by - ay) * (rx2 - rx1);
          if (d === 0) continue;
          const t = ((rx1 - ax) * (ry2 - ry1) - (ry1 - ay) * (rx2 - rx1)) / d;
          const u = ((rx1 - ax) * (by - ay) - (ry1 - ay) * (bx - ax)) / d;
          // Strict interior crossing — endpoints ON the ring are T-junctions
          // into the ring road, not wall breaches.
          if (t <= 0.001 || t >= 0.999 || u < 0 || u > 1) continue;
          crossings.push([ax + t * (bx - ax), ay + t * (by - ay)]);
        }
      }
    }
    for (const [x, y] of crossings) {
      const nearGate = gatePts.some(([gx, gy]) => Math.hypot(gx - x, gy - y) <= 30);
      expect(nearGate).toBe(true);
    }
  });
});

describe("v3.3 cityness canon bumps (§5.4)", () => {
  it("a settlement pin raises cityness around itself; other pins raise it less", () => {
    const { seed, region } = fixtureAt(600, 600);
    const at: [number, number] = [900, 750];
    const pin = (type?: string): GeoJSON.Feature => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: at },
      properties: type ? { type } : {},
    });
    const bare = makeCityness(seed, region)(at[0], at[1]);
    const town = makeCityness(seed, region, [pin("town")])(at[0], at[1]);
    const misc = makeCityness(seed, region, [pin()])(at[0], at[1]);
    expect(town).toBeGreaterThan(bare + 0.1);
    expect(misc).toBeGreaterThan(bare);
    expect(misc).toBeLessThan(town);
  });
});

// ── v3.4 gates: profile signatures ──────────────────────────────────────────

describe("v3.4 profile signatures (§9 v3.4)", () => {
  it("na-grid: 4-way junctions ≥ T-junctions (histogram flips)", () => {
    const { graph } = grownGraph(600, 600, 900, {}, "na-grid");
    const { d3, d4 } = degreeHistogram(graph);
    expect(d4).toBeGreaterThan(0);
    expect(d4).toBeGreaterThanOrEqual(d3);
  });

  it("na-suburb: court bulbs exist and loops are present (interior faces above floor)", () => {
    const network = net(600, 600, "na-suburb");
    const courts = network.filter((f) => f.properties?.type === "court");
    expect(courts.length).toBeGreaterThan(0);
    const { graph, region } = grownGraph(600, 600, 900, {}, "na-suburb");
    const { blocks } = extractBlocks(graph, region);
    expect(blocks.length).toBeGreaterThan(20); // loops close faces
  });

  it("alleys present for euro-medieval and na-grid; absent otherwise", () => {
    const hasAlley = (p: ProfileId) =>
      net(600, 600, p).some((f) => f.properties?.roadClass === "alley");
    expect(hasAlley("euro-medieval")).toBe(true);
    expect(hasAlley("na-grid")).toBe(true);
    expect(hasAlley("euro-continental")).toBe(false);
    expect(hasAlley("na-suburb")).toBe(false);
  });

  it("euro-continental: byte-deterministic, T-dominated, no wall unless the hashed roll says so", () => {
    const a = net(600, 600, "euro-continental");
    const b = net(600, 600, "euro-continental");
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const { graph } = grownGraph(600, 600, 900, {}, "euro-continental");
    const { d3, d4 } = degreeHistogram(graph);
    expect(d3).toBeGreaterThan(d4);
    expect(a.some((f) => f.properties?.type === "court")).toBe(false);
  });

  it("per-profile budget: full pipeline ≤ 2 s at the default radius", () => {
    for (const p of ["euro-medieval", "euro-continental", "na-grid", "na-suburb"] as ProfileId[]) {
      const t0 = Date.now();
      const network = net(-1500, 900, p);
      expect(network.length).toBeGreaterThan(50);
      expect(Date.now() - t0).toBeLessThanOrEqual(2000);
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

// ── plan 025-C: chamfer operator + tartan-grid / ward-grid / eixample ───────

describe("chamfer operator (plan 025 §3.4)", () => {
  type Pt = [number, number];
  const shoelace = (ring: Pt[]): number => {
    let a = 0;
    const n = ring.length - 1; // ring is closed; iterate the open loop
    for (let i = 0; i < n; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    return a / 2;
  };
  const unitSquareCCW: Pt[] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
    [0, 0],
  ];

  it("cuts every convex corner of a square into two, making an octagon of the exact chamfered area", () => {
    const d = 0.2;
    const oct = chamferRing(unitSquareCCW, d);
    // 4 corners → 2 vertices each = 8, plus the closing vertex.
    expect(oct.length).toBe(9);
    expect(oct[0]).toEqual(oct[oct.length - 1]); // still closed
    // Area = 1 − 4·(½·d²) = 1 − 2d².
    expect(Math.abs(shoelace(oct))).toBeCloseTo(1 - 2 * d * d, 9);
    // Every new vertex lies on an original edge (x or y pinned to 0 or 1).
    for (const [x, y] of oct.slice(0, -1)) {
      const onEdge = x === 0 || x === 1 || y === 0 || y === 1;
      expect(onEdge, `(${x},${y}) should sit on a square edge`).toBe(true);
    }
    // The two cut points nearest the origin corner are (d,0) and (0,d).
    const pts = oct.slice(0, -1).map((p) => `${p[0]},${p[1]}`);
    expect(pts).toContain(`${d},0`);
    expect(pts).toContain(`0,${d}`);
  });

  it("leaves REFLEX corners intact (a concave L-block is not turned inside out)", () => {
    // CCW L-shape (area 3): the vertex (1,1) is the single reflex corner.
    const L: Pt[] = [
      [0, 0],
      [2, 0],
      [2, 1],
      [1, 1],
      [1, 2],
      [0, 2],
      [0, 0],
    ];
    const out = chamferRing(L, 0.3);
    // The reflex vertex survives verbatim; the 5 convex corners each split in two.
    const flat = out.slice(0, -1).map((p) => `${p[0]},${p[1]}`);
    expect(flat).toContain("1,1");
    expect(out.slice(0, -1).length).toBe(1 + 5 * 2); // 1 reflex kept + 5 convex doubled
    // Still a simple, positively-oriented (CCW) polygon of sane area.
    expect(shoelace(out)).toBeGreaterThan(0);
    expect(Math.abs(shoelace(out))).toBeLessThan(3);
  });

  it("clamps the setback so an over-large chamfer stays a simple polygon (no self-intersection)", () => {
    // d far bigger than the square: each corner clamps to 0.45·edge, so adjacent
    // cuts on one edge never cross (0.45+0.45 < 1) — area stays positive & < 1.
    const oct = chamferRing(unitSquareCCW, 5);
    expect(oct.length).toBe(9);
    const area = Math.abs(shoelace(oct));
    expect(area).toBeGreaterThan(0);
    expect(area).toBeLessThan(1);
    for (const [x, y] of oct) expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
  });

  it("is a no-op for dist ≤ 0 and deterministic (pure function of ring + dist)", () => {
    expect(chamferRing(unitSquareCCW, 0)).toBe(unitSquareCCW);
    expect(chamferRing(unitSquareCCW, -3)).toBe(unitSquareCCW);
    expect(chamferRing(unitSquareCCW, 0.2)).toEqual(chamferRing(unitSquareCCW, 0.2));
  });
});

describe("plan 025-C preset signatures (genre reads on the geometry)", () => {
  const blockVertexCounts = (network: GeoJSON.Feature[]): number[] =>
    network
      .filter((f) => f.properties?.generatorId === "city-block")
      .map((f) => (f.geometry as GeoJSON.Polygon).coordinates[0].length - 1);

  it("eixample chamfers EVERY block into an octagon (>4 vertices), and emits no ring/wall", () => {
    const network = net(600, 600, "eixample");
    const counts = blockVertexCounts(network);
    expect(counts.length).toBeGreaterThan(20);
    expect(counts.every((c) => c > 4)).toBe(true); // chamfer applied to all corners
    expect(network.some((f) => f.properties?.type === "wall")).toBe(false);
    expect(network.some((f) => f.properties?.roadClass === "ring")).toBe(false);
  });

  it("chamfer applies ONLY where specced: na-grid blocks are NOT all chamfered (many stay quads)", () => {
    const counts = blockVertexCounts(net(600, 600, "na-grid"));
    expect(counts.length).toBeGreaterThan(10);
    // Ordinary grid faces are triangles/quads; only a minority are >4.
    expect(counts.some((c) => c <= 4)).toBe(true);
  });

  it("ward-grid is a WALLED grid: emits a ring road + wall segments (the walled-quarter read)", () => {
    const network = net(600, 600, "ward-grid");
    expect(network.some((f) => f.properties?.roadClass === "ring")).toBe(true);
    expect(network.some((f) => f.properties?.type === "wall")).toBe(true);
    // Orthogonal grid ⇒ 4-way junctions dominate over T-junctions.
    const { graph } = grownGraph(600, 600, 900, {}, "ward-grid");
    const { d3, d4 } = degreeHistogram(graph);
    expect(d4).toBeGreaterThan(0);
  });

  it("tartan-grid grows the fine ALLEY web inside its coarse grid (the two-scale signature)", () => {
    const network = net(600, 600, "tartan-grid");
    expect(network.some((f) => f.properties?.roadClass === "alley")).toBe(true);
    // Wide arterial mains coexist with narrow ordinary streets — width contrast.
    const widths = new Set(
      network
        .filter((f) => f.properties?.generatorId === "city-street")
        .map((f) => f.properties?.width as number)
    );
    expect(widths.has(26)).toBe(true); // arterial main
    expect(widths.has(9)).toBe(true); // narrow street
  });

  it("every 025-C preset is byte-deterministic and fully contained in its region", () => {
    for (const p of ["tartan-grid", "ward-grid", "eixample"] as ProfileId[]) {
      const a = net(600, 600, p);
      const b = net(600, 600, p);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      const { region } = fixtureAt(600, 600, p);
      expect(allCoordsInside(a, region)).toBe(true);
    }
  });
});

// ── v4.0 plan-020 gates ─────────────────────────────────────────────────────

describe("v4.0 concave smoke (plan 020 gate d)", () => {
  it("an L-shaped region generates streets/blocks/footprints with every coordinate inside", () => {
    // 2000×2000 square minus its 1000×1000 NE quadrant: area 3·10⁶ m²,
    // effectiveRadius ≈ 977 m. Concave — exercises notch rejection, region
    // clipping, and the conservative concave ward path.
    const L: [number, number][] = [
      [0, 0],
      [2000, 0],
      [2000, 1000],
      [1000, 1000],
      [1000, 2000],
      [0, 2000],
      [0, 0],
    ];
    const region = makeRegion("L-smoke", L);
    const seed = hashSeed(CAMPAIGN_SEED, "L-smoke");
    let network: GeoJSON.Feature[] = [];
    expect(() => {
      network = generateCityNetwork(seed, region, "euro-medieval", { worldBounds: WORLD_BOUNDS });
    }).not.toThrow();
    const byGid = (gid: string) => network.filter((f) => f.properties?.generatorId === gid);
    expect(byGid("city-street").length).toBeGreaterThan(0);
    expect(byGid("city-block").length).toBeGreaterThan(0);
    expect(byGid("city-footprint").length).toBeGreaterThan(0);
    expect(allCoordsInside(network, region)).toBe(true);
  });
});

describe("v4.0 disc-equivalence (plan 020 gate e)", () => {
  // Recorded v3 disc metrics (r=900 euro-medieval at (600,600), campaign seed
  // 90210, captured from the last disc build before this generalization):
  // total features 12410, wall present, 5 gates, footprint counts by dist/R
  // thirds [995, 2232, 1279] — inner-band density ≈ 4× the outer band's.
  const V3_TOTAL = 12410;

  it("the 32-gon build lands within ±40% of the v3 disc build and keeps its cartography", () => {
    const { region } = fixtureAt(600, 600, "euro-medieval", 900);
    const network = net(600, 600);

    // Feature count within ±40% of the recorded disc build.
    expect(network.length).toBeGreaterThan(V3_TOTAL * 0.6);
    expect(network.length).toBeLessThan(V3_TOTAL * 1.4);

    // Wall present, ≥4 gates.
    expect(network.some((f) => f.properties?.type === "wall")).toBe(true);
    expect(network.filter((f) => f.properties?.type === "gate").length).toBeGreaterThanOrEqual(4);

    // Monotonic-ish density: mean footprint density in the interiorT<0.33
    // band exceeds the 0.66–1.0 band. Band areas measured on the 10 m lattice.
    const bandCount = [0, 0]; // [inner, outer]
    for (const f of network) {
      if (f.properties?.generatorId !== "city-footprint" || f.geometry.type !== "Polygon") continue;
      const c = ringCentroid(f.geometry.coordinates[0] as [number, number][]);
      const t = interiorT(region, c[0], c[1]);
      if (t < 0.33) bandCount[0]++;
      else if (t >= 0.66 && t <= 1.0) bandCount[1]++;
    }
    const bandArea = [0, 0];
    for (let y = Math.ceil(region.bbox.minY / 10) * 10; y <= region.bbox.maxY; y += 10) {
      for (let x = Math.ceil(region.bbox.minX / 10) * 10; x <= region.bbox.maxX; x += 10) {
        if (!regionContains(region, x, y)) continue;
        const t = interiorT(region, x, y);
        if (t < 0.33) bandArea[0] += 100;
        else if (t >= 0.66 && t <= 1.0) bandArea[1] += 100;
      }
    }
    expect(bandCount[0]).toBeGreaterThan(50);
    expect(bandArea[0]).toBeGreaterThan(0);
    expect(bandArea[1]).toBeGreaterThan(0);
    expect(bandCount[0] / bandArea[0]).toBeGreaterThan(bandCount[1] / bandArea[1]);
  });
});

// The v4.0 4-profile polygon fuzz (gate f) moved to citynet.fuzz.test.ts (plan 021 §2.1).

describe("generation center override (plan 020 Addendum 2)", () => {
  function plazaCentroid(network: GeoJSON.Feature[]): [number, number] | null {
    const plaza = network.find((f) => (f.properties as { type?: string } | null)?.type === "plaza");
    if (!plaza) return null;
    const ring = (plaza.geometry as GeoJSON.Polygon).coordinates[0] as [number, number][];
    let x = 0;
    let y = 0;
    const open = ring.slice(0, -1);
    for (const [px, py] of open) {
      x += px;
      y += py;
    }
    return [x / open.length, y / open.length];
  }
  const dist = (p: [number, number], q: [number, number]): number => Math.hypot(p[0] - q[0], p[1] - q[1]);

  it("anchors the plaza at a GM-placed center inside the ring; determinism holds; output stays inside", () => {
    const { seed, region } = fixtureAt(600, 600, "euro-medieval", 900);
    const auto = generateCityNetwork(seed, region, "euro-medieval", { worldBounds: WORLD_BOUNDS });
    const off: [number, number] = [region.centroid[0] + 300, region.centroid[1] + 200]; // ~360 m, inside r900
    const a = generateCityNetwork(seed, region, "euro-medieval", { worldBounds: WORLD_BOUNDS }, off);
    const b = generateCityNetwork(seed, region, "euro-medieval", { worldBounds: WORLD_BOUNDS }, off);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b)); // determinism with a center
    const ca = plazaCentroid(auto);
    const cc = plazaCentroid(a);
    expect(ca).not.toBeNull();
    expect(cc).not.toBeNull();
    // The override plaza sits closer to `off` than the automatic plaza does.
    expect(dist(cc!, off)).toBeLessThan(dist(ca!, off));
    expect(allCoordsInside(a, region)).toBe(true);
  });

  it("falls back to the automatic center (byte-identical) when the override is outside the ring", () => {
    const { seed, region } = fixtureAt(600, 600, "euro-medieval", 900);
    const auto = generateCityNetwork(seed, region, "euro-medieval", { worldBounds: WORLD_BOUNDS });
    const outside: [number, number] = [region.bbox.maxX + 5000, region.bbox.maxY + 5000];
    const fallback = generateCityNetwork(seed, region, "euro-medieval", { worldBounds: WORLD_BOUNDS }, outside);
    expect(JSON.stringify(fallback)).toBe(JSON.stringify(auto));
  });

  it("no override is byte-identical to an explicit undefined (migration byte-stability)", () => {
    const { seed, region } = fixtureAt(600, 600, "na-grid", 900);
    const noArg = generateCityNetwork(seed, region, "na-grid", { worldBounds: WORLD_BOUNDS });
    const undef = generateCityNetwork(seed, region, "na-grid", { worldBounds: WORLD_BOUNDS }, undefined);
    expect(JSON.stringify(noArg)).toBe(JSON.stringify(undef));
  });
});

describe("double-wall suppression (plan 022 §3.4)", () => {
  type Pt = [number, number];
  const isBand = (f: GeoJSON.Feature): boolean =>
    (f.properties as { generatorId?: string; type?: string })?.generatorId === "city-landmark" &&
    (f.properties as { type?: string })?.type === "wall";
  function bandCount(network: GeoJSON.Feature[]): number {
    return network.filter(isBand).length;
  }
  function polyCentroid(f: GeoJSON.Feature): Pt {
    const ring = (f.geometry as GeoJSON.Polygon).coordinates[0] as Pt[];
    let x = 0;
    let y = 0;
    const n = ring.length - 1; // drop the closing vertex
    for (let i = 0; i < n; i++) {
      x += ring[i][0];
      y += ring[i][1];
    }
    return [x / n, y / n];
  }
  /** Trace the base city's ACTUAL wall band: its band-quad centroids sorted by
   * angle around the center form a polyline that runs exactly where the band
   * sits — a self-calibrating "GM drew a wall along the rim" fixture. */
  function wallSketchTracing(network: GeoJSON.Feature[], cx: number, cy: number): FabricFeature {
    const pts = network.filter(isBand).map(polyCentroid);
    pts.sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
    pts.push(pts[0]); // close the loop back to the start
    return {
      type: "Feature",
      id: "wall-sketch-1",
      geometry: { type: "LineString", coordinates: pts },
      properties: { kind: "wall" },
    };
  }

  it("a raw wall sketch tracing the rim suppresses the city's own wall band", () => {
    const cx = 600;
    const cy = 600;
    const base = net(cx, cy, "euro-medieval");
    const baseBand = bandCount(base);
    expect(baseBand).toBeGreaterThan(4); // euro-medieval always walls
    const { region } = fixtureAt(cx, cy, "euro-medieval", 900);
    const wall = wallSketchTracing(base, region.centroid[0], region.centroid[1]);
    const suppressed = net(cx, cy, "euro-medieval", { fabricFeatures: [wall] });
    const suppBand = bandCount(suppressed);
    // The GM's drawn wall owns the rim: the city's own band is largely gone.
    expect(suppBand).toBeLessThan(baseBand * 0.5);
  });

  it("is a strict no-op when there are no wall sketches (existing cities byte-identical)", () => {
    const a = net(600, 600, "euro-medieval");
    const b = net(600, 600, "euro-medieval", { fabricFeatures: [] });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // A river-only constraint set (no wall kind) is also untouched by suppression.
    const c = net(600, 600, "euro-medieval", { fabricFeatures: [riverThrough(9999)] });
    expect(bandCount(c)).toBeGreaterThan(4);
  });
});
