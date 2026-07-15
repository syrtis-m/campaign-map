// Plan 038 item 2 — riverine farmland long-lots (Quebec rang) + water-meadow tag.
//
// Where the GENERATED river channel crosses a farmland region, the fields within
// ~1–2 field depths of the bank become narrow holdings run PERPENDICULAR to the
// water (the rang / arpent pattern); the near end of each lot carries a
// `waterMeadow` tag (a theme-painted property). Pinned seeds; within-file
// relative comparisons only (no cross-run byte-equality):
//   (a) with a channel, `bankLot` fields appear + carry `waterMeadow` on the near cell,
//   (b) the long-lots are PERPENDICULAR to the bank (long axis ≈ inland normal),
//   (c) NO upstream water ⇒ byte-identical to the uncoupled generator (23-E),
//   (d) every lot stays inside the region and out of the channel,
//   (e) paddy-terraces is excluded (no bankLot fields).
import { describe, expect, it } from "vitest";
import { generateFarmland, fieldCellM, type FarmlandParams } from "./farmland";
import { generateRiver, riverMaxOffset } from "./river";
import { makeRegion, makeSpine, makeCorridorRegion, distanceToBoundary } from "./region";
import { buildUpstreamWaterField } from "./upstream";
import type { BBox } from "./spatialHash";

type Pt = [number, number];

const WORLD: BBox = { minX: -5000, minY: -5000, maxX: 5000, maxY: 5000 };

// A river spine running W→E across the origin.
const SPINE: Pt[] = [
  [-600, 20],
  [-300, -60],
  [0, 40],
  [300, -30],
  [600, 10],
];

function channelWater(): GeoJSON.Feature[] {
  const params = { windiness: 0.8, braiding: 0, width: 40, widthGrowth: 0, braidBias: 0, slopeSensitivity: 0 };
  const region = makeCorridorRegion("frl-river", makeSpine("frl-river", SPINE), riverMaxOffset(params));
  return generateRiver(5151, region, params, { worldBounds: WORLD }).filter(
    (f) => (f.properties as { generatorId?: string } | null)?.generatorId === "river-channel"
  );
}

function boxRing(minX: number, minY: number, maxX: number, maxY: number): Pt[] {
  return [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
    [minX, minY],
  ];
}

const WATER = channelWater();
const CHAN = buildUpstreamWaterField({ water: WATER })!;
const REGION = makeRegion("frl-farm", boxRing(-500, -300, 500, 300));
const PARAMS: FarmlandParams = {
  fieldType: "enclosed-patchwork",
  fieldSize: 0.5,
  hedging: "hedgerows",
  laneDensity: 0.4,
  farmsteads: 0.4,
};
const SEED = 771;

function bankLots(feats: GeoJSON.Feature[]): GeoJSON.Feature[] {
  return feats.filter((f) => (f.properties as { bankLot?: boolean }).bankLot === true);
}

/** Inland unit direction (−∇channel) at (x,y). */
function inward(x: number, y: number): Pt {
  const gx = CHAN(x + 1, y) - CHAN(x - 1, y);
  const gy = CHAN(x, y + 1) - CHAN(x, y - 1);
  const l = Math.hypot(gx, gy) || 1;
  return [-gx / l, -gy / l];
}

/** The long-axis unit vector of a 4-corner (+closing) field polygon. */
function longAxis(f: GeoJSON.Feature): Pt {
  const ring = (f.geometry as GeoJSON.Polygon).coordinates[0] as Pt[];
  // Two edges out of corner 0: 0→1 and 0→3. The longer is the lot's long axis.
  const e1: Pt = [ring[1][0] - ring[0][0], ring[1][1] - ring[0][1]];
  const e3: Pt = [ring[3][0] - ring[0][0], ring[3][1] - ring[0][1]];
  const l1 = Math.hypot(e1[0], e1[1]);
  const l3 = Math.hypot(e3[0], e3[1]);
  const e = l1 >= l3 ? e1 : e3;
  const l = Math.hypot(e[0], e[1]) || 1;
  return [e[0] / l, e[1] / l];
}

function centroid(f: GeoJSON.Feature): Pt {
  const ring = (f.geometry as GeoJSON.Polygon).coordinates[0] as Pt[];
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    sx += ring[i][0];
    sy += ring[i][1];
  }
  const n = ring.length - 1;
  return [sx / n, sy / n];
}

describe("riverine farmland long-lots (plan 038 item 2)", () => {
  const coupled = generateFarmland(SEED, REGION, PARAMS, { worldBounds: WORLD, upstream: { water: WATER } });

  it("(a) a channel crossing mints bankLot long-lots + water-meadow tags", () => {
    const lots = bankLots(coupled);
    expect(lots.length).toBeGreaterThan(6);
    const meadows = lots.filter((f) => (f.properties as { waterMeadow?: boolean }).waterMeadow === true);
    expect(meadows.length).toBeGreaterThan(0);
    // Water-meadow lots carry the paint crop hook.
    expect((meadows[0].properties as { crop?: string }).crop).toBe("water-meadow");
  });

  it("(b) the long-lots run perpendicular to the bank (long axis ≈ inland normal)", () => {
    const lots = bankLots(coupled);
    let aligned = 0;
    for (const f of lots) {
      const c = centroid(f);
      const n = inward(c[0], c[1]);
      const a = longAxis(f);
      // |long-axis · inland-normal| high ⇒ the lot stretches inland (perpendicular
      // to the bank), never runs along it.
      if (Math.abs(a[0] * n[0] + a[1] * n[1]) > 0.7) aligned++;
    }
    // The strong majority of lots are inland-oriented (a meander's tight bends
    // leave a few oblique ones — a band, not a hard all).
    expect(aligned / lots.length).toBeGreaterThan(0.8);
  });

  it("(c) no upstream water ⇒ byte-identical to the uncoupled generator", () => {
    const base = JSON.stringify(generateFarmland(SEED, REGION, PARAMS, { worldBounds: WORLD }));
    expect(JSON.stringify(generateFarmland(SEED, REGION, PARAMS, { worldBounds: WORLD, upstream: undefined }))).toBe(base);
    expect(
      JSON.stringify(generateFarmland(SEED, REGION, PARAMS, { worldBounds: WORLD, upstream: { water: [] } }))
    ).toBe(base);
    // And bankLots exist only in the coupled output.
    expect(bankLots(JSON.parse(base)).length).toBe(0);
    expect(bankLots(coupled).length).toBeGreaterThan(0);
  });

  it("(d) every lot stays inside the region and clear of the channel", () => {
    for (const f of bankLots(coupled)) {
      for (const [x, y] of (f.geometry as GeoJSON.Polygon).coordinates[0] as Pt[]) {
        expect(distanceToBoundary(REGION, x, y)).toBeGreaterThanOrEqual(-1.01);
        expect(CHAN(x, y)).toBeLessThan(0.01); // outside the channel
      }
    }
  });

  it("(f) the rang band stays bank-local — no lot reaches beyond one field-cell of the water (no whole-region sweep)", () => {
    // Regression net for Jonah's Vailmarch Marnside report (2026-07-15): the lot
    // DEPTH is now scaled to its own frontage, not the coarse `cell`. A holding
    // reaches ~1–2 emitted-field depths (a fraction of the cell) inland; the old
    // `1.6·cell` reach ran the lots ≈1.6 cells deep, so against a river crossing
    // the region the band filled the WHOLE patch with sweeping ribbons. Assert the
    // deepest lot vertex sits within one coarse field-cell of the bank.
    const cell = fieldCellM(PARAMS.fieldSize);
    let deepest = 0;
    for (const f of bankLots(coupled)) {
      for (const [x, y] of (f.geometry as GeoJSON.Polygon).coordinates[0] as Pt[]) {
        deepest = Math.max(deepest, -CHAN(x, y)); // metres inland of the bank (SDF < 0 outside)
      }
    }
    expect(deepest).toBeGreaterThan(0); // lots do reach inland (it is a long-lot band)
    expect(deepest).toBeLessThan(cell); // …but bank-local, never the whole-region ribbon
  });

  it("(e) paddy-terraces is excluded from rang lots (its own riverine culture)", () => {
    const paddy = generateFarmland(SEED, REGION, { ...PARAMS, fieldType: "paddy-terraces", hedging: "none" }, {
      worldBounds: WORLD,
      upstream: { water: WATER },
    });
    expect(bankLots(paddy).length).toBe(0);
  });

  it("is deterministic (double-run byte-identical) with the channel", () => {
    const a = generateFarmland(SEED, REGION, PARAMS, { worldBounds: WORLD, upstream: { water: WATER } });
    const b = generateFarmland(SEED, REGION, PARAMS, { worldBounds: WORLD, upstream: { water: WATER } });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
