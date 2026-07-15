import { describe, it, expect } from "vitest";
import { smoothPolyline } from "./fabricSmooth";

type Pt = [number, number];

describe("smoothPolyline — paint-time road smoothing (shortlist 7)", () => {
  it("returns a short line (<3 pts) unchanged — nothing to curve", () => {
    const two: Pt[] = [
      [0, 0],
      [10, 0],
    ];
    expect(smoothPolyline(two)).toEqual(two);
    expect(smoothPolyline([[1, 2]])).toEqual([[1, 2]]);
    expect(smoothPolyline([])).toEqual([]);
  });

  it("does NOT mutate the input (persisted geometry stays intact)", () => {
    const input: Pt[] = [
      [0, 0],
      [10, 10],
      [20, 0],
    ];
    const snapshot = JSON.parse(JSON.stringify(input));
    smoothPolyline(input);
    expect(input).toEqual(snapshot);
  });

  it("preserves the exact endpoints (the road still meets its clicked ends)", () => {
    const input: Pt[] = [
      [0, 0],
      [10, 10],
      [25, 5],
      [40, 20],
    ];
    const out = smoothPolyline(input);
    expect(out[0]).toEqual(input[0]);
    expect(out[out.length - 1]).toEqual(input[input.length - 1]);
  });

  it("densifies into a smoother line (more vertices than the raw polyline)", () => {
    const input: Pt[] = [
      [0, 0],
      [10, 10],
      [20, 0],
    ];
    const out = smoothPolyline(input, 8);
    // 2 segments × 8 samples + the leading start point.
    expect(out.length).toBe(2 * 8 + 1);
    expect(out.length).toBeGreaterThan(input.length);
  });

  it("passes through every original control vertex (Catmull-Rom interpolates)", () => {
    const input: Pt[] = [
      [0, 0],
      [10, 10],
      [20, 0],
      [30, 10],
    ];
    const out = smoothPolyline(input, 8);
    for (const v of input) {
      const hit = out.some((p) => Math.hypot(p[0] - v[0], p[1] - v[1]) < 1e-6);
      expect(hit, `control vertex ${v} not on the smoothed curve`).toBe(true);
    }
  });

  it("is deterministic (same input → byte-identical output)", () => {
    const input: Pt[] = [
      [0, 0],
      [5, 12],
      [18, 4],
      [30, 9],
    ];
    expect(smoothPolyline(input)).toEqual(smoothPolyline(input));
  });
});
