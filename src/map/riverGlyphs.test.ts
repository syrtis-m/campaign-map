import { describe, it, expect } from "vitest";
import { riverGlyphImages, riverGlyphId, riverIconImageExpr, RIVER_GLYPHS, type RiverGlyph } from "./riverGlyphs";
import type { GlyphImage } from "./treeGlyphs";

/** djb2 over the RGBA bytes — a cheap deterministic fingerprint of an image
 * (the treeGlyphs pixel-hash idiom). */
function hashImage(img: GlyphImage): string {
  let h = 5381;
  for (let i = 0; i < img.data.length; i++) h = ((h << 5) + h + img.data[i]) >>> 0;
  return `${img.width}x${img.height}:${h}`;
}

describe("riverGlyphs — water-symbol SDF set", () => {
  it("registers one square SDF image per water symbol (ford / rapids / falls)", () => {
    const images = riverGlyphImages();
    expect(images.size).toBe(RIVER_GLYPHS.length);
    for (const glyph of RIVER_GLYPHS) {
      const img = images.get(riverGlyphId(glyph));
      expect(img, `${riverGlyphId(glyph)} missing`).toBeDefined();
      expect(img!.width).toBe(img!.height);
      expect(img!.data.length).toBe(img!.width * img!.height * 4);
      // A real glyph has coverage — pixels well inside the shape (thin water
      // symbols don't saturate to 255 like a fat tree blob, but they clear a
      // high alpha somewhere).
      let maxAlpha = 0;
      for (let i = 3; i < img!.data.length; i += 4) maxAlpha = Math.max(maxAlpha, img!.data[i]);
      expect(maxAlpha, `${riverGlyphId(glyph)} has no coverage`).toBeGreaterThan(150);
      // RGB is white so `icon-color` tints it to the river hue at draw time.
      expect(img!.data[0]).toBe(255);
      expect(img!.data[1]).toBe(255);
      expect(img!.data[2]).toBe(255);
    }
  });

  it("is a pure function: memoized bytes are stable across calls (pixel-hash)", () => {
    const a = riverGlyphImages();
    const b = riverGlyphImages();
    for (const glyph of RIVER_GLYPHS) {
      expect(hashImage(a.get(riverGlyphId(glyph))!)).toBe(hashImage(b.get(riverGlyphId(glyph))!));
    }
  });

  it("every water symbol is visually distinct", () => {
    const images = riverGlyphImages();
    const hashes = new Set<string>();
    for (const glyph of RIVER_GLYPHS) hashes.add(hashImage(images.get(riverGlyphId(glyph))!));
    expect(hashes.size).toBe(RIVER_GLYPHS.length);
  });

  it("icon-image expression resolves river-<glyph>", () => {
    const expr = riverIconImageExpr();
    expect(Array.isArray(expr)).toBe(true);
    expect((expr as unknown[])[0]).toBe("concat");
    expect(JSON.stringify(expr)).toContain("river-");
    expect(JSON.stringify(expr)).toContain("glyph");
  });

  it("the glyph ids match exactly the `glyph` property the generator emits", () => {
    // The river generator writes glyph ∈ {ford, rapids, falls}; every one must
    // resolve to a registered image id (no styleimagemissing at runtime).
    const images = riverGlyphImages();
    for (const glyph of ["ford", "rapids", "falls"] as RiverGlyph[]) {
      expect(images.has(riverGlyphId(glyph)), `no image for ${glyph}`).toBe(true);
    }
  });
});
