import { describe, expect, it } from "vitest";
import {
  underlayImageCoordinates,
  underlaySourceSpec,
  underlayLayer,
  UNDERLAY_LAYER_ID,
  UNDERLAY_SOURCE_ID,
  type UnderlayDescriptor,
} from "./underlayLayer";

const DESC: UnderlayDescriptor = {
  url: "app://local/ref.png",
  sw: [-10, 20],
  ne: [30, 60],
  opacity: 0.6,
  visible: true,
};

describe("underlayImageCoordinates (plan 041 trace mode)", () => {
  it("derives the four image corners TL,TR,BR,BL from the two anchor corners", () => {
    // sw = (minX, minY), ne = (maxX, maxY).
    expect(underlayImageCoordinates([-10, 20], [30, 60])).toEqual([
      [-10, 60], // top-left  = (minX, maxY)
      [30, 60], // top-right = (maxX, maxY)
      [30, 20], // bottom-right = (maxX, minY)
      [-10, 20], // bottom-left = (minX, minY)
    ]);
  });
});

describe("underlaySourceSpec", () => {
  it("is a MapLibre image source pointing at the resolved url with derived corners", () => {
    const spec = underlaySourceSpec(DESC) as Record<string, unknown>;
    expect(spec.type).toBe("image");
    expect(spec.url).toBe("app://local/ref.png");
    expect(spec.coordinates).toEqual(underlayImageCoordinates(DESC.sw, DESC.ne));
  });
});

describe("underlayLayer", () => {
  it("is a raster layer bound to the underlay source with clamped opacity", () => {
    const layer = underlayLayer(DESC) as Record<string, unknown>;
    expect(layer.id).toBe(UNDERLAY_LAYER_ID);
    expect(layer.type).toBe("raster");
    expect(layer.source).toBe(UNDERLAY_SOURCE_ID);
    expect((layer.paint as Record<string, unknown>)["raster-opacity"]).toBe(0.6);
    expect((layer.layout as Record<string, unknown>).visibility).toBe("visible");
  });

  it("hides the layer via layout visibility when not visible", () => {
    const layer = underlayLayer({ ...DESC, visible: false }) as Record<string, unknown>;
    expect((layer.layout as Record<string, unknown>).visibility).toBe("none");
  });

  it("clamps out-of-range opacity into 0..1", () => {
    const hi = underlayLayer({ ...DESC, opacity: 5 }) as Record<string, unknown>;
    const lo = underlayLayer({ ...DESC, opacity: -1 }) as Record<string, unknown>;
    expect((hi.paint as Record<string, unknown>)["raster-opacity"]).toBe(1);
    expect((lo.paint as Record<string, unknown>)["raster-opacity"]).toBe(0);
  });
});
