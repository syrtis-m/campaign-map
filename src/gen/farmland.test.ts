import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { generateFarmland, type FarmlandParams } from "./farmland";
import { makeRegion, distanceToBoundary, type ProcgenRegion } from "./region";
import type { GenerationConstraints } from "./types";
import { clipNetworkToTile } from "./citynet";
import { tileBBox, tileXYForPoint } from "./cache/tileGrid";

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
    const a = generateFarmland(1234, region, PARAMS(), CONSTRAINTS);
    const b = generateFarmland(1234, region, PARAMS(), CONSTRAINTS);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.length).toBeGreaterThan(0);
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

describe("farmland generator — containment (every coordinate inside the ring)", () => {
  for (const fieldType of ["open-field-strips", "enclosed-patchwork", "grid-quarters", "orchard"] as const) {
    it(`all output inside the ring — ${fieldType}`, () => {
      const region = regionFor(SQUARE);
      const feats = generateFarmland(99, region, PARAMS({ fieldType }), CONSTRAINTS);
      expect(feats.length).toBeGreaterThan(0);
      for (const [x, y] of allCoords(feats)) {
        expect(distanceToBoundary(region, x, y)).toBeGreaterThanOrEqual(-1);
      }
    });
  }

  it("stays inside a strongly concave (L-shaped) region — no field bridges the notch", () => {
    const region = regionFor(L_SHAPE);
    const feats = generateFarmland(42, region, PARAMS(), CONSTRAINTS);
    expect(feats.length).toBeGreaterThan(0);
    for (const [x, y] of allCoords(feats)) {
      expect(distanceToBoundary(region, x, y)).toBeGreaterThanOrEqual(-1);
    }
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
  it("farmland never reads its constraints (unused arg) — output is identical with or without busy fabric", () => {
    const region = regionFor(SQUARE);
    const bare = generateFarmland(7, region, PARAMS(), CONSTRAINTS);
    // Constraints carrying arbitrary sketched fabric (incl. a city district and
    // even another farmland) must not perturb farmland — the generator never
    // sees anything downstream (stage layering, plan 022 §3.5; `_constraints`
    // is accepted for signature parity only). Farmland reading the city would
    // be a stage-3→2 cascade cycle, which is rejected.
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
      ],
    };
    const withBusy = generateFarmland(7, region, PARAMS(), busy);
    expect(JSON.stringify(withBusy)).toBe(JSON.stringify(bare));
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
