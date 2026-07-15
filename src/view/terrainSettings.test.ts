import { describe, it, expect } from "vitest";
import { normalizeTerrainBlock, terrainBlockOrDefaults, TERRAIN_DEFAULTS } from "./terrainSettings";

describe("normalizeTerrainBlock", () => {
  it("returns undefined when every field is default (keeps frontmatter minimal)", () => {
    expect(normalizeTerrainBlock({ campAmp: 0, seaDatum: 0, grade: false })).toBeUndefined();
    expect(normalizeTerrainBlock({})).toBeUndefined();
  });

  it("persists a block once any field departs from default", () => {
    expect(normalizeTerrainBlock({ campAmp: 800 })).toEqual({ campAmp: 800, seaDatum: 0, grade: false });
    expect(normalizeTerrainBlock({ seaDatum: -20 })).toEqual({ campAmp: 0, seaDatum: -20, grade: false });
    expect(normalizeTerrainBlock({ grade: true })).toEqual({ campAmp: 0, seaDatum: 0, grade: true });
  });

  it("clamps campAmp non-negative and drops non-finite inputs to defaults", () => {
    expect(normalizeTerrainBlock({ campAmp: -50 })).toBeUndefined(); // clamps to 0 ⇒ default ⇒ undefined
    expect(normalizeTerrainBlock({ campAmp: Number.NaN, seaDatum: 5 })).toEqual({
      campAmp: 0,
      seaDatum: 5,
      grade: false,
    });
  });
});

describe("terrainBlockOrDefaults", () => {
  it("fills defaults for absent fields", () => {
    expect(terrainBlockOrDefaults(undefined)).toEqual(TERRAIN_DEFAULTS);
    expect(terrainBlockOrDefaults({ campAmp: 300 })).toEqual({ campAmp: 300, seaDatum: 0, grade: false });
  });
});
