import { describe, it, expect } from "vitest";
import { posterDimensions } from "./posterExport";

describe("posterDimensions", () => {
  it("preserves the live canvas aspect ratio at the target width", () => {
    // 16:9 live canvas, exported at 2000px wide -> 1125px tall
    expect(posterDimensions(1600, 900, 2000)).toEqual({ width: 2000, height: 1125 });
  });

  it("handles a square canvas", () => {
    expect(posterDimensions(800, 800, 2000)).toEqual({ width: 2000, height: 2000 });
  });

  it("handles a portrait (taller than wide) canvas", () => {
    expect(posterDimensions(900, 1600, 2000)).toEqual({ width: 2000, height: 3556 });
  });

  it("rounds a non-integer target width", () => {
    expect(posterDimensions(1000, 500, 1500.4)).toEqual({ width: 1500, height: 750 });
  });
});
