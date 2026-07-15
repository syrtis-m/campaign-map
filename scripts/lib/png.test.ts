import { describe, it, expect } from "vitest";
import { encodePng, decodePng, type RgbaImage } from "./png";

function gradient(w: number, h: number): RgbaImage {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      data[o] = (x * 7) & 0xff;
      data[o + 1] = (y * 11) & 0xff;
      data[o + 2] = (x * y) & 0xff;
      data[o + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

describe("png codec", () => {
  it("round-trips pixels through encode → decode", () => {
    const img = gradient(17, 13); // non-square, odd dims
    const out = decodePng(encodePng(img));
    expect(out.width).toBe(17);
    expect(out.height).toBe(13);
    expect(Buffer.from(out.data)).toEqual(Buffer.from(img.data));
  });

  it("emits byte-identical PNGs for identical pixels (determinism)", () => {
    const img = gradient(32, 32);
    const a = encodePng(img);
    const b = encodePng(img);
    expect(a.equals(b)).toBe(true);
  });

  it("writes the PNG signature and an RGBA IHDR", () => {
    const png = encodePng(gradient(4, 4));
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // IHDR data begins at offset 16 (8 sig + 4 len + 4 type).
    expect(png[16 + 8]).toBe(8); // bit depth
    expect(png[16 + 9]).toBe(6); // color type RGBA
  });

  it("rejects a corrupt signature on decode", () => {
    const png = encodePng(gradient(4, 4));
    png[0] = 0;
    expect(() => decodePng(png)).toThrow();
  });
});
