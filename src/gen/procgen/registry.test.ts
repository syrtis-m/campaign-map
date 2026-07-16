import { describe, expect, it } from "vitest";
import {
  algorithmForKind,
  algorithmById,
  allAlgorithms,
  dagRoleFor,
  CITY_PROFILE_IDS,
  matchingPresetId,
  presetById,
  type DagRole,
  type ProcgenAlgorithm,
} from "./registry";
import { makeRegion } from "../region";
import { discToRing, makeDomain } from "../citynet";
import type { BBox } from "../spatialHash";
import { THEME_IDS } from "../../model/campaignConfig";

const WORLD_BOUNDS: BBox = { minX: -4000, minY: -4000, maxX: 4000, maxY: 4000 };

describe("procgen registry", () => {
  it("binds district → city and park → park; road has no algorithm", () => {
    expect(algorithmForKind("district")?.id).toBe("city");
    expect(algorithmById("city")?.label).toBe("City");
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

describe("river v2 (plan 035) — default-off slope coupling, stage 0 hydrology", () => {
  it("river is at contract version 3 (plan 038 item 3 tributary rank; v2 was the slopeSensitivity default flip)", () => {
    expect(algorithmById("river")!.currentVersion).toBe(3);
  });

  it("slopeSensitivity defaults to 0 — terrain coupling is opt-in", () => {
    const river = algorithmById("river")!;
    const parsed = river.paramsSchema.parse({}) as { slopeSensitivity: number };
    expect(parsed.slopeSensitivity).toBe(0);
  });

  it("river sits at stage 0 (hydrology, below terrain) and consumes NO region currency", () => {
    const river = algorithmById("river")!;
    expect(river.stage).toBe(0);
    expect(river.consumes).toEqual([]);
    // The opt-in macro-terrain read stays a raw-sketch declaration, not a
    // currency: mountain remains in consumesSketch (the 033 harness probes with
    // slopeSensitivity 1, the most-consuming params).
    expect(river.consumesSketch).toContain("mountain");
  });

  it("mountain-torrent is the one preset that opts INTO slope coupling", () => {
    const river = algorithmById("river")!;
    for (const preset of river.presets) {
      const s = (preset.params as { slopeSensitivity?: number }).slopeSensitivity;
      expect(s, preset.id).toBe(preset.id === "mountain-torrent" ? 1 : 0);
    }
  });
});

describe("consumption declarations (plan 033-C)", () => {
  // The exact declarations the 033-A under-invalidation harness verifies and
  // the scoped invalidation walk / fingerprints key on. A change here is a
  // change to the invalidation contract — it must ride an algorithm version
  // bump + a re-run of underInvalidation.fuzz.test.ts. Kinds compared as sets.
  const EXPECTED: Record<
    string,
    { kinds: string[]; margin: number; cost: "cheap" | "medium" | "expensive" }
  > = {
    city: { kinds: ["water", "river", "road", "wall", "farmland", "park", "district"], margin: 1500, cost: "expensive" },
    // Ruling 2026-07-15: the terrain readers gain relief/landform (the composed
    // global terrain field, not a mountain polygon). The terrain-stamp kinds use
    // a PER-FEATURE reach (`terrainStampSupport`), so `margin` still governs only
    // the non-terrain kinds.
    river: { kinds: ["water", "river", "mountain", "relief", "landform"], margin: 30, cost: "medium" },
    // plan 038 item 4 (terrain read) + item 7 (forest↔farmland/park
    // shared-boundary hedgerow, HEDGE_ADJ_EPS margin 8).
    forest: { kinds: ["mountain", "relief", "landform", "farmland", "park"], margin: 8, cost: "cheap" },
    park: { kinds: ["road", "forest", "farmland"], margin: 30, cost: "medium" },
    wall: { kinds: ["road"], margin: 0, cost: "medium" },
    farmland: { kinds: ["mountain", "relief", "landform", "forest", "park"], margin: 8, cost: "medium" },
    mountain: { kinds: [], margin: 0, cost: "cheap" },
    // plan 036 terrain stamps: field-only add/replace, read no other sketch.
    relief: { kinds: [], margin: 0, cost: "cheap" },
    landform: { kinds: [], margin: 0, cost: "cheap" },
  };

  it("every algorithm's consumesSketch / influenceMargin / costClass match the measured table", () => {
    for (const alg of allAlgorithms()) {
      const exp = EXPECTED[alg.id];
      expect(exp, `no expectation for algorithm "${alg.id}"`).toBeDefined();
      expect([...alg.consumesSketch].sort(), `${alg.id} consumesSketch`).toEqual([...exp.kinds].sort());
      expect(alg.influenceMargin, `${alg.id} influenceMargin`).toBe(exp.margin);
      expect(alg.costClass, `${alg.id} costClass`).toBe(exp.cost);
    }
  });

  it("a no-consumption algorithm declares an empty set and a 0 margin", () => {
    // forest joined the consumers in plan 038 (mountain terrain + sketch
    // adjacency); mountain/relief/landform stay pure field producers.
    for (const id of ["mountain", "relief", "landform"]) {
      const alg = algorithmById(id)!;
      expect(alg.consumesSketch).toEqual([]);
      expect(alg.influenceMargin).toBe(0);
    }
  });
});

/** Every DAG role an algorithm can resolve to: the static fields plus one per
 * preset (presets cover every params-dependent branch — park's varieties). */
function rolesOf(alg: ProcgenAlgorithm): DagRole[] {
  return [dagRoleFor(alg, {}), ...alg.presets.map((p) => dagRoleFor(alg, p.params))];
}

// ─── THE CYCLE-GUARD INVARIANT (plan 035 §0 — a standing registry contract) ──
// Nothing may consume `settlement` while producing a currency the city
// consumes. This is the bidirectional trap that would make "city ⇄ its own
// dependent" possible the day someone wires the urban-park (or a plan-037/038
// consumer) back into the city's growth cost. Asserted over EVERY resolvable
// role of EVERY algorithm, so a new preset/variety/algorithm that violates it
// fails here before it can ship. Guards plans 037/038 too — do not weaken.
describe("cycle guard — settlement consumers produce nothing the city consumes (plan 035)", () => {
  it("for every algorithm × role: consumes settlement ⇒ produces ∩ city.consumes = ∅", () => {
    const city = algorithmById("city")!;
    // The union of everything ANY city role consumes (city has no dagRole today,
    // but the guard must keep holding if it ever grows one).
    const cityConsumes = new Set(rolesOf(city).flatMap((r) => [...r.consumes]));
    for (const alg of allAlgorithms()) {
      for (const role of rolesOf(alg)) {
        if (!role.consumes.includes("settlement")) continue;
        for (const produced of role.produces) {
          expect(
            cityConsumes.has(produced),
            `${alg.id} consumes settlement but produces "${produced}", which the city consumes — ` +
              `that is a city ⇄ dependent coupling loop (plan 035 cycle guard)`
          ).toBe(false);
        }
        // And a settlement consumer must sit strictly ABOVE the city's stage —
        // the DAG edge rule makes a same/lower-stage declaration dead, which
        // would mask a wiring bug rather than surface it.
        for (const cityRole of rolesOf(city)) {
          expect(role.stage, `${alg.id} consumes settlement at stage ${role.stage}`).toBeGreaterThan(cityRole.stage);
        }
      }
    }
  });
});

describe("farmland peri-urban (plan 035-C) — stage 4, wired settlement + elevation", () => {
  it("farmland is at contract version 8 (paddy v8 — range-scoped risers, terrace shade fills, no paddy lane web)", () => {
    expect(algorithmById("farmland")!.currentVersion).toBe(8);
  });

  it("farmland sits at stage 4, consumes elevation + settlement + water (plan 037), produces NOTHING", () => {
    const farmland = algorithmById("farmland")!;
    expect(farmland.stage).toBe(4);
    expect([...farmland.consumes].sort()).toEqual(["elevation", "settlement", "water"]);
    expect(farmland.produces).toEqual([]);
  });

  it("the semantic stage order holds across the registry (plan 035 §0 table)", () => {
    // river 0 (hydrology) · mountain 1 (terrain) · forest/rural-park 2
    // (vegetation) · city 3 (settlement) · farmland/urban-park 4 (peri-urban) ·
    // wall 5 (detail). Stages live HERE only — never in persisted data.
    expect(algorithmById("river")!.stage).toBe(0);
    expect(algorithmById("mountain")!.stage).toBe(1);
    expect(algorithmById("forest")!.stage).toBe(2);
    expect(algorithmById("park")!.stage).toBe(2); // rural static role
    expect(algorithmById("city")!.stage).toBe(3);
    expect(algorithmById("farmland")!.stage).toBe(4);
    expect(dagRoleFor(algorithmById("park")!, { variety: "urban-park" }).stage).toBe(4);
    expect(algorithmById("wall")!.stage).toBe(5);
  });
});

describe("park split (plan 035) — variety drives the stage", () => {
  it("park is at contract version 5 (plan 038 item 7 sketch adjacency; v4 was the river channel exclusion)", () => {
    expect(algorithmById("park")!.currentVersion).toBe(5);
  });

  it("urban-park resolves to stage 4, consumes settlement + water (plan 037), produces NOTHING", () => {
    const park = algorithmById("park")!;
    const role = dagRoleFor(park, { variety: "urban-park", pathDensity: 0.5, pond: true });
    expect(role.stage).toBe(4);
    expect(role.consumes).toEqual(["settlement", "water"]);
    expect(role.produces).toEqual([]);
  });

  it("rural varieties keep the static stage-2 vegetation role", () => {
    const park = algorithmById("park")!;
    for (const variety of ["formal-garden", "city-park", "wild-common", "japanese-garden"]) {
      const role = dagRoleFor(park, { variety, pathDensity: 0.5, pond: false });
      expect(role.stage, variety).toBe(2);
      expect(role.produces, variety).toEqual(["vegetation"]);
      expect(role.consumes, variety).toEqual(["water"]);
    }
    // Malformed/absent params fall back to the static rural role (never throw).
    expect(dagRoleFor(park, {}).stage).toBe(2);
  });

  it("dagRoleFor falls back to the static fields for every dagRole-less algorithm", () => {
    for (const alg of allAlgorithms()) {
      if (alg.dagRole) continue;
      const role = dagRoleFor(alg, {});
      expect(role.stage).toBe(alg.stage);
      expect(role.produces).toEqual(alg.produces);
      expect(role.consumes).toEqual(alg.consumes);
    }
  });

  it("the urban-park preset exists and validates against the park schema", () => {
    const park = algorithmById("park")!;
    const preset = presetById(park, "urban-park");
    expect(preset).toBeDefined();
    expect(park.paramsSchema.safeParse(preset!.params).success).toBe(true);
  });
});

describe("procgen presets", () => {
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
    // Sanity: the theme mapping resolves to the expected profiles.
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
