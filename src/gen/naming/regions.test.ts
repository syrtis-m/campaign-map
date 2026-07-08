import { describe, expect, it } from "vitest";
import { cultureAt } from "./regions";
import type { BBox } from "../spatialHash";

const WORLD_BOUNDS: BBox = { minX: -8, minY: -6, maxX: 8, maxY: 6 };
const SEED = 4181;

describe("cultureAt", () => {
  it("is deterministic for a given position", () => {
    const a = cultureAt(SEED, 2, 1, WORLD_BOUNDS, "fantasy");
    const b = cultureAt(SEED, 2, 1, WORLD_BOUNDS, "fantasy");
    expect(a.id).toBe(b.id);
  });

  it("always returns a culture matching the requested genre", () => {
    for (const [x, y] of [[-7, -5], [0, 0], [7, 5], [-3, 4]] as [number, number][]) {
      const c = cultureAt(SEED, x, y, WORLD_BOUNDS, "fantasy");
      expect(c.genre).toBe("fantasy");
    }
  });

  it("assigns different cultures across distant regions (region variety, not one culture for the whole campaign)", () => {
    const samples = new Set<string>();
    for (let x = WORLD_BOUNDS.minX; x <= WORLD_BOUNDS.maxX; x += 1) {
      for (let y = WORLD_BOUNDS.minY; y <= WORLD_BOUNDS.maxY; y += 1) {
        samples.add(cultureAt(SEED, x, y, WORLD_BOUNDS, "fantasy").id);
      }
    }
    expect(samples.size).toBeGreaterThan(1);
  });

  it("nearby positions usually share a culture (territory is contiguous, not noisy per-point)", () => {
    const a = cultureAt(SEED, 3, 2, WORLD_BOUNDS, "fantasy");
    const b = cultureAt(SEED, 3.01, 2.01, WORLD_BOUNDS, "fantasy");
    expect(a.id).toBe(b.id);
  });
});
