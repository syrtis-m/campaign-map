/**
 * Vailmarch showcase campaign — fixture contract + coupling-proof tests. Two
 * families:
 *
 *  A. PREMISE — the geometry actually overlaps / nests / adjoins as the demo
 *     claims (river crosses district, park nested, twins share an edge exactly,
 *     forests over mountains, hedgerow adjacencies …), the whole collection is
 *     zod-valid at each algorithm's CURRENT version, and two builds are
 *     byte-identical. A future coordinate tweak that silently breaks a demo
 *     relationship fails HERE.
 *
 *  B. GENERATION-PROOF — the demo's whole point: headlessly generate the actual
 *     campaign regions (scaled to generation-space meters, EXACTLY as the host
 *     would) through the registry and assert the coupling SIGNATURES are
 *     present. This is what makes the demo trustworthy without a screenshot.
 *
 * All coordinates in the generation-proof family are METERS (the space
 * generators + terrainAt consume); the premise family works in meters too (the
 * geometry source is authored in meters).
 */
import { describe, it, expect } from "vitest";
import {
  FabricCollectionSchema,
  FabricFeatureSchema,
  isProcgenRegion,
  type FabricFeature,
} from "../../model/fabric";
import { algorithmById } from "../procgen/registry";
import { makeRegion, makeCorridorRegion, makeSpine, regionContains, distanceToBoundary } from "../region";
import { pointInRingClosed, signedDistancePolygon, distanceToPolyline } from "../fields/sdf";
import { terrainAt, macroTerrainField } from "../fields/terrain";
import { hashSeed } from "../rng";
import type { GenerationConstraints, UpstreamArtifacts } from "../types";
import type { BBox } from "../spatialHash";
import {
  buildVailmarchFabric,
  buildVailmarchFabricMeters,
  defById,
  metersOf,
  seedFor,
  VAILMARCH_BOUNDS,
  VAILMARCH_CAMPAIGN_SEED,
  VAILMARCH_PINS,
  VAILMARCH_SCALE_M_PER_UNIT,
} from "./vailmarch";

type Pt = [number, number];

const WORLD: BBox = { minX: -6000, minY: -5000, maxX: 6000, maxY: 5000 };

// ─── Local geometry helpers ──────────────────────────────────────────────────

function segmentsIntersect(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const cross = (o: Pt, p: Pt, q: Pt): number => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Number of ring edges a polyline properly crosses. */
function polylineRingCrossings(line: readonly Pt[], closedRing: Pt[]): number {
  let n = 0;
  for (let i = 0; i < line.length - 1; i++) {
    for (let j = 0; j < closedRing.length - 1; j++) {
      if (segmentsIntersect(line[i], line[i + 1], closedRing[j], closedRing[j + 1])) n++;
    }
  }
  return n;
}

function ringsDisjoint(a: Pt[], b: Pt[]): boolean {
  for (const p of a) if (pointInRingClosed(b, p[0], p[1])) return false;
  for (const p of b) if (pointInRingClosed(a, p[0], p[1])) return false;
  for (let i = 0; i < a.length - 1; i++)
    for (let j = 0; j < b.length - 1; j++)
      if (segmentsIntersect(a[i], a[i + 1], b[j], b[j + 1])) return false;
  return true;
}

function ringsOverlap(a: Pt[], b: Pt[]): boolean {
  return !ringsDisjoint(a, b);
}

/** Closed meter ring of a polygon def. */
function ringM(id: string): Pt[] {
  const open = metersOf(id);
  return [...open, open[0]];
}

/** Index of an EXACT vertex (corner anchor) in an open ring, else −1. */
function vertexIndex(openRing: Pt[], p: Pt): number {
  for (let i = 0; i < openRing.length; i++) if (openRing[i][0] === p[0] && openRing[i][1] === p[1]) return i;
  return -1;
}

/**
 * The vertex run of the DIRECT (shorter-arc) edge between two corner anchors `a`
 * and `b` of a closed ring, normalized to a→b order (so the SAME shared edge read
 * from two rings that traverse it in opposite directions compares deep-equal).
 * This is how the organic-boundary premises assert a shared edge is bit-identical
 * on both rings — the endpoint-keyed jitter guarantees identical inserted vertices.
 */
function edgeRun(ringClosed: Pt[], a: Pt, b: Pt): Pt[] {
  const open = ringClosed.slice(0, -1); // drop the closing duplicate
  const n = open.length;
  const ia = vertexIndex(open, a);
  const ib = vertexIndex(open, b);
  if (ia < 0 || ib < 0) throw new Error(`edgeRun: corner not found (${a} / ${b})`);
  const fwd: Pt[] = [];
  for (let k = ia; ; k = (k + 1) % n) {
    fwd.push(open[k]);
    if (k === ib) break;
  }
  const bwd: Pt[] = [];
  for (let k = ia; ; k = (k - 1 + n) % n) {
    bwd.push(open[k]);
    if (k === ib) break;
  }
  return fwd.length <= bwd.length ? fwd : bwd;
}

/** A polygon region built from a def's meter ring (as the host would). */
function polyRegion(id: string) {
  return makeRegion(id, ringM(id));
}

/** A line-kind corridor region built from a def's meter spine. */
function corridorRegion(id: string) {
  const def = defById(id);
  const alg = algorithmById(def.algorithm!)!;
  const maxOffset = alg.corridorMaxOffset ? alg.corridorMaxOffset(def.params ?? {}) : 0;
  return makeCorridorRegion(id, makeSpine(id, metersOf(id)), maxOffset);
}

/** Generate a def's region through the registry. */
function generate(id: string, constraints: Partial<GenerationConstraints> = {}): GeoJSON.Feature[] {
  const def = defById(id);
  const alg = algorithmById(def.algorithm!)!;
  const region = def.shape === "poly" ? polyRegion(id) : corridorRegion(id);
  return alg.generate(seedFor(id), region, def.params ?? {}, { worldBounds: WORLD, ...constraints });
}

/** Meter sketch feature (with its procgen block) for a def — the raw-sketch
 * constraint the generators read. */
function sketchM(id: string): FabricFeature {
  return buildVailmarchFabricMeters().find((f) => f.id === id)!;
}

const gidOf = (f: GeoJSON.Feature): string => (f.properties as { generatorId?: string } | null)?.generatorId ?? "";
const ofGid = (feats: GeoJSON.Feature[], gid: string): GeoJSON.Feature[] => feats.filter((f) => gidOf(f) === gid);

// The shared geometry anchors (meters) the demo relies on.
const CAPITAL = ringM("vm-district-capital");
const VAIL = metersOf("vm-river-vail");

// ═══════════════════════════════════════════════════════════════════════════
// A. PREMISE FAMILY
// ═══════════════════════════════════════════════════════════════════════════

const fabric = buildVailmarchFabric();
const meterFeats = buildVailmarchFabricMeters();

describe("vailmarch — validity", () => {
  it("the whole collection parses under the Fabric.geojson schema", () => {
    expect(() => FabricCollectionSchema.parse(fabric)).not.toThrow();
  });

  it("every map-unit feature parses and stays inside the campaign bounds", () => {
    const [minX, minY, maxX, maxY] = VAILMARCH_BOUNDS;
    for (const f of fabric.features) {
      expect(() => FabricFeatureSchema.parse(f)).not.toThrow();
      const coords: Pt[] =
        f.geometry.type === "Polygon" ? (f.geometry.coordinates[0] as Pt[]) : (f.geometry.coordinates as Pt[]);
      for (const [x, y] of coords) {
        expect(x, `${f.id} x`).toBeGreaterThanOrEqual(minX);
        expect(x, `${f.id} x`).toBeLessThanOrEqual(maxX);
        expect(y, `${f.id} y`).toBeGreaterThanOrEqual(minY);
        expect(y, `${f.id} y`).toBeLessThanOrEqual(maxY);
      }
    }
  });

  it("every procgen feature pins a registry-valid block at the algorithm's currentVersion", () => {
    for (const f of fabric.features) {
      if (f.properties.kind === "road") {
        expect(isProcgenRegion(f), `${f.id}: roads are inert sketch, no procgen`).toBe(false);
        continue;
      }
      expect(isProcgenRegion(f), `${f.id} must carry a procgen block`).toBe(true);
      const block = f.properties.procgen!;
      const alg = algorithmById(block.algorithm);
      expect(alg, `${f.id}: unknown algorithm ${block.algorithm}`).toBeDefined();
      expect(alg!.appliesTo, `${f.id}: ${block.algorithm} !applies ${f.properties.kind}`).toContain(f.properties.kind);
      expect(block.version, `${f.id}: version must pin currentVersion`).toBe(alg!.currentVersion);
      expect(() => alg!.paramsSchema.parse(block.params), `${f.id}: params rejected`).not.toThrow();
      expect(block.seed).toBe(hashSeed(VAILMARCH_CAMPAIGN_SEED, f.id));
      if (block.presetId !== undefined) {
        expect(
          alg!.presets.some((p) => p.id === block.presetId),
          `${f.id}: presetId ${block.presetId} not a preset of ${block.algorithm}`
        ).toBe(true);
      }
    }
  });

  it("counts meet the demo brief (≥3 cities, 5 farmland, 5 forests, 4 rivers, 3 walls, 3 roads)", () => {
    const count = (kind: string): number => fabric.features.filter((f) => f.properties.kind === kind).length;
    expect(count("district")).toBeGreaterThanOrEqual(3);
    expect(count("farmland")).toBeGreaterThanOrEqual(5);
    expect(count("forest")).toBeGreaterThanOrEqual(5);
    expect(count("river")).toBeGreaterThanOrEqual(4);
    expect(count("wall")).toBeGreaterThanOrEqual(3);
    expect(count("road")).toBeGreaterThanOrEqual(3);
    // Terrain is RELIEF/LANDFORM stamps only — the ruling retired mountain polygons.
    expect(count("relief")).toBeGreaterThanOrEqual(4); // Marchspine + Cairn/Haward arms + Vail valley
    expect(count("landform")).toBeGreaterThanOrEqual(1);
    expect(count("mountain")).toBe(0);
    expect(count("park")).toBeGreaterThanOrEqual(2);
  });
});

describe("vailmarch — stability", () => {
  it("two builds are byte-identical JSON", () => {
    expect(JSON.stringify(buildVailmarchFabric())).toBe(JSON.stringify(fabric));
    expect(JSON.stringify(buildVailmarchFabricMeters())).toBe(JSON.stringify(meterFeats));
  });

  it("feature ids are unique", () => {
    expect(new Set(fabric.features.map((f) => f.id)).size).toBe(fabric.features.length);
  });
});

describe("vailmarch — premises (meters)", () => {
  it("the Vail crosses the capital district (enters + exits)", () => {
    expect(polylineRingCrossings(VAIL, CAPITAL)).toBe(2);
    const inside = VAIL.filter(([x, y]) => pointInRingClosed(CAPITAL, x, y));
    expect(inside.length).toBeGreaterThanOrEqual(1);
  });

  it("Kingsmoot Green nests strictly inside the capital (≥30 m margin)", () => {
    for (const [x, y] of ringM("vm-park-capital")) {
      expect(signedDistancePolygon(CAPITAL, x, y)).toBeGreaterThanOrEqual(30);
    }
  });

  it("the market pin sits strictly inside the capital", () => {
    const market = VAILMARCH_PINS.find((p) => p.type === "market")!;
    expect(pointInRingClosed(CAPITAL, market.point[0], market.point[1])).toBe(true);
  });

  it("Twinbridge + Eastwool share their organic common edge exactly (ε = 0), interiors disjoint", () => {
    const a = ringM("vm-district-twin-a");
    const b = ringM("vm-district-twin-b");
    const p: Pt = [2100, -800];
    const q: Pt = [2100, -100];
    // The shared edge is an IRREGULAR polyline (corners + seeded jitter), yet it is
    // bit-identical on both rings — the endpoint-keyed jitter is the 038 stub demo.
    expect(edgeRun(a, p, q)).toEqual(edgeRun(b, p, q));
    expect(edgeRun(a, p, q).length).toBeGreaterThan(2); // truly irregular, not a bare segment
    expect(polylineRingCrossings(a, b)).toBe(0);
    // No twin-b vertex strictly inside twin-a (adjacency, never overlap).
    for (const [x, y] of b.slice(0, -1)) expect(signedDistancePolygon(a, x, y)).toBeLessThanOrEqual(1e-9);
  });

  it("both tributaries confluence onto the Vail spine (mouth within CONFLUENCE_SNAP_M)", () => {
    const north = metersOf("vm-river-trib-north");
    const east = metersOf("vm-river-trib-east");
    const dN = distanceToPolyline(VAIL, north[north.length - 1][0], north[north.length - 1][1]);
    const dE = distanceToPolyline(VAIL, east[east.length - 1][0], east[east.length - 1][1]);
    expect(dN).toBeLessThanOrEqual(30);
    expect(dE).toBeLessThanOrEqual(30);
    // Torrent Beck rises in the raised head of the valley — its source sits within
    // the Marchspine ridge's half-width (600 m), so it reads real relief.
    expect(distanceToPolyline(metersOf("vm-relief-spine"), north[0][0], north[0][1])).toBeLessThanOrEqual(600);
  });

  it("the relief spurs thread the wood/paddy/pasture, and rivers cross the farms/forests they pair with", () => {
    const westSpur = metersOf("vm-relief-west-spur");
    const eastSpur = metersOf("vm-relief-east-spur");
    // The Cairn Arm runs through Cairnwood AND the Cairnfoot paddy (a spine vertex
    // inside each) — the relief that drives the timberline + the paddy contours.
    expect(westSpur.some(([x, y]) => pointInRingClosed(ringM("vm-forest-spine"), x, y))).toBe(true);
    expect(westSpur.some(([x, y]) => pointInRingClosed(ringM("vm-farm-paddy"), x, y))).toBe(true);
    // The Haward Arm runs through the Hoarfell pasture (its slope-gate driver).
    expect(eastSpur.some(([x, y]) => pointInRingClosed(ringM("vm-farm-flank"), x, y))).toBe(true);
    // Riparian forest + riverine farm sit over their rivers (spine crosses ring).
    expect(polylineRingCrossings(VAIL, ringM("vm-forest-riparian"))).toBeGreaterThanOrEqual(1);
    expect(polylineRingCrossings(metersOf("vm-river-marn"), ringM("vm-farm-riverine"))).toBeGreaterThanOrEqual(1);
  });

  it("hedgerow adjacencies: Hollowbrake shares organic edges with Merewood Common and the crofts (bit-identical, within HEDGE_ADJ_EPS)", () => {
    const forest = ringM("vm-forest-hedge");
    const park = ringM("vm-park-rural");
    const croft = ringM("vm-farm-hedge");
    // Forest east edge (−600, −2100)→(−600, −1550) == park west edge; forest north
    // edge (−1200, −1550)→(−600, −1550) == croft south edge. Each shared edge is an
    // irregular polyline, IDENTICAL on both rings (ε = 0 ≤ HEDGE_ADJ_EPS), so the
    // symmetric hedgerow operator fires from either side.
    expect(edgeRun(forest, [-600, -2100], [-600, -1550])).toEqual(edgeRun(park, [-600, -2100], [-600, -1550]));
    expect(edgeRun(forest, [-1200, -1550], [-600, -1550])).toEqual(edgeRun(croft, [-1200, -1550], [-600, -1550]));
  });

  it("peri-urban belts share their city's organic edge; the East Road pierces the capital and reaches Twinbridge", () => {
    // The belt's north edge is the capital's south edge, bit-identical (organic).
    expect(edgeRun(CAPITAL, [-1950, -150], [-1050, -150])).toEqual(
      edgeRun(ringM("vm-farm-capital-belt"), [-1950, -150], [-1050, -150])
    );
    expect(edgeRun(ringM("vm-district-twin-a"), [1500, -800], [2100, -800])).toEqual(
      edgeRun(ringM("vm-farm-twin-belt"), [1500, -800], [2100, -800])
    );
    const road = metersOf("vm-road-highway");
    expect(polylineRingCrossings(road, CAPITAL)).toBe(2); // enters + leaves ⇒ forced gates
    expect(road.some(([x, y]) => pointInRingClosed(ringM("vm-district-twin-a"), x, y))).toBe(true);
  });

  it("the gorge wall crosses the Vail; the coastal town touches the sea landform", () => {
    expect(polylineRingCrossings(metersOf("vm-wall-gorge"), [...VAIL, VAIL[VAIL.length - 1]].slice(0, -1) as Pt[]) >= 0).toBe(true);
    // wall-gorge is a polyline crossing the river polyline.
    const wall = metersOf("vm-wall-gorge");
    let crosses = false;
    for (let i = 0; i < wall.length - 1; i++)
      for (let j = 0; j < VAIL.length - 1; j++)
        if (segmentsIntersect(wall[i], wall[i + 1], VAIL[j], VAIL[j + 1])) crosses = true;
    expect(crosses).toBe(true);
    // Saltmere's west fringe reaches into the Cold Reach sea landform (overlap —
    // robust to both rings' organic jitter, no fragile shared-edge premise).
    expect(ringsOverlap(ringM("vm-district-coast"), ringM("vm-landform-sea"))).toBe(true);
  });

  it("every location pin sits inside the campaign bounds", () => {
    const [minX, minY, maxX, maxY] = VAILMARCH_BOUNDS;
    for (const pin of VAILMARCH_PINS) {
      const ux = pin.point[0] / VAILMARCH_SCALE_M_PER_UNIT;
      const uy = pin.point[1] / VAILMARCH_SCALE_M_PER_UNIT;
      expect(ux, pin.name).toBeGreaterThanOrEqual(minX);
      expect(ux, pin.name).toBeLessThanOrEqual(maxX);
      expect(uy, pin.name).toBeGreaterThanOrEqual(minY);
      expect(uy, pin.name).toBeLessThanOrEqual(maxY);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. GENERATION-PROOF FAMILY  — the coupling signatures, headlessly
// ═══════════════════════════════════════════════════════════════════════════

/** The capital street network (bare) — generated once, reused. */
const capitalStreets = ofGid(generate("vm-district-capital"), "city-street");
/** The Vail channel polygons (bare) — generated once, reused. */
const vailChannel = ofGid(generate("vm-river-vail"), "river-channel");

describe("gen-proof · wall water-gate + arterial gates (Vailmarch waterfront)", () => {
  it("the capital wall gets a water-gate where the Vail crosses it AND road gates at arterials", () => {
    const upstream: UpstreamArtifacts = { water: vailChannel, settlement: capitalStreets };
    const wall = generate("vm-wall-capital", { upstream });
    const gates = wall.filter((f) => f.geometry.type === "Point" && (f.properties as { type?: string }).type === "wall-gate");
    const waterGates = gates.filter((f) => (f.properties as { waterGate?: boolean }).waterGate === true);
    const roadGates = gates.filter((f) => (f.properties as { bearing?: number }).bearing !== undefined);
    expect(waterGates.length, "a sluice where the river crosses the wall").toBeGreaterThanOrEqual(1);
    expect(roadGates.length, "a gatehouse where a generated arterial exits the ring").toBeGreaterThanOrEqual(1);
  });

  it("no upstream water ⇒ no water-gate (byte-identity of the uncoupled wall)", () => {
    const bare = generate("vm-wall-capital");
    const bareWaterGates = bare.filter((f) => (f.properties as { waterGate?: boolean }).waterGate === true);
    expect(bareWaterGates.length).toBe(0);
  });
});

describe("gen-proof · riverine farmland long-lots + water meadows (Marnside Strips)", () => {
  it("the Marn channel mints bankLot long-lots carrying waterMeadow tags", () => {
    const marnChannel = ofGid(generate("vm-river-marn"), "river-channel");
    expect(marnChannel.length).toBeGreaterThan(0);
    const farm = generate("vm-farm-riverine", { upstream: { water: marnChannel } });
    const bankLots = farm.filter((f) => (f.properties as { bankLot?: boolean }).bankLot === true);
    expect(bankLots.length, "riverine rang holdings appear").toBeGreaterThan(0);
    const meadows = bankLots.filter((f) => (f.properties as { waterMeadow?: boolean }).waterMeadow === true);
    expect(meadows.length, "the near cell of each lot floods").toBeGreaterThan(0);
    expect((meadows[0].properties as { crop?: string }).crop).toBe("water-meadow");
  });

  it("no upstream channel ⇒ byte-identical to the uncoupled farm (no bankLots)", () => {
    const bare = generate("vm-farm-riverine");
    expect(bare.filter((f) => (f.properties as { bankLot?: boolean }).bankLot === true).length).toBe(0);
  });
});

describe("gen-proof · forest terrain reading (Cairnwood over the Cairn Arm ridge)", () => {
  // No mountain polygon — the timberline reads a RELIEF ridge spur (the ruling).
  const spur = sketchM("vm-relief-west-spur");
  const coupled = generate("vm-forest-spine", { fabricFeatures: [spur] });
  const uncoupled = generate("vm-forest-spine");

  const trees = (feats: GeoJSON.Feature[]): Pt[] =>
    ofGid(feats, "forest-tree").map((f) => (f.geometry as GeoJSON.Point).coordinates as Pt);
  const conifers = (feats: GeoJSON.Feature[]): Pt[] =>
    feats
      .filter((f) => (f.properties as { standConifer?: boolean }).standConifer === true)
      .map((f) => (f.geometry as GeoJSON.Point).coordinates as Pt);

  // Region-relative elevation, the way the generator reads it (macro field, relief).
  const terrain = macroTerrainField([spur])!;
  const ring = metersOf("vm-forest-spine");
  let eMin = Infinity;
  let eMax = -Infinity;
  const xs = ring.map((p) => p[0]);
  const ys = ring.map((p) => p[1]);
  for (let x = Math.min(...xs); x <= Math.max(...xs); x += 40)
    for (let y = Math.min(...ys); y <= Math.max(...ys); y += 40) {
      const v = terrain(x, y).v;
      if (v < eMin) eMin = v;
      if (v > eMax) eMax = v;
    }
  const rel = (p: Pt): number => (terrain(p[0], p[1]).v - eMin) / (eMax - eMin);

  it("the relief spur yields real relief inside the wood", () => {
    expect(eMax - eMin).toBeGreaterThan(50);
  });

  it("the overlapping relief ridge couples the wood (coupled ≠ uncoupled)", () => {
    expect(JSON.stringify(coupled)).not.toBe(JSON.stringify(uncoupled));
  });

  it("timberline thins the canopy above the treeline", () => {
    const TIMBER = 0.72;
    const above = (ps: Pt[]): number => ps.filter((p) => rel(p) > TIMBER).length;
    expect(above(trees(uncoupled))).toBeGreaterThan(0);
    expect(above(trees(coupled))).toBeLessThan(above(trees(uncoupled)));
  });

  it("conifer-upslope stands exist and skew high", () => {
    const c = conifers(coupled);
    expect(c.length).toBeGreaterThan(0);
    for (const p of c) expect(rel(p)).toBeGreaterThanOrEqual(0.5 - 1e-6);
  });
});

describe("gen-proof · relief slope leaves pasture (Hoarfell on the Haward Arm, no mountain)", () => {
  // The flank farmland slope-gates on the Haward Arm ridge: steep relief ground is
  // left as untilled pasture. Pattern from terrainStampCoupling.test.ts.
  const spur = sketchM("vm-relief-east-spur");
  const pastureCount = (feats: GeoJSON.Feature[]): number =>
    feats.filter((f) => (f.properties as { pasture?: boolean }).pasture === true).length;

  it("steep relief ground is untilled pasture; the flat control has none", () => {
    const coupled = generate("vm-farm-flank", { fabricFeatures: [spur] });
    const flat = generate("vm-farm-flank");
    expect(pastureCount(flat)).toBe(0);
    expect(pastureCount(coupled)).toBeGreaterThan(0);
  });

  it("a disjoint relief ridge is byte-identical (variable support: past halfWidth ⇒ inert)", () => {
    const bare = JSON.stringify(generate("vm-farm-flank"));
    // The far Cairn Arm is > 2 km from the flank, well past its 500 m half-width.
    expect(JSON.stringify(generate("vm-farm-flank", { fabricFeatures: [sketchM("vm-relief-west-spur")] }))).toBe(bare);
  });
});

describe("gen-proof · paddy terraces read relief contours (Cairnfoot on the Cairn Arm, no mountain)", () => {
  // The paddy terraces trace contour banks over the composed relief field — driven
  // by the Cairn Arm ridge, not a mountain polygon.
  const spur = sketchM("vm-relief-west-spur");
  const banks = (feats: GeoJSON.Feature[]): number => ofGid(feats, "farm-bank").length;

  it("the relief spur mints contour-following terrace banks; coupled ≠ the flat control", () => {
    const coupled = generate("vm-farm-paddy", { fabricFeatures: [spur] });
    const flat = generate("vm-farm-paddy");
    expect(banks(coupled)).toBeGreaterThan(0);
    expect(JSON.stringify(coupled)).not.toBe(JSON.stringify(flat));
  });
});

describe("gen-proof · market pin anchors the plaza (Vailmarch Market)", () => {
  const region = polyRegion("vm-district-capital");
  const market = VAILMARCH_PINS.find((p) => p.type === "market")!.point;

  const plazaCentroid = (net: GeoJSON.Feature[]): Pt | null => {
    const plaza = net.find((f) => (f.properties as { type?: string })?.type === "plaza");
    if (!plaza || plaza.geometry.type !== "Polygon") return null;
    const ringp = plaza.geometry.coordinates[0] as Pt[];
    let sx = 0;
    let sy = 0;
    const n = ringp.length - 1;
    for (let i = 0; i < n; i++) {
      sx += ringp[i][0];
      sy += ringp[i][1];
    }
    return [sx / n, sy / n];
  };

  it("the market pin is strictly inside the region (fixture premise)", () => {
    expect(regionContains(region, market[0], market[1])).toBe(true);
  });

  it("a typed market pin pulls the plaza onto it", () => {
    const withMarket = generate("vm-district-capital", {
      canonFeatures: [{ type: "Feature", id: "m", geometry: { type: "Point", coordinates: market }, properties: { type: "market" } }],
    });
    const c = plazaCentroid(withMarket);
    expect(c).not.toBeNull();
    expect(Math.hypot(c![0] - market[0], c![1] - market[1])).toBeLessThan(60);
  });
});

describe("gen-proof · adjacent districts derive bit-matching shared-edge gates (Twinbridge/Eastwool)", () => {
  // The shared edge is now an ORGANIC polyline (identical on both rings); a gate is
  // "on it" when it sits within a couple of meters of that polyline.
  const sharedEdge = edgeRun(ringM("vm-district-twin-a"), [2100, -800], [2100, -100]);
  const onSharedEdge = (p: Pt): boolean => distanceToPolyline(sharedEdge, p[0], p[1]) < 2;
  const sharedGates = (net: GeoJSON.Feature[]): Pt[] =>
    net
      .filter((f) => f.geometry.type === "Point" && (f.properties as { type?: string })?.type === "gate")
      .map((f) => (f.geometry as GeoJSON.Point).coordinates as Pt)
      .filter(onSharedEdge)
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  it("both districts place gates on the shared edge at bit-identical points", () => {
    const aNet = generate("vm-district-twin-a", { fabricFeatures: [sketchM("vm-district-twin-b")] });
    const bNet = generate("vm-district-twin-b", { fabricFeatures: [sketchM("vm-district-twin-a")] });
    const aGates = sharedGates(aNet);
    const bGates = sharedGates(bNet);
    expect(aGates.length, "a shared-edge gate exists").toBeGreaterThanOrEqual(1);
    // Different seeds AND different profiles, yet the on-edge points match to the bit.
    expect(bGates).toEqual(aGates);
  });
});

describe("gen-proof · gorge river carve lowers terrainAt (the Vail through the Marchspine)", () => {
  it("the river carve incises the gorge deep below the un-carved surface", () => {
    // A point ON the Vail spine inside the ridge (between source and the north
    // confluence, over the raised Marchspine relief).
    const P: Pt = [-620, 2170];
    const feats = buildVailmarchFabricMeters();
    const withCarve = terrainAt(feats)(P[0], P[1]).v;
    const noCarve = terrainAt(feats, { include: { carve: false } })(P[0], P[1]).v;
    // The carve pulls the on-spine surface down by tens of meters (depth = 60 +
    // width·1.5 ≈ 105 m for the Vail's width 30).
    expect(noCarve - withCarve).toBeGreaterThan(40);

    // And it is LOCAL to the channel: a point ~200 m to the side (beyond the
    // carve's compact support) keeps the ridge height.
    const Q: Pt = [-620 + 200, 2170];
    const asideCarve = terrainAt(feats)(Q[0], Q[1]).v;
    expect(asideCarve - withCarve).toBeGreaterThan(40);
  });
});

describe("gen-proof · nested park ⇒ zero city geometry inside the ring (Kingsmoot Green)", () => {
  it("the capital treats the contained park as a hole (no interior street/block/parcel/footprint)", () => {
    const park = sketchM("vm-park-capital");
    const net = generate("vm-district-capital", { fabricFeatures: [park] });
    const parkRing = ringM("vm-park-capital");
    const interiorGids = new Set(["city-street", "city-block", "city-parcel", "city-footprint"]);
    for (const f of net) {
      if (!interiorGids.has(gidOf(f))) continue;
      const g = f.geometry;
      const verts: Pt[] =
        g.type === "LineString"
          ? (g.coordinates as Pt[])
          : g.type === "Polygon"
            ? (g.coordinates.flat() as Pt[])
            : [];
      for (const [x, y] of verts) {
        // Genuine interior geometry has positive depth; the frontage street hugs
        // the ring (small band tolerated).
        expect(signedDistancePolygon(parkRing, x, y), `${gidOf(f)} inside park`).toBeLessThan(8);
      }
    }
    // A perimeter frontage street exists (the hole gets a rim road).
    expect(net.some((f) => f.id === hashSeed(seedFor("vm-district-capital"), "frontage", 0))).toBe(true);
  });
});

describe("gen-proof · peri-urban farm lanes reach a city gate (Vailmarch Fields)", () => {
  it("gate lanes radiate from the generated arterials onto the belt ring", () => {
    const arterials = capitalStreets
      .filter((f) => (f.properties as { roadClass?: string }).roadClass === "arterial")
      .map((f) => (f.geometry as GeoJSON.LineString).coordinates as Pt[]);
    expect(arterials.length, "the capital grew arterials").toBeGreaterThan(0);

    const region = polyRegion("vm-farm-capital-belt");
    const coupled = generate("vm-farm-capital-belt", { upstream: { settlement: capitalStreets } });
    const bare = generate("vm-farm-capital-belt");
    const lanesBare = ofGid(bare, "farm-lane");
    const lanesCoupled = ofGid(coupled, "farm-lane");
    expect(lanesCoupled.length, "the city adds gate lanes").toBeGreaterThan(lanesBare.length);

    const distToArterial = (x: number, y: number): number => {
      let best = Infinity;
      for (const line of arterials) for (const [ax, ay] of line) best = Math.min(best, Math.hypot(x - ax, y - ay));
      return best;
    };
    const bareIds = new Set(lanesBare.map((f) => Number(f.id)));
    const added = lanesCoupled.filter((f) => !bareIds.has(Number(f.id)));
    expect(added.length).toBeGreaterThan(0);
    // At least one added lane starts on the belt ring next to a generated arterial
    // exit — the peri-urban belt reaching for the city gate.
    const reaches = added.some((lane) => {
      const coords = (lane.geometry as GeoJSON.LineString).coordinates as Pt[];
      return [coords[0], coords[coords.length - 1]].some(
        ([x, y]) => Math.abs(distanceToBoundary(region, x, y)) < 3 && distToArterial(x, y) <= 60
      );
    });
    expect(reaches, "a gate lane starts at a gate entry on the ring").toBe(true);
  });
});
