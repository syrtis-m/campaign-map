import { describe, it, expect } from "vitest";
import { LOCATION_TYPES } from "../model/locationNote";
import { TYPE_ICON_CATEGORY, ICON_CATEGORIES, iconCategoryFor, iconCategoryExpression } from "./icons";

describe("iconCategoryFor / TYPE_ICON_CATEGORY", () => {
  it("maps every taxonomy type (src/model/locationNote.ts TYPE_TAXONOMY) to a known category", () => {
    for (const type of LOCATION_TYPES) {
      const category = iconCategoryFor(type);
      expect(ICON_CATEGORIES).toContain(category);
    }
  });

  it("falls back to 'generic' for unmapped/unknown types, mirroring typeDefaults()'s custom fallback", () => {
    expect(iconCategoryFor("some-future-type-nobody-added-yet")).toBe("generic");
    expect(iconCategoryFor("custom")).toBe("generic");
  });

  it("groups related types under the same category (settlement tiers, region/district, route/street)", () => {
    expect(iconCategoryFor("city")).toBe("settlement");
    expect(iconCategoryFor("town")).toBe("settlement");
    expect(iconCategoryFor("village")).toBe("settlement");
    expect(iconCategoryFor("nation/region")).toBe("region");
    expect(iconCategoryFor("district")).toBe("region");
    expect(iconCategoryFor("route")).toBe("route");
    expect(iconCategoryFor("street(named)")).toBe("route");
  });

  it("only ever produces categories drawable by registerTypeIcons (no orphaned category strings)", () => {
    for (const category of Object.values(TYPE_ICON_CATEGORY)) {
      expect(ICON_CATEGORIES).toContain(category);
    }
  });
});

describe("iconCategoryExpression", () => {
  it("builds a MapLibre match expression covering every taxonomy type plus a fallback", () => {
    const expr = iconCategoryExpression() as unknown[];
    expect(expr[0]).toBe("match");
    expect(expr[1]).toEqual(["get", "type"]);
    // ["match", input, type1, cat1, type2, cat2, ..., fallback] — odd length overall.
    expect(expr.length % 2).toBe(1);
    expect(expr[expr.length - 1]).toBe("generic");
    for (const type of LOCATION_TYPES) {
      expect(expr).toContain(type);
    }
  });
});
