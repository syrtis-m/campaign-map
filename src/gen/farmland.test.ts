import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { generateFarmland, fieldCellM, type FarmlandParams } from "./farmland";
import { makeRegion, distanceToBoundary, type ProcgenRegion } from "./region";
import { expectGeneratorInvariants, expectDeterministic } from "./testkit/invariants";
import { computeFarmlandMetrics, farmlandBandViolations, maxDiagonalLaneRunCells } from "./farmlandMetrics";
import { elevationFieldFromFabric } from "./fields/mountainField";
import type { FabricFeature } from "../model/fabric";
import type { GenerationConstraints } from "./types";
import { clipNetworkToTile } from "./citynet";
import { tileBBox, tileXYForPoint } from "./cache/tileGrid";
import { algorithmById } from "./procgen/registry";
import {
  buildMainDistrict,
  buildFarmlandEast,
  MAIN_DISTRICT_RING,
  FARMLAND_EAST_RING,
  OVERLAP_SCALE_M_PER_UNIT,
} from "./testkit/overlapMap";

type Pt = [number, number];

const CONSTRAINTS: GenerationConstraints = {
  worldBounds: { minX: -1e5, minY: -1e5, maxX: 1e5, maxY: 1e5 },
};

/** A 1000 m square farmland region in gen-space meters (large ⇒ many cells at
 * every field scale, so every preset emits a full artifact). */
const SQUARE: Pt[] = [
  [0, 0],
  [1000, 0],
  [1000, 1000],
  [0, 1000],
  [0, 0],
];

// L-shape (concave) for containment stress: 900×900 minus the NE 450×450. A
// straight field edge can bridge the concave notch — the edge-crossing check in
// rectContained must drop those, so nothing spills across the notch.
const L_SHAPE: Pt[] = [
  [0, 0],
  [900, 0],
  [900, 450],
  [450, 450],
  [450, 900],
  [0, 900],
  [0, 0],
];

const PARAMS = (o: Partial<FarmlandParams> = {}): FarmlandParams => ({
  fieldType: "enclosed-patchwork",
  fieldSize: 0.5,
  hedging: "hedgerows",
  laneDensity: 0.5,
  farmsteads: 0.5,
  ...o,
});

function regionFor(ring: Pt[]): ProcgenRegion {
  return makeRegion("farm-test", ring);
}

/** A sketched procgen MOUNTAIN feature covering the SQUARE region and beyond —
 * the elevation source paddy-terraces reads via the constraints (the raw sketch
 * layer; the persisted seed/params ARE the durable input). */
const MOUNTAIN_OVER_SQUARE = {
  type: "Feature",
  id: "mountain-z",
  geometry: {
    type: "Polygon",
    coordinates: [[[-400, -400], [1400, -400], [1400, 1400], [-400, 1400], [-400, -400]]],
  },
  properties: {
    kind: "mountain",
    procgen: { algorithm: "mountain", seed: 777, version: 1, params: { terrain: "alpine", amplitude: 0.8, roughness: 0.5 } },
  },
} as FabricFeature;

const MOUNTAIN_CONSTRAINTS: GenerationConstraints = {
  worldBounds: CONSTRAINTS.worldBounds,
  fabricFeatures: [MOUNTAIN_OVER_SQUARE],
};

function allCoords(feats: GeoJSON.Feature[]): Pt[] {
  const out: Pt[] = [];
  const scan = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === "number" && typeof c[1] === "number") {
      out.push([c[0], c[1]]);
      return;
    }
    for (const x of c) scan(x);
  };
  for (const f of feats) scan((f.geometry as { coordinates: unknown }).coordinates);
  return out;
}

/** Coordinate buckets for a single generatorId — the locality measure (a fine
 * grid so a re-roll's re-split registers). */
function fieldBuckets(feats: GeoJSON.Feature[], grid = 6): Set<string> {
  const s = new Set<string>();
  for (const f of feats) {
    if ((f.properties as { generatorId?: string }).generatorId !== "farm-field") continue;
    for (const [x, y] of allCoords([f])) s.add(`${Math.round(x / grid)},${Math.round(y / grid)}`);
  }
  return s;
}

function overlapPct(a: Set<string>, b: Set<string>): number {
  if (a.size === 0) return 0;
  let hit = 0;
  for (const k of a) if (b.has(k)) hit++;
  return (hit / a.size) * 100;
}

function typeCount(feats: GeoJSON.Feature[], type: string): number {
  return feats.filter((f) => (f.properties as { generatorId?: string }).generatorId === type).length;
}

/** Hash + per-type counts (the 022 golden tripwire idiom): any numeric drift
 * flips the sha256. */
function digest(features: GeoJSON.Feature[]): { sha256: string; summary: Record<string, number> } {
  const summary: Record<string, number> = { total: features.length };
  for (const f of features) {
    const type = String((f.properties as Record<string, unknown>)?.generatorId);
    summary[type] = (summary[type] ?? 0) + 1;
  }
  return {
    sha256: createHash("sha256").update(JSON.stringify(features)).digest("hex"),
    summary,
  };
}

describe("farmland generator — determinism", () => {
  it("matches the seeded snapshot fixture (enclosed-patchwork — golden drift tripwire)", () => {
    expect(digest(generateFarmland(4242, regionFor(SQUARE), PARAMS(), CONSTRAINTS))).toMatchSnapshot();
  });

  it("is byte-identical across two runs (same seed/region/params)", () => {
    const region = regionFor(SQUARE);
    expectDeterministic(() => generateFarmland(1234, region, PARAMS(), CONSTRAINTS));
  });

  it("hashes feature ids on position, not emission order (integer ids)", () => {
    const feats = generateFarmland(7, regionFor(SQUARE), PARAMS(), CONSTRAINTS);
    for (const f of feats) {
      expect(typeof f.id).toBe("number");
      expect(Number.isFinite(Number(f.id))).toBe(true);
    }
  });
});

describe("farmland generator — preset semantics", () => {
  it("enclosed-patchwork subdivides into fields, with hedges and farmsteads", () => {
    const feats = generateFarmland(9, regionFor(SQUARE), PARAMS({ fieldType: "enclosed-patchwork" }), CONSTRAINTS);
    expect(typeCount(feats, "farm-field")).toBeGreaterThan(0);
    expect(typeCount(feats, "farm-hedge")).toBeGreaterThan(0);
    expect(typeCount(feats, "farm-building")).toBeGreaterThan(0);
    expect(typeCount(feats, "orchard-tree")).toBe(0);
  });

  it("open-field-strips emits many long strips off lanes", () => {
    const strips = generateFarmland(9, regionFor(SQUARE), PARAMS({ fieldType: "open-field-strips" }), CONSTRAINTS);
    const quarters = generateFarmland(9, regionFor(SQUARE), PARAMS({ fieldType: "grid-quarters" }), CONSTRAINTS);
    // Strips split each coarse cell into STRIP_COUNT bands → many more fields
    // than one rectilinear section per cell.
    expect(typeCount(strips, "farm-field")).toBeGreaterThan(typeCount(quarters, "farm-field"));
    expect(typeCount(strips, "farm-lane")).toBeGreaterThan(0);
  });

  it("grid-quarters emits rectilinear sections + straight section lanes", () => {
    const feats = generateFarmland(9, regionFor(SQUARE), PARAMS({ fieldType: "grid-quarters" }), CONSTRAINTS);
    expect(typeCount(feats, "farm-field")).toBeGreaterThan(0);
    expect(typeCount(feats, "farm-lane")).toBeGreaterThan(0);
  });

  it("orchard emits regular tree rows (orchard-tree points)", () => {
    const orchard = generateFarmland(9, regionFor(SQUARE), PARAMS({ fieldType: "orchard" }), CONSTRAINTS);
    const patchwork = generateFarmland(9, regionFor(SQUARE), PARAMS({ fieldType: "enclosed-patchwork" }), CONSTRAINTS);
    expect(typeCount(orchard, "orchard-tree")).toBeGreaterThan(0);
    expect(typeCount(patchwork, "orchard-tree")).toBe(0);
  });

  it("hedging=none suppresses every field-edge line; hedgerows/fences emit them", () => {
    const none = generateFarmland(3, regionFor(SQUARE), PARAMS({ hedging: "none" }), CONSTRAINTS);
    const hedged = generateFarmland(3, regionFor(SQUARE), PARAMS({ hedging: "hedgerows" }), CONSTRAINTS);
    const fenced = generateFarmland(3, regionFor(SQUARE), PARAMS({ hedging: "fences" }), CONSTRAINTS);
    expect(typeCount(none, "farm-hedge")).toBe(0);
    expect(typeCount(hedged, "farm-hedge")).toBeGreaterThan(0);
    expect(typeCount(fenced, "farm-hedge")).toBeGreaterThan(0);
    // The hedging kind is carried onto every hedge feature (theme paint branch).
    for (const f of fenced) {
      if ((f.properties as { generatorId?: string }).generatorId === "farm-hedge") {
        expect((f.properties as { hedging?: string }).hedging).toBe("fences");
      }
    }
  });

  it("farmsteads=0 places no farm buildings; a high chance places some", () => {
    const none = generateFarmland(5, regionFor(SQUARE), PARAMS({ farmsteads: 0 }), CONSTRAINTS);
    const many = generateFarmland(5, regionFor(SQUARE), PARAMS({ farmsteads: 1 }), CONSTRAINTS);
    expect(typeCount(none, "farm-building")).toBe(0);
    expect(typeCount(many, "farm-building")).toBeGreaterThan(0);
  });

  it("carries the fieldType onto every emitted feature (theme tint hook)", () => {
    const feats = generateFarmland(3, regionFor(SQUARE), PARAMS({ fieldType: "orchard" }), CONSTRAINTS);
    expect(feats.length).toBeGreaterThan(0);
    for (const f of feats) expect((f.properties as { fieldType?: string }).fieldType).toBe("orchard");
  });

  it("tags each field with a crop variety (theme texture hook)", () => {
    const feats = generateFarmland(3, regionFor(SQUARE), PARAMS(), CONSTRAINTS);
    const fields = feats.filter((f) => (f.properties as { generatorId?: string }).generatorId === "farm-field");
    expect(fields.length).toBeGreaterThan(0);
    for (const f of fields) expect(typeof (f.properties as { crop?: string }).crop).toBe("string");
  });
});

describe("farmland generator — structural invariants (containment · closed rings · mm lattice)", () => {
  for (const fieldType of ["open-field-strips", "enclosed-patchwork", "grid-quarters", "orchard"] as const) {
    it(`all output inside the ring — ${fieldType}`, () => {
      const region = regionFor(SQUARE);
      expectGeneratorInvariants(generateFarmland(99, region, PARAMS({ fieldType }), CONSTRAINTS), region);
    });
  }

  it("stays inside a strongly concave (L-shaped) region — no field bridges the notch", () => {
    const region = regionFor(L_SHAPE);
    expectGeneratorInvariants(generateFarmland(42, region, PARAMS(), CONSTRAINTS), region);
  });
});

describe("farmland generator — identity / edit locality", () => {
  it("a single vertex edit changes the fields far less than a re-roll", () => {
    const base = fieldBuckets(generateFarmland(50, regionFor(SQUARE), PARAMS(), CONSTRAINTS));

    // Move ONE corner outward — only boundary cells near it change containment;
    // every interior field is byte-identical (absolute-world lattice).
    const moved: Pt[] = [
      [0, 0],
      [1080, 0],
      [1000, 1000],
      [0, 1000],
      [0, 0],
    ];
    const movedBuckets = fieldBuckets(generateFarmland(50, regionFor(moved), PARAMS(), CONSTRAINTS));

    // Re-roll: a new seed re-splits + re-classifies every patchwork field.
    const rerolled = fieldBuckets(generateFarmland(51, regionFor(SQUARE), PARAMS(), CONSTRAINTS));

    const editOverlap = overlapPct(base, movedBuckets);
    const rerollOverlap = overlapPct(base, rerolled);
    expect(editOverlap).toBeGreaterThan(rerollOverlap + 25);
    expect(editOverlap).toBeGreaterThan(80);
  });
});

describe("farmland generator — outskirt suppression is a strict no-op with no farmland (unit)", () => {
  it("non-paddy farmland ignores non-terrain sketch + a DISJOINT mountain (box 23-E)", () => {
    const region = regionFor(SQUARE);
    // A city district + another farmland (cross-kind identity; farmland reading
    // the city would be a stage-3→2 cascade cycle, rejected) AND a mountain whose
    // ring is DISJOINT from the region (compact support ⇒ zero slope in-region,
    // influenceMargin 0) must all be byte-inert for the four non-paddy types.
    const farMountain = {
      type: "Feature",
      id: "mountain-far",
      geometry: { type: "Polygon", coordinates: [[[-6000, -6000], [-3000, -6000], [-3000, -3000], [-6000, -3000], [-6000, -6000]]] },
      properties: { kind: "mountain", procgen: { algorithm: "mountain", seed: 777, version: 1, params: { terrain: "alpine", amplitude: 0.8, roughness: 0.5 } } },
    } as FabricFeature;
    const busy: GenerationConstraints = {
      worldBounds: CONSTRAINTS.worldBounds,
      fabricFeatures: [
        {
          type: "Feature",
          id: "district-x",
          geometry: { type: "Polygon", coordinates: [[[0, 0], [500, 0], [500, 500], [0, 500], [0, 0]]] },
          properties: { kind: "district" },
        },
        {
          type: "Feature",
          id: "farmland-y",
          geometry: { type: "Polygon", coordinates: [[[0, 0], [1000, 0], [1000, 1000], [0, 1000], [0, 0]]] },
          properties: { kind: "farmland" },
        },
        farMountain,
      ],
    };
    for (const fieldType of ["open-field-strips", "enclosed-patchwork", "grid-quarters", "orchard"] as const) {
      const bare = generateFarmland(7, region, PARAMS({ fieldType }), CONSTRAINTS);
      const withBusy = generateFarmland(7, region, PARAMS({ fieldType }), busy);
      expect(JSON.stringify(withBusy), `${fieldType} must ignore non-terrain sketch + a disjoint mountain`).toBe(JSON.stringify(bare));
    }
  });

  it("non-paddy farmland slope-gates steep ground to pasture over an OVERLAPPING mountain (plan 038 item 4)", () => {
    const region = regionFor(SQUARE);
    // An alpine mountain overlapping the region now COUPLES the non-paddy types
    // (plan 038 item 4): fields on steep ground become untilled pasture. The
    // output changes vs. the uncoupled generator, and pasture-tagged fields carry
    // the paint hook.
    let anyCoupled = false;
    let anyPasture = false;
    for (const fieldType of ["open-field-strips", "enclosed-patchwork", "grid-quarters", "orchard"] as const) {
      const bare = generateFarmland(7, region, PARAMS({ fieldType }), CONSTRAINTS);
      const coupled = generateFarmland(7, region, PARAMS({ fieldType }), MOUNTAIN_CONSTRAINTS);
      if (JSON.stringify(coupled) !== JSON.stringify(bare)) anyCoupled = true;
      const pasture = coupled.filter((f) => (f.properties as { pasture?: boolean }).pasture === true);
      if (pasture.length > 0) {
        anyPasture = true;
        expect((pasture[0].properties as { crop?: string }).crop).toBe("pasture");
      }
    }
    expect(anyCoupled, "an overlapping alpine mountain must couple non-paddy farmland").toBe(true);
    expect(anyPasture, "steep ground must yield pasture-tagged fields").toBe(true);
    // A flat campaign is byte-identical (no terrain ⇒ no slope-gating).
    const flat = generateFarmland(7, region, PARAMS({ fieldType: "grid-quarters" }), CONSTRAINTS);
    expect(flat.every((f) => (f.properties as { pasture?: boolean }).pasture !== true)).toBe(true);
  });
});

describe("farmland generator — paddy-terraces (box 23-E: elevation-coupled banks)", () => {
  const PADDY = PARAMS({ fieldType: "paddy-terraces", hedging: "none" });

  function banks(feats: GeoJSON.Feature[]): GeoJSON.Feature[] {
    return feats.filter((f) => (f.properties as { generatorId?: string }).generatorId === "farm-bank");
  }

  it("with an overlapping mountain: emits a paddy wash + contour-following banks, all contained", () => {
    const region = regionFor(SQUARE);
    const feats = generateFarmland(7, region, PADDY, MOUNTAIN_CONSTRAINTS);
    // One region-wide wash carrying the paddy crop tag.
    const fields = feats.filter((f) => (f.properties as { generatorId?: string }).generatorId === "farm-field");
    expect(fields.length).toBe(1);
    expect((fields[0].properties as { crop?: string }).crop).toBe("paddy");
    // Banks exist and every coordinate stays inside the ring.
    const bs = banks(feats);
    expect(bs.length).toBeGreaterThan(3);
    for (const [x, y] of allCoords(feats)) {
      expect(distanceToBoundary(region, x, y)).toBeGreaterThanOrEqual(-1e-3);
    }
    // No rectangle-lattice artifacts: paddy replaces the field grid entirely.
    expect(typeCount(feats, "farm-hedge")).toBe(0);
    expect(typeCount(feats, "orchard-tree")).toBe(0);
  });

  it("banks FOLLOW the elevation contours: the field is near-constant along every bank", () => {
    const region = regionFor(SQUARE);
    const feats = generateFarmland(7, region, PADDY, MOUNTAIN_CONSTRAINTS);
    const elev = elevationFieldFromFabric(MOUNTAIN_CONSTRAINTS.fabricFeatures)!;
    // The adaptive band interval = the gap between adjacent distinct levels.
    const levels = [...new Set(banks(feats).map((b) => (b.properties as { elevation?: number }).elevation!))].sort(
      (a, b) => a - b
    );
    expect(levels.length).toBeGreaterThan(1);
    const interval = levels[1] - levels[0];
    let checked = 0;
    let errSum = 0;
    for (const b of banks(feats)) {
      // v9: cross-walls deliberately run DOWNHILL (they segment a strip into
      // paddies) — only the contour banks promise a near-constant field.
      if ((b.properties as { cross?: boolean }).cross) continue;
      const coords = (b.geometry as GeoJSON.LineString).coordinates as Pt[];
      if (coords.length < 4) continue;
      const level = (b.properties as { elevation?: number }).elevation!;
      for (const [x, y] of coords) {
        // Linear-interpolation error on the 10 m lattice over the (ridged,
        // fine-octave) field: the interval is CAPPED at 25 m (field-scale
        // terraces), so per-vertex error is bounded by lattice roughness, not
        // by the interval — allow 1.5 bands worst-case but demand the AVERAGE
        // stays a small fraction of a band (v10: the warp is gone — banks
        // trace the TRUE contours again, registered with the topo layer).
        const err = Math.abs(elev(x, y).v - level);
        expect(err).toBeLessThan(interval * 1.5);
        errSum += err;
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(50);
    expect(errSum / checked).toBeLessThan(interval * 0.3);
  });

  it("is byte-identical across two coupled runs, and keys on the MOUNTAIN's persisted seed", () => {
    const region = regionFor(SQUARE);
    const a = generateFarmland(7, region, PADDY, MOUNTAIN_CONSTRAINTS);
    const b = generateFarmland(7, region, PADDY, MOUNTAIN_CONSTRAINTS);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // A different mountain seed is a different durable input → different banks
    // (the mountain is an INPUT, like a vertex edit).
    const otherMountain = JSON.parse(JSON.stringify(MOUNTAIN_OVER_SQUARE)) as typeof MOUNTAIN_OVER_SQUARE;
    (otherMountain.properties.procgen as { seed: number }).seed = 778;
    const c = generateFarmland(7, region, PADDY, {
      worldBounds: CONSTRAINTS.worldBounds,
      fabricFeatures: [otherMountain],
    });
    expect(JSON.stringify(banks(c))).not.toBe(JSON.stringify(banks(a)));
  });

  it("no mountain (or flat field): falls back to concentric interior-distance bands, contained + deterministic", () => {
    const region = regionFor(SQUARE);
    const a = generateFarmland(7, region, PADDY, CONSTRAINTS);
    const b = generateFarmland(7, region, PADDY, CONSTRAINTS);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const bs = banks(a);
    expect(bs.length).toBeGreaterThan(2);
    for (const [x, y] of allCoords(bs)) {
      expect(distanceToBoundary(region, x, y)).toBeGreaterThanOrEqual(-1e-3);
    }
    // Fallback banks are iso-distance rings: every vertex of a bank sits at
    // (about) its level's distance from the boundary (cross-walls run inward
    // by design and are excluded).
    for (const bank of bs) {
      if ((bank.properties as { cross?: boolean }).cross) continue;
      const level = (bank.properties as { elevation?: number }).elevation!;
      for (const [x, y] of (bank.geometry as GeoJSON.LineString).coordinates as Pt[]) {
        expect(Math.abs(distanceToBoundary(region, x, y) - level)).toBeLessThan(10);
      }
    }
    // A mountain ELSEWHERE (no overlap → zero relief here) must leave the
    // fallback output byte-identical (the no-overlap byte-identity rule).
    const farMountain = JSON.parse(JSON.stringify(MOUNTAIN_OVER_SQUARE)) as typeof MOUNTAIN_OVER_SQUARE;
    (farMountain.geometry as GeoJSON.Polygon).coordinates = [
      [[8000, 8000], [9500, 8000], [9500, 9500], [8000, 9500], [8000, 8000]],
    ];
    const c = generateFarmland(7, region, PADDY, {
      worldBounds: CONSTRAINTS.worldBounds,
      fabricFeatures: [farMountain],
    });
    expect(JSON.stringify(c)).toBe(JSON.stringify(a));
  });

  it("stays inside the concave L-shape (banks never bridge the notch)", () => {
    const region = regionFor(L_SHAPE);
    const feats = generateFarmland(11, region, PADDY, MOUNTAIN_CONSTRAINTS);
    for (const [x, y] of allCoords(feats)) {
      expect(distanceToBoundary(region, x, y)).toBeGreaterThanOrEqual(-1e-3);
    }
  });

  it("2x2 seam: the coupled whole artifact clips deterministically per tile", () => {
    const region = regionFor(SQUARE);
    const network = generateFarmland(21, region, PADDY, MOUNTAIN_CONSTRAINTS);
    const min = tileXYForPoint(region.bbox.minX, region.bbox.minY);
    const max = tileXYForPoint(region.bbox.maxX, region.bbox.maxY);
    let clipped = 0;
    for (let ty = min.tileY; ty <= max.tileY; ty++) {
      for (let tx = min.tileX; tx <= max.tileX; tx++) {
        const bb = tileBBox(tx, ty);
        const a = clipNetworkToTile(network, bb);
        const b = clipNetworkToTile(network, bb);
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
        for (const gid of Object.keys(a)) {
          for (const f of a[gid]) {
            for (const [x, y] of allCoords([f])) {
              expect(x).toBeGreaterThanOrEqual(bb.minX - 1e-3);
              expect(x).toBeLessThanOrEqual(bb.maxX + 1e-3);
              expect(y).toBeGreaterThanOrEqual(bb.minY - 1e-3);
              expect(y).toBeLessThanOrEqual(bb.maxY + 1e-3);
              clipped++;
            }
          }
        }
      }
    }
    expect(clipped).toBeGreaterThan(0);
  });
});

describe("farmland generator — 2x2 seam via whole-artifact clip", () => {
  it("clips deterministically and keeps every coordinate inside its tile", () => {
    const region = regionFor(SQUARE);
    const network = generateFarmland(21, region, PARAMS(), CONSTRAINTS);
    const min = tileXYForPoint(region.bbox.minX, region.bbox.minY);
    const max = tileXYForPoint(region.bbox.maxX, region.bbox.maxY);
    let clipped = 0;
    for (let ty = min.tileY; ty <= max.tileY; ty++) {
      for (let tx = min.tileX; tx <= max.tileX; tx++) {
        const bb = tileBBox(tx, ty);
        const a = clipNetworkToTile(network, bb);
        const b = clipNetworkToTile(network, bb);
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
        for (const gid of Object.keys(a)) {
          for (const f of a[gid]) {
            for (const [x, y] of allCoords([f])) {
              expect(x).toBeGreaterThanOrEqual(bb.minX - 1e-3);
              expect(x).toBeLessThanOrEqual(bb.maxX + 1e-3);
              expect(y).toBeGreaterThanOrEqual(bb.minY - 1e-3);
              expect(y).toBeLessThanOrEqual(bb.maxY + 1e-3);
              clipped++;
            }
          }
        }
      }
    }
    expect(clipped).toBeGreaterThan(0);
  });
});

describe("farmland generator — metric bands (regression net)", () => {
  // The band is a tunable safety net: it survives a field/lane retune but
  // catches a field split or lane network that collapses. Measured on the
  // committed golden (enclosed-patchwork, 4242).
  it("golden fixture (enclosed-patchwork) lands inside its metric band", () => {
    const region = regionFor(SQUARE);
    const v = farmlandBandViolations(computeFarmlandMetrics(generateFarmland(4242, region, PARAMS(), CONSTRAINTS), region));
    expect(v, v.join("; ")).toEqual([]);
  });

  it("a smaller fieldSize splits the land into more fields (same region/seed)", () => {
    const region = regionFor(SQUARE);
    const small = computeFarmlandMetrics(generateFarmland(3, region, PARAMS({ fieldSize: 0.15 }), CONSTRAINTS), region);
    const big = computeFarmlandMetrics(generateFarmland(3, region, PARAMS({ fieldSize: 0.9 }), CONSTRAINTS), region);
    expect(small.fieldCount).toBeGreaterThan(big.fieldCount);
  });
});

// ─── Plan 035-C: farmland is the stage-4 PERI-URBAN band ─────────────────────
// Fixture: overlapMap S4 — the east farmland shares the main district's east
// edge exactly; the city is generated for real (its S4 procgen block) and its
// `city-street` LineStrings arrive as `constraints.upstream.settlement`, the
// data the host threads to a stage-4 consumer. Coupling under test: gate lanes
// radiate from the arterial exits; a field-size gradient runs toward the wall
// line; no upstream ⇒ byte-identical to the uncoupled generator.
describe("farmland generator — peri-urban settlement coupling (plan 035-C, S4)", () => {
  const M = OVERLAP_SCALE_M_PER_UNIT;
  const scaleRing = (ring: readonly Pt[]): Pt[] => {
    const open = ring.map(([x, y]): Pt => [x * M, y * M]);
    return [...open, [open[0][0], open[0][1]]];
  };

  const cityFeat = buildMainDistrict();
  const cityBlock = cityFeat.properties.procgen!;
  const cityRegion = makeRegion(String(cityFeat.id), scaleRing(MAIN_DISTRICT_RING));
  const cityNet = algorithmById("city")!.generate(cityBlock.seed, cityRegion, cityBlock.params, CONSTRAINTS);
  const streets = cityNet.filter((f) => (f.properties as { generatorId?: string } | null)?.generatorId === "city-street");
  const arterialLines: Pt[][] = streets
    .filter((f) => (f.properties as { roadClass?: string }).roadClass === "arterial")
    .map((f) => (f.geometry as GeoJSON.LineString).coordinates as Pt[]);

  const farmFeat = buildFarmlandEast();
  const farmSeed = farmFeat.properties.procgen!.seed;
  const farmRegion = makeRegion(String(farmFeat.id), scaleRing(FARMLAND_EAST_RING));
  const FARM_PARAMS = PARAMS({ fieldType: "enclosed-patchwork", fieldSize: 0.5, hedging: "hedgerows", laneDensity: 0.4, farmsteads: 0.45 });
  const withCity: GenerationConstraints = { ...CONSTRAINTS, upstream: { settlement: streets } };

  const coupled = generateFarmland(farmSeed, farmRegion, FARM_PARAMS, withCity);
  const bare = generateFarmland(farmSeed, farmRegion, FARM_PARAMS, CONSTRAINTS);

  const ofGid = (feats: GeoJSON.Feature[], gid: string): GeoJSON.Feature[] =>
    feats.filter((f) => (f.properties as { generatorId?: string }).generatorId === gid);

  /** Distance from a point to the nearest vertex of any arterial polyline. */
  function distToArterial(x: number, y: number): number {
    let best = Infinity;
    for (const line of arterialLines) {
      for (const [ax, ay] of line) best = Math.min(best, Math.hypot(x - ax, y - ay));
    }
    return best;
  }

  it("S4 premise: generated arterials exit the district against the shared edge (within the 45 m gate threshold)", () => {
    expect(arterialLines.length).toBeGreaterThan(0);
    let nearRing = 0;
    for (const line of arterialLines) {
      const d = Math.min(...line.map(([x, y]) => Math.abs(distanceToBoundary(farmRegion, x, y))));
      if (d <= 45) nearRing++;
    }
    expect(nearRing).toBeGreaterThan(0);
  });

  it("gate lanes radiate: new farm-lanes appear WITH the city, each starting at a gate entry on the ring", () => {
    const lanesBare = ofGid(bare, "farm-lane");
    const lanesCoupled = ofGid(coupled, "farm-lane");
    expect(lanesCoupled.length).toBeGreaterThan(lanesBare.length);
    // The added lanes hang off the ring where an arterial exits: each new lane
    // has an endpoint on the boundary near an arterial.
    const bareIds = new Set(lanesBare.map((f) => Number(f.id)));
    const added = lanesCoupled.filter((f) => !bareIds.has(Number(f.id)));
    expect(added.length).toBeGreaterThan(0);
    for (const lane of added) {
      const coords = (lane.geometry as GeoJSON.LineString).coordinates as Pt[];
      const ends = [coords[0], coords[coords.length - 1]];
      const onRingNearGate = ends.some(
        ([x, y]) => Math.abs(distanceToBoundary(farmRegion, x, y)) < 2 && distToArterial(x, y) <= 60
      );
      expect(onRingNearGate, `gate lane ${String(lane.id)} does not start at a gate entry`).toBe(true);
    }
  });

  it("field-size gradient: near the city fields are smaller AND more numerous; far fields are byte-identical", () => {
    const areaOf = (f: GeoJSON.Feature): number => {
      const ring = (f.geometry as GeoJSON.Polygon).coordinates[0] as Pt[];
      let a = 0;
      for (let i = 0; i + 1 < ring.length; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
      return Math.abs(a) / 2;
    };
    const centroidOf = (f: GeoJSON.Feature): Pt => {
      const ring = (f.geometry as GeoJSON.Polygon).coordinates[0] as Pt[];
      let cx = 0;
      let cy = 0;
      for (const [x, y] of ring) {
        cx += x;
        cy += y;
      }
      return [cx / ring.length, cy / ring.length];
    };
    const distToStreets = (p: Pt): number => {
      let best = Infinity;
      for (const f of streets) {
        for (const [sx, sy] of (f.geometry as GeoJSON.LineString).coordinates as Pt[]) {
          best = Math.min(best, Math.hypot(p[0] - sx, p[1] - sy));
        }
      }
      return best;
    };
    const NEAR = 240; // the generator's NEAR_CITY_M
    const nearOf = (feats: GeoJSON.Feature[]): GeoJSON.Feature[] =>
      ofGid(feats, "farm-field").filter((f) => distToStreets(centroidOf(f)) <= NEAR);
    const nearCoupled = nearOf(coupled);
    const nearBare = nearOf(bare);
    expect(nearCoupled.length).toBeGreaterThan(nearBare.length); // finer split near the wall
    const mean = (fs: GeoJSON.Feature[]): number => fs.reduce((s, f) => s + areaOf(f), 0) / fs.length;
    expect(mean(nearCoupled)).toBeLessThan(mean(nearBare)); // smaller closes near the wall
    // Cells beyond the gradient reach are untouched: every far field in the
    // coupled run exists byte-identically in the bare run (locality).
    const farBare = new Set(
      ofGid(bare, "farm-field")
        .filter((f) => distToStreets(centroidOf(f)) > NEAR + 160)
        .map((f) => JSON.stringify(f))
    );
    const farCoupled = ofGid(coupled, "farm-field").filter((f) => distToStreets(centroidOf(f)) > NEAR + 160);
    expect(farCoupled.length).toBeGreaterThan(0);
    for (const f of farCoupled) {
      expect(farBare.has(JSON.stringify(f)), `far field ${String(f.id)} changed under coupling`).toBe(true);
    }
  });

  it("the coupling applies to every rectangle-lattice fieldType (strips halve, sections quarter)", () => {
    for (const fieldType of ["open-field-strips", "grid-quarters", "orchard"] as const) {
      const p = PARAMS({ fieldType, hedging: "none" });
      const c = generateFarmland(farmSeed, farmRegion, p, withCity);
      const b = generateFarmland(farmSeed, farmRegion, p, CONSTRAINTS);
      expect(ofGid(c, "farm-field").length, fieldType).toBeGreaterThan(ofGid(b, "farm-field").length);
    }
  });

  it("no upstream ⇒ byte-identical (absent, empty object, empty settlement all no-op)", () => {
    const base = JSON.stringify(bare);
    expect(JSON.stringify(generateFarmland(farmSeed, farmRegion, FARM_PARAMS, { ...CONSTRAINTS, upstream: {} }))).toBe(base);
    expect(
      JSON.stringify(generateFarmland(farmSeed, farmRegion, FARM_PARAMS, { ...CONSTRAINTS, upstream: { settlement: [] } }))
    ).toBe(base);
  });

  it("coupled output is deterministic and stays inside the ring", () => {
    expect(JSON.stringify(generateFarmland(farmSeed, farmRegion, FARM_PARAMS, withCity))).toBe(JSON.stringify(coupled));
    expectGeneratorInvariants(coupled, farmRegion);
  });

  it("faubourg band: tagged garden plots + orchard rows line the city-facing ring, none without a city (shortlist item 9)", () => {
    const distToStreets = (p: Pt): number => {
      let best = Infinity;
      for (const f of streets) {
        for (const [sx, sy] of (f.geometry as GeoJSON.LineString).coordinates as Pt[]) {
          best = Math.min(best, Math.hypot(p[0] - sx, p[1] - sy));
        }
      }
      return best;
    };
    const faub = (feats: GeoJSON.Feature[]): GeoJSON.Feature[] =>
      feats.filter((f) => (f.properties as { faubourg?: boolean }).faubourg === true);
    // No city ⇒ NO faubourg feature (the byte-identity path).
    expect(faub(bare).length).toBe(0);
    const fb = faub(coupled);
    expect(fb.length).toBeGreaterThan(0);
    // Both kinds present + tagged: garden PLOTS (farm-field, crop "garden") and
    // orchard ROWS (orchard-tree points).
    const plots = fb.filter((f) => (f.properties as { generatorId?: string }).generatorId === "farm-field");
    const rows = fb.filter((f) => (f.properties as { generatorId?: string }).generatorId === "orchard-tree");
    expect(plots.length).toBeGreaterThan(0);
    expect(rows.length).toBeGreaterThan(0);
    expect((plots[0].properties as { crop?: string }).crop).toBe("garden");
    // Every faubourg feature is a NARROW strip just inside the ring (between the
    // wall and the fields) AND near the generated city fabric.
    for (const f of fb) {
      const c = (f.geometry.type === "Point"
        ? (f.geometry as GeoJSON.Point).coordinates
        : ((f.geometry as GeoJSON.Polygon).coordinates[0][0] as number[])) as Pt;
      expect(distanceToBoundary(farmRegion, c[0], c[1])).toBeGreaterThanOrEqual(0);
      expect(distanceToBoundary(farmRegion, c[0], c[1])).toBeLessThan(40);
      // distToStreets here measures to street VERTICES; the generator gates on
      // point-to-SEGMENT distance ≤ 120 m, so a comfortable vertex-distance bound.
      expect(distToStreets(c)).toBeLessThan(250);
    }
  });

  it("gate lanes are tamed: no farm-lane crosses more than 2 field cells in a straight diagonal run (shortlist item 8)", () => {
    // N = 2 cells. Justification: the ONLY diagonal run of a gate lane is the stub
    // from the ring gate to the first field-cell boundary, capped at
    // GATE_STUB_MAX_CELLS = 1.5 cells; N = 2 gives quantization headroom. Past the
    // stub the lane follows axis-aligned field edges (excluded from this metric).
    const cellM = fieldCellM(0.5); // FARM_PARAMS fieldSize
    const N = 2;
    expect(maxDiagonalLaneRunCells(coupled, cellM)).toBeLessThanOrEqual(N);
    // The gate lanes ARE diagonal stubs (jittered) — the metric is > 0 with a city…
    expect(maxDiagonalLaneRunCells(coupled, cellM)).toBeGreaterThan(0);
    // …and there are NO diagonal lanes at all without the city (byte-identity path:
    // the regular lane web is purely axis-aligned).
    expect(maxDiagonalLaneRunCells(bare, cellM)).toBe(0);
  });
});
