import { describe, it, expect } from "vitest";
import { niceScaleStep, formatMeters, computeScaleBar, mercatorMetersPerPixel } from "./fictionalCRS";

describe("niceScaleStep", () => {
  it("picks 1/2/5 * 10^n at or under the budget", () => {
    expect(niceScaleStep(430)).toBe(200);
    expect(niceScaleStep(999)).toBe(500);
    expect(niceScaleStep(1000)).toBe(1000);
    expect(niceScaleStep(4999)).toBe(2000);
  });
});

describe("formatMeters", () => {
  it("uses meters under 1km", () => {
    expect(formatMeters(250)).toBe("250 m");
  });
  it("uses km with one decimal under 10km", () => {
    expect(formatMeters(2500)).toBe("2.5 km");
  });
  it("rounds to whole km at 10km+", () => {
    expect(formatMeters(15200)).toBe("15 km");
  });
});

describe("computeScaleBar", () => {
  it("shrinks the reported bar as zoom increases (more detail per pixel)", () => {
    const low = computeScaleBar(2, 50, 120);
    const high = computeScaleBar(14, 50, 120);
    // at deeper zoom the same pixel budget covers fewer real-world meters
    const lowMeters = Number(low.label.replace(/[^\d.]/g, ""));
    const highMeters = Number(high.label.replace(/[^\d.]/g, ""));
    const lowIsKm = low.label.includes("km");
    const highIsKm = high.label.includes("km");
    const lowM = lowIsKm ? lowMeters * 1000 : lowMeters;
    const highM = highIsKm ? highMeters * 1000 : highMeters;
    expect(highM).toBeLessThan(lowM);
  });

  it("stays within the pixel budget", () => {
    const { widthPx } = computeScaleBar(8, 50, 120);
    expect(widthPx).toBeLessThanOrEqual(120);
    expect(widthPx).toBeGreaterThan(0);
  });
});

describe("mercatorMetersPerPixel", () => {
  it("halves with each zoom level", () => {
    const z5 = mercatorMetersPerPixel(5);
    const z6 = mercatorMetersPerPixel(6);
    expect(z5 / z6).toBeCloseTo(2, 5);
  });
});
