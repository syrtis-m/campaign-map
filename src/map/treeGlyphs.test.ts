import { describe, it, expect } from "vitest";
import {
  rasterizeSdf,
  treeGlyphImages,
  treeGlyphId,
  treeIconImageExpr,
  TREE_VARIANTS,
  type GlyphImage,
} from "./treeGlyphs";

/** djb2 over the RGBA bytes — a cheap deterministic fingerprint of an image. */
function hashImage(img: GlyphImage): string {
  let h = 5381;
  for (let i = 0; i < img.data.length; i++) h = ((h << 5) + h + img.data[i]) >>> 0;
  return `${img.width}x${img.height}:${h}`;
}

const FAMILIES = ["broadleaf", "conifer", "mixed", "swamp", "dead-wood"] as const;

describe("treeGlyphs — generic SDF synthesis", () => {
  it("rasterizeSdf is a pure function: identical predicate → byte-identical image", () => {
    const disk = (x: number, y: number) => (x - 20) ** 2 + (y - 20) ** 2 <= 100;
    const a = rasterizeSdf(disk, 40);
    const b = rasterizeSdf(disk, 40);
    expect(a.width).toBe(40);
    expect(a.height).toBe(40);
    expect(a.data.length).toBe(40 * 40 * 4);
    expect(hashImage(a)).toBe(hashImage(b));
  });

  it("SDF alpha is highest inside the shape and lowest far outside (well-formed field)", () => {
    const dim = 40;
    const disk = (x: number, y: number) => (x - 20) ** 2 + (y - 20) ** 2 <= 100;
    const img = rasterizeSdf(disk, dim);
    const alphaAt = (px: number, py: number) => img.data[(py * dim + px) * 4 + 3];
    // Center is deep inside → near-max alpha; a corner is far outside → near-zero.
    expect(alphaAt(20, 20)).toBeGreaterThan(alphaAt(1, 1));
    expect(alphaAt(20, 20)).toBeGreaterThan(200);
    expect(alphaAt(1, 1)).toBeLessThan(80);
    // RGB is white (icon-color tints it at draw time).
    expect(img.data[(20 * dim + 20) * 4]).toBe(255);
  });
});

describe("treeGlyphs — forest tree glyph set", () => {
  it("registers 5 families × 4 variants = 20 square SDF images", () => {
    const images = treeGlyphImages();
    expect(images.size).toBe(FAMILIES.length * TREE_VARIANTS);
    for (const family of FAMILIES) {
      for (let v = 0; v < TREE_VARIANTS; v++) {
        const img = images.get(treeGlyphId(family, v));
        expect(img, `${treeGlyphId(family, v)} missing`).toBeDefined();
        expect(img!.width).toBe(img!.height);
        expect(img!.data.length).toBe(img!.width * img!.height * 4);
        // A real glyph has coverage — some fully-inside pixels (alpha 255).
        expect(Array.from(img!.data).some((_, i) => i % 4 === 3 && img!.data[i] === 255)).toBe(true);
      }
    }
  });

  it("every glyph is visually distinct (per variety AND per variant)", () => {
    const images = treeGlyphImages();
    const hashes = new Set<string>();
    for (const [, img] of images) hashes.add(hashImage(img));
    // No two of the 20 glyphs are byte-identical.
    expect(hashes.size).toBe(images.size);
  });

  it("families read differently: broadleaf ≠ conifer ≠ dead-wood at the same variant", () => {
    const images = treeGlyphImages();
    const broad = hashImage(images.get(treeGlyphId("broadleaf", 0))!);
    const coni = hashImage(images.get(treeGlyphId("conifer", 0))!);
    const dead = hashImage(images.get(treeGlyphId("dead-wood", 0))!);
    expect(new Set([broad, coni, dead]).size).toBe(3);
  });

  it("icon-image expression resolves tree-<forestType>-<variant>", () => {
    const expr = treeIconImageExpr();
    expect(Array.isArray(expr)).toBe(true);
    expect((expr as unknown[])[0]).toBe("concat");
    expect(JSON.stringify(expr)).toContain("tree-");
    expect(JSON.stringify(expr)).toContain("forestType");
    expect(JSON.stringify(expr)).toContain("variant");
  });
});
