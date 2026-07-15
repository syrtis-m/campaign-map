import { describe, it, expect } from "vitest";
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import type { FabricFeature } from "../../model/fabric";
import {
  drySideAnchor,
  nearestWaterPoint,
  waterPolylinesFromFabric,
  decorateCanonWaterAvoidance,
  anchorOrderFavoring,
  variableAnchorOffsetExpression,
  DEFAULT_ANCHOR_ORDER,
} from "./labelPlacement";

describe("nearestWaterPoint", () => {
  it("returns null when there is no water", () => {
    expect(nearestWaterPoint(0, 0, [])).toBeNull();
  });

  it("finds the closest point on the nearest segment", () => {
    // A horizontal river along y=0 from x=-10..10; a pin at (2,3).
    const river: [number, number][] = [
      [-10, 0],
      [10, 0],
    ];
    const near = nearestWaterPoint(2, 3, [river]);
    expect(near).not.toBeNull();
    expect(near!.x).toBeCloseTo(2, 6);
    expect(near!.y).toBeCloseTo(0, 6);
    expect(near!.distance).toBeCloseTo(3, 6);
  });

  it("clamps to segment endpoints", () => {
    const seg: [number, number][] = [
      [0, 0],
      [0, 10],
    ];
    const near = nearestWaterPoint(5, -4, [seg]); // nearest is endpoint (0,0)
    expect(near!.x).toBeCloseTo(0, 6);
    expect(near!.y).toBeCloseTo(0, 6);
    expect(near!.distance).toBeCloseTo(Math.hypot(5, 4), 6);
  });

  it("handles a degenerate single-vertex polyline", () => {
    const near = nearestWaterPoint(3, 4, [[[0, 0]]]);
    expect(near!.distance).toBeCloseTo(5, 6);
  });
});

describe("drySideAnchor — anchor points away from the nearest water", () => {
  const river: [number, number][] = [
    [-10, 0],
    [10, 0],
  ];

  it("water to the SOUTH (pin above the line) → dry north → anchor bottom (text above)", () => {
    expect(drySideAnchor(0, 3, [river], 100)).toBe("bottom");
  });

  it("water to the NORTH (pin below the line) → dry south → anchor top (text below)", () => {
    expect(drySideAnchor(0, -3, [river], 100)).toBe("top");
  });

  it("water to the WEST → dry east → anchor left (text to the right)", () => {
    const vertical: [number, number][] = [
      [0, -10],
      [0, 10],
    ];
    expect(drySideAnchor(4, 0, [vertical], 100)).toBe("left");
  });

  it("water to the EAST → dry west → anchor right (text to the left)", () => {
    const vertical: [number, number][] = [
      [0, -10],
      [0, 10],
    ];
    expect(drySideAnchor(-4, 0, [vertical], 100)).toBe("right");
  });

  it("returns null when water is beyond maxDist", () => {
    expect(drySideAnchor(0, 50, [river], 10)).toBeNull();
  });

  it("returns null when the pin sits exactly on the water line", () => {
    expect(drySideAnchor(0, 0, [river], 100)).toBeNull();
  });

  it("is deterministic — same inputs, same anchor", () => {
    const a = drySideAnchor(1.5, 2.5, [river], 100);
    const b = drySideAnchor(1.5, 2.5, [river], 100);
    expect(a).toBe(b);
  });
});

describe("waterPolylinesFromFabric", () => {
  const feat = (kind: string, geometry: FabricFeature["geometry"]): FabricFeature =>
    ({ id: kind, type: "Feature", geometry, properties: { kind } } as unknown as FabricFeature);

  it("extracts river lines and water polygon rings; ignores non-water kinds", () => {
    const features: FabricFeature[] = [
      feat("river", { type: "LineString", coordinates: [[0, 0], [1, 1]] }),
      feat("water", {
        type: "Polygon",
        coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]],
      }),
      feat("road", { type: "LineString", coordinates: [[9, 9], [8, 8]] }),
      feat("forest", {
        type: "Polygon",
        coordinates: [[[5, 5], [6, 5], [6, 6], [5, 5]]],
      }),
    ];
    const lines = waterPolylinesFromFabric(features);
    expect(lines).toHaveLength(2); // the river + the one water ring
    // The road/forest are not water.
    expect(lines.flat()).not.toContainEqual([9, 9]);
    expect(lines.flat()).not.toContainEqual([5, 5]);
  });
});

describe("decorateCanonWaterAvoidance — the label-feature builder", () => {
  const canon = (coords: [number, number]): GeoJSON.Feature => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: coords },
    properties: { name: "Pin" },
  });
  const river: [number, number][] = [
    [-10, 0],
    [10, 0],
  ];

  it("returns the collection untouched when there is no water", () => {
    const fc: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [canon([0, 3])] };
    expect(decorateCanonWaterAvoidance(fc, [], 100)).toBe(fc);
  });

  it("stamps dryAnchor on pins near water, leaves distant pins alone", () => {
    const fc: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: [canon([0, 3]), canon([0, 999])],
    };
    const out = decorateCanonWaterAvoidance(fc, [river], 100);
    expect(out.features[0].properties?.dryAnchor).toBe("bottom");
    expect(out.features[1].properties?.dryAnchor).toBeUndefined();
    // Non-mutating: original untouched.
    expect(fc.features[0].properties?.dryAnchor).toBeUndefined();
  });

  it("preserves existing properties", () => {
    const fc: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [canon([0, 3])] };
    const out = decorateCanonWaterAvoidance(fc, [river], 100);
    expect(out.features[0].properties?.name).toBe("Pin");
  });
});

describe("variableAnchorOffsetExpression", () => {
  it("favors each dry anchor at the head of its order", () => {
    expect(anchorOrderFavoring("top")[0]).toBe("top");
    expect(anchorOrderFavoring("left")).toEqual(["left", "bottom", "top", "right"]);
    // Default (no favoring) is the original order.
    expect([...DEFAULT_ANCHOR_ORDER]).toEqual(["bottom", "top", "right", "left"]);
  });

  it("produces a spec-valid data-driven text-variable-anchor-offset", () => {
    const style = {
      version: 8 as const,
      glyphs: "http://localhost/{fontstack}/{range}.pbf",
      sources: { canon: { type: "geojson" as const, data: { type: "FeatureCollection" as const, features: [] } } },
      layers: [
        {
          id: "canon-label",
          type: "symbol" as const,
          source: "canon",
          layout: {
            "text-field": ["get", "name"],
            "text-font": ["Inter Regular"],
            "text-variable-anchor-offset": variableAnchorOffsetExpression(),
          },
        },
      ],
    };
    const errors = validateStyleMin(style as unknown as Parameters<typeof validateStyleMin>[0]);
    expect(errors.map((e) => e.message)).toEqual([]);
  });
});
