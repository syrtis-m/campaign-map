import { describe, expect, it } from "vitest";
import { bandForZoom, generatorIdsForBand, tileBBox, tileKey, tileXYForPoint, CITY_BAND_MIN_ZOOM } from "./tileGrid";

describe("bandForZoom", () => {
  it("is world below the split zoom, city at and above it", () => {
    expect(bandForZoom(0)).toBe("world");
    expect(bandForZoom(CITY_BAND_MIN_ZOOM - 0.01)).toBe("world");
    expect(bandForZoom(CITY_BAND_MIN_ZOOM)).toBe("city");
    expect(bandForZoom(20)).toBe("city");
  });
});

describe("generatorIdsForBand", () => {
  it("world tier is regions/routes (no settlements — named places are Locations), city tier is streets/districts/blocks", () => {
    expect(generatorIdsForBand("world")).toEqual(["world-region", "world-route"]);
    expect(generatorIdsForBand("city")).toEqual(["city-street", "city-district", "city-block"]);
  });
});

describe("tileXYForPoint / tileBBox round-trip", () => {
  it("a point maps to a tile whose bbox contains it", () => {
    for (const [x, y] of [
      [0, 0],
      [599, 599],
      [600, 600],
      [-1, -1],
      [-600, -600],
    ]) {
      const { tileX, tileY } = tileXYForPoint(x, y);
      const bbox = tileBBox(tileX, tileY);
      expect(x).toBeGreaterThanOrEqual(bbox.minX);
      expect(x).toBeLessThan(bbox.maxX);
      expect(y).toBeGreaterThanOrEqual(bbox.minY);
      expect(y).toBeLessThan(bbox.maxY);
    }
  });
});

describe("tileKey", () => {
  it("differs per band even at the same tileX/tileY/generatorId — collision-free without a dedicated band field", () => {
    const worldKey = tileKey(4181, 0, 0, 0, "world-region");
    const cityKey = tileKey(4181, 0, 0, 0, "city-district");
    expect(worldKey).not.toBe(cityKey);
  });
});
