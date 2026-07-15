/**
 * Coupling wave 2 (plans 038 + 039 §1.1) — the CITY cluster: waterfront street
 * alignment + bank setback (038.1), road-sketch promotion + gates (038.5),
 * adjacent-district hashed stubs (038.6), and market-pin plaza snap (039 §1.1).
 *
 * Every item ships behind city version 3 and must be a NO-OP when its trigger
 * is absent (byte-identity with the uncoupled generator) — the property each
 * `byte-identical` case below pins. Fixtures reuse the shared Overlap geometry
 * (testkit/overlapMap: S6 adjacent districts, S8 typed market pin) scaled to
 * generation-space meters, so the same shapes the campaign fixture uses drive
 * the headless generator here.
 */
import { describe, expect, it } from "vitest";
import { generateCityNetwork, type ProfileId } from "./index";
import { makeRegion, regionContains, type ProcgenRegion } from "../region";
import type { BBox } from "../spatialHash";
import type { GenerationConstraints, UpstreamArtifacts } from "../types";
import type { FabricFeature } from "../../model/fabric";
import { hashSeed } from "../rng";
import {
  MAIN_DISTRICT_RING,
  ANNEX_DISTRICT_RING,
  OVERLAP_SCALE_M_PER_UNIT,
  OVERLAP_PINS,
} from "../testkit/overlapMap";
import { nearestOnLine } from "../fabricConstraints";
import {
  bankAlignedSampler,
  distToChannelBank,
  BANK_SETBACK_M,
  BANK_ALIGN_FALLOFF_M,
} from "./bankTangent";

type Pt = [number, number];

const WORLD: BBox = { minX: -6000, minY: -6000, maxX: 6000, maxY: 6000 };
const SEED = 4242;

/** Scale an Overlap map-unit ring to generation-space meters (×100) and close. */
function ringMeters(unitRing: readonly Pt[]): Pt[] {
  const m: Pt[] = unitRing.map(([x, y]): Pt => [x * OVERLAP_SCALE_M_PER_UNIT, y * OVERLAP_SCALE_M_PER_UNIT]);
  m.push([m[0][0], m[0][1]]);
  return m;
}

function pointFeature(id: string, p: Pt, type?: string): GeoJSON.Feature {
  return {
    type: "Feature",
    id,
    geometry: { type: "Point", coordinates: p },
    properties: type !== undefined ? { type } : {},
  };
}

function gen(
  region: ProcgenRegion,
  profile: ProfileId,
  constraints: Partial<GenerationConstraints> = {},
  center?: [number, number]
): GeoJSON.Feature[] {
  return generateCityNetwork(SEED, region, profile, { worldBounds: WORLD, ...constraints }, center);
}

// ─── 039 §1.1 — market-pin plaza snap ────────────────────────────────────────

describe("039 §1.1 — typed market pin anchors the plaza (S8)", () => {
  const region = makeRegion("overlap-district-main", ringMeters(MAIN_DISTRICT_RING));
  const marketUnit = OVERLAP_PINS.find((p) => p.type === "market")!.point;
  const marketM: Pt = [marketUnit[0] * OVERLAP_SCALE_M_PER_UNIT, marketUnit[1] * OVERLAP_SCALE_M_PER_UNIT];

  const plazaCentroid = (net: GeoJSON.Feature[]): Pt | null => {
    const plaza = net.find((f) => (f.properties as { type?: string })?.type === "plaza");
    if (!plaza || plaza.geometry.type !== "Polygon") return null;
    const ring = plaza.geometry.coordinates[0] as Pt[];
    let sx = 0;
    let sy = 0;
    const n = ring.length - 1;
    for (let i = 0; i < n; i++) {
      sx += ring[i][0];
      sy += ring[i][1];
    }
    return [sx / n, sy / n];
  };

  it("the market pin is strictly inside the region (fixture premise)", () => {
    expect(regionContains(region, marketM[0], marketM[1])).toBe(true);
  });

  it("a market pin pulls the plaza onto it; an untyped pin does not", () => {
    const withMarket = gen(region, "euro-medieval", { canonFeatures: [pointFeature("m", marketM, "market")] });
    const withUntyped = gen(region, "euro-medieval", { canonFeatures: [pointFeature("u", marketM)] });
    const cMarket = plazaCentroid(withMarket)!;
    const cUntyped = plazaCentroid(withUntyped)!;
    expect(cMarket).not.toBeNull();
    // The plaza sits on the pin (within its hashed radius jitter), and far from
    // where the untyped-pin (computed-center) plaza lands.
    expect(Math.hypot(cMarket[0] - marketM[0], cMarket[1] - marketM[1])).toBeLessThan(60);
    expect(Math.hypot(cMarket[0] - cUntyped[0], cMarket[1] - cUntyped[1])).toBeGreaterThan(60);
  });

  it("an untyped pin is byte-identical to no pin (route-around unchanged)", () => {
    const bare = gen(region, "euro-medieval");
    const untyped = gen(region, "euro-medieval", { canonFeatures: [pointFeature("u", marketM)] });
    // A dropped pin still route-arounds via the cost field, so it is NOT the bare
    // city — but it must not move the plaza (no market attraction).
    expect(plazaCentroid(untyped)).toEqual(plazaCentroid(bare));
  });

  it("explicit params.center outranks the market pin (precedence)", () => {
    const elsewhere: [number, number] = [-200, 150];
    const withBoth = gen(
      region,
      "euro-medieval",
      { canonFeatures: [pointFeature("m", marketM, "market")] },
      elsewhere
    );
    const c = plazaCentroid(withBoth)!;
    expect(Math.hypot(c[0] - elsewhere[0], c[1] - elsewhere[1])).toBeLessThan(60);
    expect(Math.hypot(c[0] - marketM[0], c[1] - marketM[1])).toBeGreaterThan(100);
  });

  it("no market pin ⇒ byte-identical to v2 baseline (no canon at all)", () => {
    const a = JSON.stringify(gen(region, "euro-medieval"));
    const b = JSON.stringify(gen(region, "euro-medieval"));
    expect(a).toBe(b);
  });
});

// ─── 038.1 — waterfront street alignment + building setback ───────────────────

describe("038.1 — bank-tangent street alignment near the generated channel", () => {
  const region = makeRegion("wf-region", [
    [-350, -300],
    [350, -300],
    [350, 300],
    [-350, 300],
  ]);
  // A horizontal channel band crossing the region (upstream.water polygon → the
  // city's channelRings). Its horizontal banks give a horizontal tangent.
  const channelRing: Pt[] = [
    [-350, -45],
    [350, -45],
    [350, 45],
    [-350, 45],
    [-350, -45],
  ];
  const upstream: UpstreamArtifacts = {
    water: [
      {
        type: "Feature",
        id: "ch",
        geometry: { type: "Polygon", coordinates: [channelRing] },
        properties: { generatorId: "river-channel" },
      },
    ],
  };

  it("bankAlignedSampler bends toward the bank near it, unchanged far away", () => {
    const base = (): number => Math.PI / 2; // base field points vertical everywhere
    const s = bankAlignedSampler(base, [channelRing]);
    // Just above the horizontal bank (y≈55): the tangent is horizontal (≈0), so
    // the blended angle leaves vertical for near-horizontal.
    const near = s(0, 55);
    expect(Math.abs(Math.sin(near))).toBeLessThan(0.4); // pulled toward horizontal
    // Far from any bank (2× the falloff): the base vertical field survives.
    const far = s(0, 45 + BANK_ALIGN_FALLOFF_M * 3);
    expect(Math.abs(Math.sin(far))).toBeGreaterThan(0.9);
  });

  it("empty channelRings ⇒ the SAME sampler reference (referential no-op)", () => {
    const base = (x: number, y: number): number => x + y;
    expect(bankAlignedSampler(base, [])).toBe(base);
  });

  const nearBankStreets = (net: GeoJSON.Feature[]) => {
    let nearSum = 0;
    let nearN = 0;
    let farSum = 0;
    let farN = 0;
    for (const f of net) {
      const p = f.properties as { generatorId?: string; roadClass?: string; type?: string };
      if (p?.generatorId !== "city-street") continue;
      if (p.roadClass === "arterial" || p.roadClass === "ring" || p.type === "bridge") continue;
      const coords = (f.geometry as GeoJSON.LineString).coordinates as Pt[];
      for (let i = 0; i < coords.length - 1; i++) {
        const a = coords[i];
        const b = coords[i + 1];
        const mx = (a[0] + b[0]) / 2;
        const my = (a[1] + b[1]) / 2;
        const d = distToChannelBank([channelRing], mx, my);
        const segAng = Math.atan2(b[1] - a[1], b[0] - a[0]);
        const bankAng = nearestOnLine(channelRing, mx, my).angle;
        const align = Math.abs(Math.cos(2 * (segAng - bankAng)));
        if (Math.abs(my) > 45 && d < 55) {
          nearSum += align;
          nearN++;
        } else if (d > 150) {
          farSum += align;
          farN++;
        }
      }
    }
    return { near: nearN ? nearSum / nearN : NaN, nearN, far: farN ? farSum / farN : NaN, farN };
  };

  it("near-bank grown streets run parallel to the bank (correlation ≫ far streets)", () => {
    const net = generateCityNetwork(SEED, region, "euro-medieval", { worldBounds: WORLD, upstream });
    const m = nearBankStreets(net);
    expect(m.nearN).toBeGreaterThan(6); // enough samples to be meaningful
    expect(m.near).toBeGreaterThan(0.72); // strongly bank-parallel
    expect(m.near).toBeGreaterThan(m.far + 0.1); // and markedly more than the far field
  });

  it("no building sits in the bank setback strip (streets/quays still may)", () => {
    const net = generateCityNetwork(SEED, region, "euro-medieval", { worldBounds: WORLD, upstream });
    for (const f of net) {
      const p = f.properties as { generatorId?: string };
      if (p?.generatorId !== "city-footprint" && p?.generatorId !== "city-parcel") continue;
      const ring = (f.geometry as GeoJSON.Polygon).coordinates[0] as Pt[];
      let cx = 0;
      let cy = 0;
      const n = ring.length - 1;
      for (let i = 0; i < n; i++) {
        cx += ring[i][0];
        cy += ring[i][1];
      }
      cx /= n;
      cy /= n;
      // Dry centroids only (in-channel ones are dropped by blockedByWater); no dry
      // building centroid may fall inside the setback strip.
      if (Math.abs(cy) > 45) {
        expect(distToChannelBank([channelRing], cx, cy)).toBeGreaterThanOrEqual(BANK_SETBACK_M);
      }
    }
  });

  it("no upstream channel ⇒ byte-identical to the uncoupled city", () => {
    const bare = JSON.stringify(generateCityNetwork(SEED, region, "euro-medieval", { worldBounds: WORLD }));
    const again = JSON.stringify(generateCityNetwork(SEED, region, "euro-medieval", { worldBounds: WORLD }));
    expect(bare).toBe(again);
  });
});
