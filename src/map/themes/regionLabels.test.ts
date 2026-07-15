import { describe, it, expect } from "vitest";
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import {
  regionLabelLayers,
  regionLabelOpacityRamp,
  REGION_LABEL_LAYER_ID,
  REGION_LABEL_OPACITY,
} from "./regionLabels";
import { PARCHMENT } from "./tokens";
import { layerGroupOf } from "./layerOrder";

describe("regionLabelLayers — named-region overview label", () => {
  const layers = regionLabelLayers(PARCHMENT);
  const layer = layers[0] as {
    id: string;
    type: string;
    source: string;
    filter: unknown;
    layout: Record<string, unknown>;
    paint: Record<string, unknown>;
  };

  it("emits a single symbol layer on the fabric source", () => {
    expect(layers).toHaveLength(1);
    expect(layer.id).toBe(REGION_LABEL_LAYER_ID);
    expect(layer.type).toBe("symbol");
    expect(layer.source).toBe("fabric");
  });

  it("classifies into the fabric z-order group (below locations)", () => {
    expect(layerGroupOf(REGION_LABEL_LAYER_ID)).toBe("fabric");
  });

  it("filters to NAMED polygon regions only — never gates existence by zoom", () => {
    const f = JSON.stringify(layer.filter);
    expect(f).toContain('"name"'); // has name
    expect(f).toContain("Polygon"); // area regions only
    // Zoom in a filter silently invalidates the whole style — never here.
    expect(f).not.toContain('"zoom"');
  });

  it("uses the theme region font, is letterspaced + uppercased, in the fainter labelMinor ink", () => {
    expect(layer.layout["text-font"]).toEqual([PARCHMENT.fontRegion]);
    expect(layer.layout["text-transform"]).toBe("uppercase");
    expect(layer.layout["text-letter-spacing"]).toBeGreaterThan(0);
    expect(layer.paint["text-color"]).toBe(PARCHMENT.labelMinor);
  });

  it("ships a constant fallback opacity (the runtime ramp overrides it)", () => {
    expect(layer.paint["text-opacity"]).toBe(REGION_LABEL_OPACITY);
  });

  it("passes MapLibre style validation", () => {
    const style = {
      version: 8 as const,
      glyphs: "http://localhost/{fontstack}/{range}.pbf",
      sources: { fabric: { type: "geojson" as const, data: { type: "FeatureCollection" as const, features: [] } } },
      layers,
    };
    const errors = validateStyleMin(style as unknown as Parameters<typeof validateStyleMin>[0]);
    expect(errors.map((e) => e.message)).toEqual([]);
  });
});

describe("regionLabelOpacityRamp — campaign-relative fade, not a minzoom gate", () => {
  it("is full at the overview zoom and 0 by the Mid level (overview + 3)", () => {
    const base = 4.5;
    const ramp = regionLabelOpacityRamp(base) as [string, unknown, unknown, number, number, number, number];
    expect(ramp[0]).toBe("interpolate");
    // stops: [base -> REGION_LABEL_OPACITY, base+3 -> 0]
    expect(ramp[3]).toBe(base);
    expect(ramp[4]).toBe(REGION_LABEL_OPACITY);
    expect(ramp[5]).toBe(base + 3);
    expect(ramp[6]).toBe(0);
  });
});
