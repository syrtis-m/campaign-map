import { describe, it, expect } from "vitest";
import {
  parkGlyphImages,
  parkPointGlyphId,
  parkRockGlyphId,
  parkPointIconExpr,
  parkRockIconExpr,
  parkTreeIconExpr,
  PARK_POINT_KINDS,
  PARK_ROCK_VARIANTS,
} from "./parkGlyphs";
import type { GlyphImage } from "./treeGlyphs";

/** djb2 over the RGBA bytes — a cheap deterministic fingerprint of an image. */
function hashImage(img: GlyphImage): string {
  let h = 5381;
  for (let i = 0; i < img.data.length; i++) h = ((h << 5) + h + img.data[i]) >>> 0;
  return `${img.width}x${img.height}:${h}`;
}

describe("parkGlyphs — SDF point + rock glyph set", () => {
  it("registers 5 point kinds + 3 rock variants = 8 square SDF images", () => {
    const images = parkGlyphImages();
    expect(images.size).toBe(PARK_POINT_KINDS.length + PARK_ROCK_VARIANTS);
    for (const kind of PARK_POINT_KINDS) {
      const img = images.get(parkPointGlyphId(kind));
      expect(img, `${parkPointGlyphId(kind)} missing`).toBeDefined();
      expect(img!.width).toBe(img!.height);
      expect(img!.data.length).toBe(img!.width * img!.height * 4);
      // A real glyph has coverage — some fully-inside pixels (alpha 255).
      expect(Array.from(img!.data).some((_, i) => i % 4 === 3 && img!.data[i] === 255)).toBe(true);
    }
    for (let v = 0; v < PARK_ROCK_VARIANTS; v++) {
      const img = images.get(parkRockGlyphId(v));
      expect(img, `${parkRockGlyphId(v)} missing`).toBeDefined();
      expect(Array.from(img!.data).some((_, i) => i % 4 === 3 && img!.data[i] === 255)).toBe(true);
    }
  });

  it("is a pure function: a second build is byte-identical (memoized + deterministic)", () => {
    const a = parkGlyphImages();
    const b = parkGlyphImages();
    for (const [id, img] of a) expect(hashImage(b.get(id)!)).toBe(hashImage(img));
  });

  it("every glyph is visually distinct (pixel-hash) — no two stamped alike", () => {
    const images = parkGlyphImages();
    const hashes = new Set<string>();
    for (const [, img] of images) hashes.add(hashImage(img));
    expect(hashes.size).toBe(images.size);
  });

  it("landmark kinds read differently: fountain ≠ lantern ≠ teahouse", () => {
    const images = parkGlyphImages();
    const f = hashImage(images.get(parkPointGlyphId("fountain"))!);
    const l = hashImage(images.get(parkPointGlyphId("lantern"))!);
    const t = hashImage(images.get(parkPointGlyphId("teahouse"))!);
    expect(new Set([f, l, t]).size).toBe(3);
  });

  it("icon-image expressions resolve the expected ids", () => {
    expect(JSON.stringify(parkPointIconExpr())).toContain("park-point-");
    expect(JSON.stringify(parkPointIconExpr())).toContain("pointKind");
    expect(JSON.stringify(parkRockIconExpr())).toContain("park-rock-");
    expect(JSON.stringify(parkRockIconExpr())).toContain("variant");
    // Park trees REUSE the forest tree glyph ids (tree-<family>-<variant>).
    const tree = JSON.stringify(parkTreeIconExpr());
    expect(tree).toContain("tree-");
    expect(tree).toContain("treeFamily");
    expect(tree).toContain("variant");
  });
});
