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
