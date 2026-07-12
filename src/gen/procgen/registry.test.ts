import { describe, expect, it } from "vitest";
import { algorithmForKind, algorithmById, CITY_PROFILE_IDS } from "./registry";
import { makeRegion } from "../region";
import { discToRing, makeDomain } from "../citynet";
import type { BBox } from "../spatialHash";

const WORLD_BOUNDS: BBox = { minX: -4000, minY: -4000, maxX: 4000, maxY: 4000 };

describe("procgen registry (plan 020 §5)", () => {
  it("binds district → city and resolves by id; other kinds have no algorithm", () => {
    expect(algorithmForKind("district")?.id).toBe("city");
    expect(algorithmById("city")?.label).toBe("City");
    expect(algorithmForKind("park")).toBeUndefined();
    expect(algorithmForKind("road")).toBeUndefined();
    expect(algorithmById("nope")).toBeUndefined();
  });

  it("defaultParams follows the theme→profile mapping", () => {
    const city = algorithmById("city")!;
    expect(city.defaultParams("parchment")).toEqual({ profile: "euro-medieval" });
    expect(city.defaultParams("modern-clean")).toEqual({ profile: "na-grid" });
    expect(city.defaultParams("obsidian-native")).toEqual({ profile: "euro-medieval" });
  });

  it("paramsSchema accepts the four profiles and rejects junk", () => {
    const city = algorithmById("city")!;
    for (const profile of CITY_PROFILE_IDS) {
      expect(city.paramsSchema.safeParse({ profile }).success).toBe(true);
    }
    expect(city.paramsSchema.safeParse({ profile: "atlantis" }).success).toBe(false);
    expect(city.paramsSchema.safeParse({}).success).toBe(false);
  });

  it("exposes the citynet tile generator ids and generates through the region path", () => {
    const city = algorithmById("city")!;
    expect(city.tileGeneratorIds).toContain("city-street");
    expect(city.tileGeneratorIds).toContain("city-district");
    const domain = makeDomain(600, 600, 900, "euro-medieval", 0);
    const region = makeRegion("reg-1", discToRing(domain));
    const features = city.generate(
      12345,
      region,
      { profile: "euro-medieval" },
      { worldBounds: WORLD_BOUNDS }
    );
    expect(features.length).toBeGreaterThan(100);
    expect(features.every((f) => f.properties?.regionId === "reg-1")).toBe(true);
  });
});
