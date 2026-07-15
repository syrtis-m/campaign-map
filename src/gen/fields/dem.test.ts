import { describe, it, expect } from "vitest";
import {
  TERRARIUM_BASE,
  demVerticalScale,
  tileLngLatBounds,
  unionFields,
  demTileLattice,
  latticeToRGBA,
} from "./dem";
import { fbmEroded, type ElevationField, type HeightSample } from "./elevation";
import { mountainHeightField, type MountainParams } from "../mountain";
import { makeRegion } from "../region";

/**
 * DEM raster support. The determinism surface is the QUANTIZED
 * INT LATTICE — every test here compares heights numerically; nothing ever
 * touches PNG bytes (canvas/zlib encoders are not part of the contract).
 */

const SCALE = 50; // Vespergate's display-unit scale: 1 fake degree = 50 m

function squareRegion(cx: number, cy: number, half: number) {
  return makeRegion("dem-test-region", [
    [cx - half, cy - half],
    [cx + half, cy - half],
    [cx + half, cy + half],
    [cx - half, cy + half],
    [cx - half, cy - half],
  ]);
}

const PARAMS: MountainParams = { terrain: "alpine", amplitude: 0.85, roughness: 0.6 };

/** A mountain field straddling the border between slippy tiles (6,24,36) and
 * (6,25,36) — the shared edge is lng = -39.375, tile rows cover lat ≈ -21.9 to
 * -27.1, and gen-space meters = degree·SCALE. Centering the relief ON the
 * border makes the seam assertions cross real slopes, not flat zeros. */
function testField(): ElevationField {
  const region = squareRegion(-39.375 * SCALE, -24 * SCALE, 2 * SCALE);
  return mountainHeightField(1234, region, PARAMS);
}

describe("tileLngLatBounds (slippy XYZ inverse)", () => {
  it("z0 root tile covers the world", () => {
    const b = tileLngLatBounds(0, 0, 0);
    expect(b.west).toBe(-180);
    expect(b.east).toBe(180);
    expect(b.north).toBeCloseTo(85.0511, 3);
    expect(b.south).toBeCloseTo(-85.0511, 3);
  });

  it("adjacent tiles share an exact edge (the seam precondition)", () => {
    const a = tileLngLatBounds(6, 24, 36);
    const b = tileLngLatBounds(6, 25, 36);
    expect(a.east).toBe(b.west);
    const c = tileLngLatBounds(6, 24, 37);
    expect(a.south).toBe(c.north);
  });
});

describe("demVerticalScale (fictional-CRS reconciliation)", () => {
  it("is terrarium-capped for a small-scale fictional campaign", () => {
    // Vespergate: physical correction would be ~2226×; the cap keeps a full
    // 1200 m peak inside the encodable range instead.
    expect(demVerticalScale(50)).toBe(25);
  });

  it("uses the physical factor when it already fits", () => {
    // A campaign whose unit ≈ real mercator meters needs (and gets) ~1×.
    const k = demVerticalScale(111319.49);
    expect(k).toBeGreaterThan(0.99);
    expect(k).toBeLessThan(1.01);
  });

  it("is constant per campaign — never a function of tile or position", () => {
    expect(demVerticalScale(50)).toBe(demVerticalScale(50));
  });
});

describe("unionFields (campaign composition)", () => {
  it("empty campaign → flat zero field (legal DEM, no crash)", () => {
    const f = unionFields([]);
    expect(f(123, -456)).toEqual({ v: 0, dx: 0, dy: 0 });
  });

  it("single field passes through untouched", () => {
    const f = testField();
    const u = unionFields([f]);
    expect(u(-2100, -1200)).toEqual(f(-2100, -1200));
  });

  it("union is pointwise max with the winner's gradient", () => {
    const lo: ElevationField = () => ({ v: 10, dx: 1, dy: 2 });
    const hi: ElevationField = () => ({ v: 20, dx: 3, dy: 4 });
    expect(unionFields([lo, hi])(0, 0)).toEqual({ v: 20, dx: 3, dy: 4 });
    expect(unionFields([hi, lo])(0, 0)).toEqual({ v: 20, dx: 3, dy: 4 });
  });
});

describe("demTileLattice — raw-lattice determinism (the durable record)", () => {
  const RES = 32; // small lattice keeps the suite fast; math identical to 256

  it("same inputs twice → identical int lattice (determinism D1)", () => {
    const f = testField();
    const a = demTileLattice(f, 6, 24, 36, RES, SCALE, 25);
    const b = demTileLattice(f, 6, 24, 36, RES, SCALE, 25);
    expect(a).toEqual(b);
    expect(a.length).toBe(RES * RES);
  });

  it("rebuilding the field from the same persisted seed/params reproduces the lattice", () => {
    // The live regenerate path: the field object is REBUILT (new closures) from
    // durable inputs; the lattice must not depend on object identity.
    const a = demTileLattice(testField(), 6, 24, 36, RES, SCALE, 25);
    const b = demTileLattice(testField(), 6, 24, 36, RES, SCALE, 25);
    expect(a).toEqual(b);
  });

  it("covers the mountain with quantized ints in the terrarium range", () => {
    const lat = demTileLattice(testField(), 6, 24, 36, RES, SCALE, 25);
    const nonZero = lat.filter((v) => v !== 0);
    expect(nonZero.length).toBeGreaterThan(0); // the mountain is under this tile
    for (const v of lat) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(-TERRARIUM_BASE);
      expect(v).toBeLessThanOrEqual(65535 - TERRARIUM_BASE);
    }
    // K scales heights: A(0.85) = 1050 m × 25 = 26 250 encoded max, and the
    // masked fBm should push well past half that somewhere on the massif.
    expect(Math.max(...lat)).toBeGreaterThan(1000);
  });

  it("SEAM: samples derive from absolute geography, never tile identity", () => {
    // Adjacent tiles' pixel centers are distinct points (centers at (i+0.5)/res),
    // so the seam property is: every pixel equals the direct quantization of the
    // field at its ABSOLUTE lng/lat — no tile-local state can leak in. Verify a
    // full edge column on both sides of a shared border.
    const f = testField();
    const K = 25;
    const left = demTileLattice(f, 6, 24, 36, RES, SCALE, K);
    const right = demTileLattice(f, 6, 25, 36, RES, SCALE, K);
    const lb = tileLngLatBounds(6, 24, 36);
    const rb = tileLngLatBounds(6, 25, 36);
    const direct = (b: ReturnType<typeof tileLngLatBounds>, i: number, j: number): number => {
      const lng = b.west + ((b.east - b.west) * (i + 0.5)) / RES;
      const lat = b.north + ((b.south - b.north) * (j + 0.5)) / RES;
      return Math.round(Math.max(-TERRARIUM_BASE, Math.min(32767, f(lng * SCALE, lat * SCALE).v * K)));
    };
    for (let j = 0; j < RES; j++) {
      expect(left[j * RES + (RES - 1)]).toBe(direct(lb, RES - 1, j));
      expect(right[j * RES]).toBe(direct(rb, 0, j));
    }
    // And the field itself is continuous across the border: neighboring pixel
    // columns either side differ by at most a smoothness bound (no cliff at the
    // tile edge — the visible-seam failure mode).
    const worstStep = Math.max(
      ...Array.from({ length: RES }, (_, j) => Math.abs(left[j * RES + (RES - 1)] - right[j * RES]))
    );
    // One pixel step ≈ (tile width / RES)·SCALE ≈ 8.8 m of ground. The steepest
    // real gradient is the rim mask ramp (A ≈ 1050 m over the 120 m band ≈ 8.75
    // m/m → ~77 campaign-m ≈ 1900 encoded per step, measured ~524 on this
    // fixture); a tile-identity bug would jump by full amplitude (~26 000).
    expect(worstStep).toBeLessThan(2500);
  });

  it("plain fbm field (no region mask) also seams — the campaign-base case", () => {
    const f: ElevationField = (x, y): HeightSample => fbmEroded(99, x, y, { octaves: 4 });
    const K = 25;
    const a = demTileLattice(f, 7, 50, 60, RES, SCALE, K);
    const b = demTileLattice(f, 7, 51, 60, RES, SCALE, K);
    const worst = Math.max(
      ...Array.from({ length: RES }, (_, j) => Math.abs(a[j * RES + (RES - 1)] - b[j * RES]))
    );
    expect(worst).toBeLessThan(50);
  });
});

describe("latticeToRGBA — terrarium packing (the shade-math input contract)", () => {
  // MapLibre's hillshade shader decodes `E = R·256 + G + B/256 − 32768` and
  // takes Sobel derivatives of E: packing must be EXACT (lossless) or the
  // illumination model sees quantization noise as fake micro-relief.
  it("round-trips every height exactly (E = R·256 + G + B/256 − 32768)", () => {
    const heights = [0, 1, -1, 255, 256, 1050 * 25, 30000, -32768, 32767];
    const rgba = latticeToRGBA(heights, 3);
    for (let p = 0; p < heights.length; p++) {
      const r = rgba[p * 4];
      const g = rgba[p * 4 + 1];
      const b = rgba[p * 4 + 2];
      const a = rgba[p * 4 + 3];
      const decoded = r * 256 + g + b / 256 - TERRARIUM_BASE;
      expect(decoded).toBe(heights[p]);
      expect(b).toBe(0); // integer heights ⇒ no fractional byte
      expect(a).toBe(255); // opaque — premultiplied-alpha must not touch RGB
    }
  });

  it("a constant-slope lattice packs so decoded Sobel derivative is the true slope", () => {
    // The illumination model's core: MapLibre's prepare shader computes
    // deriv_x = ((c+2f+i) − (a+2d+g)) over the decoded heights. For a perfect
    // linear ramp E(i,j) = 7i the decoded Sobel-x must be exactly 8·7.
    const RES = 4;
    const heights: number[] = [];
    for (let j = 0; j < RES; j++) for (let i = 0; i < RES; i++) heights.push(7 * i);
    const rgba = latticeToRGBA(heights, RES);
    const decode = (i: number, j: number): number => {
      const p = (j * RES + i) * 4;
      return rgba[p] * 256 + rgba[p + 1] + rgba[p + 2] / 256 - TERRARIUM_BASE;
    };
    // Sobel-x at the lattice interior point (1,1) — a,b,c top row; d,f mids; g,h,i bottom.
    const sobelX =
      decode(2, 0) + 2 * decode(2, 1) + decode(2, 2) - (decode(0, 0) + 2 * decode(0, 1) + decode(0, 2));
    expect(sobelX).toBe(8 * 7);
    // Sobel-y on a pure-x ramp is exactly 0 (no cross-talk between channels).
    const sobelY =
      decode(0, 2) + 2 * decode(1, 2) + decode(2, 2) - (decode(0, 0) + 2 * decode(1, 0) + decode(2, 0));
    expect(sobelY).toBe(0);
  });
});
