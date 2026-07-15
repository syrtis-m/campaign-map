import { describe, it, expect } from "vitest";
import { FieldLattice } from "./fieldLattice";
import type { ElevationField } from "./elevation";

// A cheap deterministic field + a call counter so we can prove laziness (the
// field is only sampled for tiles actually touched).
function countingRamp(): { field: ElevationField; calls: () => number } {
  let n = 0;
  const field: ElevationField = (x, y) => {
    n++;
    return { v: x * 0.5 + y * 0.25, dx: 0.5, dy: 0.25 };
  };
  return { field, calls: () => n };
}

describe("FieldLattice — lazy per-tile sampling with LRU eviction", () => {
  it("computes a tile only on first touch (laziness), then reuses it", () => {
    const { field, calls } = countingRamp();
    const lat = new FieldLattice(field, { step: 10, tileEdge: 8, maxTiles: 16 });
    expect(lat.computedTiles).toBe(0);
    expect(calls()).toBe(0); // nothing eager

    lat.sampleNode(5, 5); // touches tile (0,0)
    expect(lat.computedTiles).toBe(1);
    expect(calls()).toBe(8 * 8); // exactly one tile filled
    expect(lat.tileCount).toBe(1);

    // Re-sampling within the same tile computes nothing more.
    lat.sampleNode(15, 25);
    expect(lat.computedTiles).toBe(1);
    expect(calls()).toBe(8 * 8);
  });

  it("holds at most maxTiles and evicts the least-recently-used", () => {
    const { field } = countingRamp();
    const lat = new FieldLattice(field, { step: 10, tileEdge: 4, maxTiles: 3 });
    const span = 4 * 10; // 40 m per tile
    // Touch four distinct tiles in a row → the cap is 3, so one eviction.
    lat.sampleNode(0, 0); // tile 0
    lat.sampleNode(span, 0); // tile 1
    lat.sampleNode(2 * span, 0); // tile 2
    expect(lat.tileCount).toBe(3);
    expect(lat.evictedTiles).toBe(0);
    lat.sampleNode(3 * span, 0); // tile 3 → evicts tile 0 (LRU)
    expect(lat.tileCount).toBe(3);
    expect(lat.evictedTiles).toBe(1);
    expect(lat.computedTiles).toBe(4);

    // Tile 0 was evicted → re-touching it recomputes (computed count rises).
    lat.sampleNode(0, 0);
    expect(lat.computedTiles).toBe(5);
    expect(lat.evictedTiles).toBe(2); // evicting tile 1 (now LRU)
  });

  it("touch order matters: a recently-used tile survives eviction", () => {
    const { field } = countingRamp();
    const lat = new FieldLattice(field, { step: 10, tileEdge: 4, maxTiles: 2 });
    const span = 40;
    lat.sampleNode(0, 0); // tile 0
    lat.sampleNode(span, 0); // tile 1
    lat.sampleNode(0, 0); // touch tile 0 → now most-recent
    lat.sampleNode(2 * span, 0); // tile 2 → evicts tile 1 (LRU), NOT tile 0
    // Re-touching tile 0 is a cache hit (no recompute); tile 1 was evicted.
    const before = lat.computedTiles;
    lat.sampleNode(5, 5);
    expect(lat.computedTiles).toBe(before); // tile 0 still cached
  });

  it("samples are byte-identical to a direct field eval at aligned nodes", () => {
    const { field } = countingRamp();
    const lat = new FieldLattice(field, { step: 10, tileEdge: 8, maxTiles: 8 });
    for (const [x, y] of [[0, 0], [30, 70], [120, 240]] as [number, number][]) {
      expect(lat.sampleNode(x, y)).toBe(field(x, y).v);
    }
  });
});
