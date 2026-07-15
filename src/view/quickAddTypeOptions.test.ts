import { describe, it, expect } from "vitest";
import { quickAddTypeOptions } from "./locationTypeOptions";
import { LOCATION_TYPES } from "../model/locationNote";
import { MARKET_PIN_TYPE } from "../gen/citynet";

/**
 * The add-location picker must expose the `market` coupling pin (plan 039) so a
 * GM can anchor a city plaza from the map, not only by hand-editing frontmatter.
 * It must also still offer every location taxonomy type.
 */
describe("quickAddTypeOptions", () => {
  const values = quickAddTypeOptions().map((o) => o.value);

  it("includes the market coupling pin", () => {
    expect(values).toContain(MARKET_PIN_TYPE);
  });

  it("includes every location taxonomy type", () => {
    for (const t of LOCATION_TYPES) expect(values).toContain(t);
  });

  it("has no duplicate values", () => {
    expect(new Set(values).size).toBe(values.length);
  });
});
