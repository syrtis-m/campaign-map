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

/** The (closed) ring edge from `p` to `q` exists in `ring` (either direction),
 * endpoints matching within `eps`. */
function ringHasEdge(ring: Pt[], p: Pt, q: Pt, eps: number): boolean {
  const near = (a: Pt, b: Pt): boolean => Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps;
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i];
    const b = ring[i + 1];
    if ((near(a, p) && near(b, q)) || (near(a, q) && near(b, p))) return true;
  }
  return false;
}

/** Closed meter ring of a polygon def. */
function ringM(id: string): Pt[] {
  const open = metersOf(id);
  return [...open, open[0]];
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
    expect(count("relief")).toBeGreaterThanOrEqual(1);
    expect(count("landform")).toBeGreaterThanOrEqual(1);
    expect(count("mountain")).toBeGreaterThanOrEqual(1);
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

  it("Twinbridge + Eastwool share their full common edge exactly (ε = 0), interiors disjoint", () => {
    const a = ringM("vm-district-twin-a");
    const b = ringM("vm-district-twin-b");
    const p: Pt = [2100, -800];
    const q: Pt = [2100, -100];
    expect(ringHasEdge(a, p, q, 0)).toBe(true);
    expect(ringHasEdge(b, p, q, 0)).toBe(true);
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
    // Torrent Beck rises inside the east massif (so it reads terrain).
    expect(pointInRingClosed(ringM("vm-massif-east"), north[0][0], north[0][1])).toBe(true);
  });

  it("forests/farms overlap the mountains and rivers the demo pairs them with", () => {
    expect(ringsOverlap(ringM("vm-forest-spine"), ringM("vm-massif-west"))).toBe(true);
    expect(ringsOverlap(ringM("vm-farm-paddy"), ringM("vm-massif-west"))).toBe(true);
    expect(ringsOverlap(ringM("vm-farm-flank"), ringM("vm-massif-east"))).toBe(true);
    // Riparian forest + riverine farm sit over their rivers (spine crosses ring).
    expect(polylineRingCrossings(VAIL, ringM("vm-forest-riparian"))).toBeGreaterThanOrEqual(1);
    expect(polylineRingCrossings(metersOf("vm-river-marn"), ringM("vm-farm-riverine"))).toBeGreaterThanOrEqual(1);
  });

  it("hedgerow adjacencies: Hollowbrake shares edges with Merewood Common and the crofts", () => {
    const forest = ringM("vm-forest-hedge");
    const park = ringM("vm-park-rural");
    const croft = ringM("vm-farm-hedge");
    // Forest east edge x=-600, y∈[-2100,-1550] == park west edge; forest north
    // edge y=-1550 == croft south edge.
    expect(ringHasEdge(forest, [-600, -2100], [-600, -1550], 0)).toBe(true);
    expect(ringHasEdge(park, [-600, -2100], [-600, -1550], 0)).toBe(true);
    expect(ringHasEdge(forest, [-1200, -1550], [-600, -1550], 0)).toBe(true);
    expect(ringHasEdge(croft, [-1200, -1550], [-600, -1550], 0)).toBe(true);
  });

  it("peri-urban belts share their city's edge; the East Road pierces the capital and reaches Twinbridge", () => {
    expect(ringHasEdge(CAPITAL, [-1950, -150], [-1050, -150], 0)).toBe(true);
    expect(ringHasEdge(ringM("vm-farm-capital-belt"), [-1950, -150], [-1050, -150], 0)).toBe(true);
    expect(ringHasEdge(ringM("vm-farm-twin-belt"), [1500, -800], [2100, -800], 0)).toBe(true);
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
    expect(ringHasEdge(ringM("vm-district-coast"), [-2900, -1750], [-2900, -1200], 0)).toBe(true);
    expect(ringHasEdge(ringM("vm-landform-sea"), [-2900, -2600], [-2900, 2600], 0)).toBe(true);
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

describe("gen-proof · forest terrain reading (Cairnwood over the Cairn Fells)", () => {
  const massif = sketchM("vm-massif-west");
  const coupled = generate("vm-forest-spine", { fabricFeatures: [massif] });
  const uncoupled = generate("vm-forest-spine");

  const trees = (feats: GeoJSON.Feature[]): Pt[] =>
    ofGid(feats, "forest-tree").map((f) => (f.geometry as GeoJSON.Point).coordinates as Pt);
  const conifers = (feats: GeoJSON.Feature[]): Pt[] =>
    feats
      .filter((f) => (f.properties as { standConifer?: boolean }).standConifer === true)
      .map((f) => (f.geometry as GeoJSON.Point).coordinates as Pt);

  // Region-relative elevation, the way the generator reads it.
  const terrain = macroTerrainField([massif])!;
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

  it("the massif yields real relief inside the wood", () => {
    expect(eMax - eMin).toBeGreaterThan(50);
  });

  it("an overlapping mountain couples the wood (coupled ≠ uncoupled)", () => {
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
  const onSharedEdge = (p: Pt): boolean => Math.abs(p[0] - 2100) < 1 && p[1] >= -800 - 1 && p[1] <= -100 + 1;
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
