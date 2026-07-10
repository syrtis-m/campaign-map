import { describe, it, expect } from "vitest";
import { populateArea } from "./populate";
import type { BBox } from "./spatialHash";

const BBOX: BBox = { minX: -10, minY: -10, maxX: 10, maxY: 10 };
const nameFor = (x: number, y: number): string => `Loc(${x.toFixed(2)},${y.toFixed(2)})`;

describe("populateArea", () => {
  it("honors count", () => {
    const out = populateArea({ seed: 4181, bbox: BBOX, type: "shop/tavern/venue", count: 5, nameFor });
    expect(out).toHaveLength(5);
  });

  it("is deterministic: same spec → identical output", () => {
    const spec = { seed: 4181, bbox: BBOX, type: "shop/tavern/venue", count: 8, nameFor };
    const a = populateArea(spec);
    const b = populateArea(spec);
    expect(a).toEqual(b);
  });

  it("places every point inside the bbox", () => {
    const out = populateArea({ seed: 99, bbox: BBOX, type: "residence/minor", count: 20, nameFor });
    for (const loc of out) {
      const [x, y] = loc.point;
      expect(x).toBeGreaterThanOrEqual(BBOX.minX);
      expect(x).toBeLessThan(BBOX.maxX);
      expect(y).toBeGreaterThanOrEqual(BBOX.minY);
      expect(y).toBeLessThan(BBOX.maxY);
    }
  });

  it("distinct salts yield different layouts", () => {
    const a = populateArea({ seed: 4181, bbox: BBOX, type: "custom", count: 5, nameFor, salt: "batch-1" });
    const b = populateArea({ seed: 4181, bbox: BBOX, type: "custom", count: 5, nameFor, salt: "batch-2" });
    expect(a).not.toEqual(b);
  });

  it("stamps every result with the requested type", () => {
    const out = populateArea({ seed: 1, bbox: BBOX, type: "landmark", count: 4, nameFor });
    for (const loc of out) expect(loc.type).toBe("landmark");
  });

  it("names each point via the supplied nameFor", () => {
    const out = populateArea({ seed: 1, bbox: BBOX, type: "custom", count: 1, nameFor });
    expect(out[0].name).toBe(nameFor(...out[0].point));
  });
});
