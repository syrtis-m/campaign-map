import { describe, it, expect } from "vitest";
import {
  renderFeatures,
  toImage,
  diffBuffers,
  paintFor,
  DIFF_FAIL_FRACTION,
  type RgbaImage,
  type Paint,
} from "./perceptualRender";
import { tuples, regionFor, featuresFor, type Tuple } from "./perceptualFixtures";

function tupleNamed(prefix: string): Tuple {
  const t = tuples().find((x) => x.name.startsWith(prefix));
  if (!t) throw new Error(`no fixture tuple starting ${prefix}`);
  return t;
}

function distinctColors(img: RgbaImage): number {
  const seen = new Set<number>();
  for (let i = 0; i < img.width * img.height; i++) {
    const o = i * 4;
    seen.add((img.data[o] << 16) | (img.data[o + 1] << 8) | img.data[o + 2]);
  }
  return seen.size;
}

describe("renderFeatures determinism", () => {
  it("renders a populated tuple byte-identically twice (non-vacuous)", () => {
    const t = tupleNamed("forest");
    const region = regionFor(t);
    const features = featuresFor(t);
    expect(features.length).toBeGreaterThan(0);

    const a = toImage(renderFeatures(features, region));
    const b = toImage(renderFeatures(features, region));
    expect(Buffer.from(a.data)).toEqual(Buffer.from(b.data));
    // Guards against a blank frame passing the equality vacuously.
    expect(distinctColors(a)).toBeGreaterThan(1);
  });
});

describe("diff sensitivity", () => {
  it("flips the diff when a prominent bucket's color changes", () => {
    const t = tupleNamed("forest");
    const region = regionFor(t);
    const features = featuresFor(t);

    const base = toImage(renderFeatures(features, region));
    // Repaint the canopy fill (the largest bucket) a wildly different color.
    const mutated = toImage(
      renderFeatures(features, region, (gid): Paint => {
        const p = paintFor(gid);
        if (gid === "forest-canopy") return { ...p, fill: [255, 0, 255, 255] };
        return p;
      })
    );
    const { fraction } = diffBuffers(base, mutated);
    expect(fraction).toBeGreaterThan(DIFF_FAIL_FRACTION);
  });

  it("counts a pixel only when a channel differs by more than 8", () => {
    const one: RgbaImage = { width: 1, height: 2, data: new Uint8Array([100, 100, 100, 255, 100, 100, 100, 255]) };
    const within: RgbaImage = { width: 1, height: 2, data: new Uint8Array([108, 100, 100, 255, 100, 100, 100, 255]) };
    const beyond: RgbaImage = { width: 1, height: 2, data: new Uint8Array([109, 100, 100, 255, 100, 100, 100, 255]) };
    expect(diffBuffers(one, within).differing).toBe(0); // Δ8 tolerated
    expect(diffBuffers(one, beyond).differing).toBe(1); // Δ9 counted
  });

  it("reports total mismatch on a size mismatch", () => {
    const a: RgbaImage = { width: 2, height: 2, data: new Uint8Array(16) };
    const b: RgbaImage = { width: 3, height: 3, data: new Uint8Array(36) };
    expect(diffBuffers(a, b).fraction).toBe(1);
  });
});
