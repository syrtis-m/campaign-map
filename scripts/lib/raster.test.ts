import { describe, it, expect } from "vitest";
import { Framebuffer, fitTransform, type Rgba, type Pt } from "./raster";

const BLACK: Rgba = [0, 0, 0, 255];
const WHITE: Rgba = [255, 255, 255, 255];

function pixel(fb: Framebuffer, x: number, y: number): [number, number, number, number] {
  const o = (y * fb.width + x) * 4;
  return [fb.data[o], fb.data[o + 1], fb.data[o + 2], fb.data[o + 3]];
}

describe("Framebuffer fill", () => {
  it("fills a solid square and leaves the outside untouched", () => {
    const fb = new Framebuffer(10, 10, BLACK);
    const square: Pt[] = [[2, 2], [8, 2], [8, 8], [2, 8]];
    fb.fillPolygonGroup([square], WHITE);
    expect(pixel(fb, 5, 5)).toEqual([255, 255, 255, 255]); // interior
    expect(pixel(fb, 0, 0)).toEqual([0, 0, 0, 255]); // outside
  });

  it("leaves a hole unfilled via even-odd parity within one group", () => {
    const fb = new Framebuffer(20, 20, BLACK);
    const outer: Pt[] = [[2, 2], [18, 2], [18, 18], [2, 18]];
    const hole: Pt[] = [[8, 8], [12, 8], [12, 12], [8, 12]];
    fb.fillPolygonGroup([outer, hole], WHITE);
    expect(pixel(fb, 10, 10)).toEqual([0, 0, 0, 255]); // hole center = background
    expect(pixel(fb, 4, 4)).toEqual([255, 255, 255, 255]); // ring body filled
  });

  it("composites a low-alpha fill over the background as a tint", () => {
    const fb = new Framebuffer(4, 4, [200, 200, 200, 255]);
    fb.fillPolygonGroup([[[0, 0], [4, 0], [4, 4], [0, 4]]], [0, 0, 0, 128]);
    const [r] = pixel(fb, 2, 2);
    expect(r).toBeGreaterThan(0);
    expect(r).toBeLessThan(200); // darkened, not replaced
  });
});

describe("Framebuffer stroke + points", () => {
  it("draws a stroked line the caller can see", () => {
    const fb = new Framebuffer(10, 10, BLACK);
    fb.strokePolyline([[1, 5], [8, 5]], 1, WHITE);
    expect(pixel(fb, 5, 5)).toEqual([255, 255, 255, 255]);
  });

  it("stamps a filled square marker centered on the point", () => {
    const fb = new Framebuffer(11, 11, BLACK);
    fb.fillSquare([5, 5], 3, WHITE);
    expect(pixel(fb, 5, 5)).toEqual([255, 255, 255, 255]);
    expect(pixel(fb, 4, 4)).toEqual([255, 255, 255, 255]);
    expect(pixel(fb, 0, 0)).toEqual([0, 0, 0, 255]);
  });
});

describe("fitTransform", () => {
  it("centers and y-flips a bbox within the margin", () => {
    const t = fitTransform({ minX: -100, minY: -100, maxX: 100, maxY: 100 }, 200, 200, 20);
    const center = t.project([0, 0]);
    expect(center[0]).toBeCloseTo(100);
    expect(center[1]).toBeCloseTo(100);
    // World +y maps to a SMALLER screen y (flip).
    const up = t.project([0, 100]);
    expect(up[1]).toBeLessThan(center[1]);
  });
});
