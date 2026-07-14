import { describe, expect, it } from "vitest";
import {
  algorithmForKind,
  algorithmById,
  CITY_PROFILE_IDS,
  matchingPresetId,
  presetById,
} from "./registry";
import { makeRegion } from "../region";
import { discToRing, makeDomain } from "../citynet";
import type { BBox } from "../spatialHash";
import { THEME_IDS } from "../../model/campaignConfig";

const WORLD_BOUNDS: BBox = { minX: -4000, minY: -4000, maxX: 4000, maxY: 4000 };

describe("procgen registry (plan 020 §5)", () => {
  it("binds district → city and park → park (plan 022 §3.3); road has no algorithm", () => {
    expect(algorithmForKind("district")?.id).toBe("city");
    expect(algorithmById("city")?.label).toBe("City");
    // Park is no longer inert — plan 022 §3.3 binds it to the park generator.
    expect(algorithmForKind("park")?.id).toBe("park");
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

describe("procgen presets (plan 022 §1)", () => {
  it("registry contract: every algorithm has ≥1 preset and defaultPresetId is always valid", () => {
    // Reach REGISTRY through the only public door — city is the only entry v1,
    // but the contract must hold for every algorithm we can name.
    const algorithms = [algorithmById("city")!];
    for (const algo of algorithms) {
      expect(algo.presets.length).toBeGreaterThan(0);
      // Preset ids are unique (a dropdown keys on them).
      const ids = algo.presets.map((p) => p.id);
      expect(new Set(ids).size).toBe(ids.length);
      // defaultPresetId returns a real preset id for EVERY canonical theme
      // (plus an unknown/absent theme — the forgiving fallback).
      for (const theme of [...THEME_IDS, "not-a-theme", ""]) {
        const id = algo.defaultPresetId(theme);
        expect(presetById(algo, id), `theme ${theme} → ${id}`).toBeDefined();
      }
      // Each preset's params must satisfy the algorithm's own schema.
      for (const preset of algo.presets) {
        expect(algo.paramsSchema.safeParse(preset.params).success, `preset ${preset.id}`).toBe(true);
      }
    }
  });

  it("city: the four profiles ARE the presets (id === profile), 1:1", () => {
    const city = algorithmById("city")!;
    expect(city.presets.map((p) => p.id).sort()).toEqual([...CITY_PROFILE_IDS].sort());
    for (const preset of city.presets) {
      expect(preset.params).toEqual({ profile: preset.id });
    }
  });

  it("preset→params seeding: defaultParams is exactly the default preset's params", () => {
    const city = algorithmById("city")!;
    for (const theme of [...THEME_IDS, "unknown"]) {
      const presetId = city.defaultPresetId(theme);
      expect(city.defaultParams(theme)).toEqual(presetById(city, presetId)!.params);
    }
    // Sanity: theme mapping unchanged from pre-022 behavior.
    expect(city.defaultParams("parchment")).toEqual({ profile: "euro-medieval" });
    expect(city.defaultParams("modern-clean")).toEqual({ profile: "na-grid" });
  });

  it("custom-detection: matchingPresetId hits an exact preset, ignores orthogonal keys, misses on a tweak", () => {
    const city = algorithmById("city")!;
    // Exact match on the preset's params.
    expect(matchingPresetId(city, { profile: "na-grid" })).toBe("na-grid");
    // Orthogonal keys (a GM-placed center) do NOT break the template match.
    expect(matchingPresetId(city, { profile: "euro-medieval", center: [1, 2] })).toBe("euro-medieval");
    // A value the preset defines, changed away from every preset → Custom.
    // (city can't reach this via its UI, but the mechanism must be real.)
    expect(matchingPresetId(city, { profile: "atlantis" })).toBeUndefined();
    // Missing a preset-defined key → no match.
    expect(matchingPresetId(city, {})).toBeUndefined();
  });

  it("presetById resolves and misses cleanly", () => {
    const city = algorithmById("city")!;
    expect(presetById(city, "na-suburb")?.params).toEqual({ profile: "na-suburb" });
    expect(presetById(city, "nope")).toBeUndefined();
  });
});
