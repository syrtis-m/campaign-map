import { describe, it, expect } from "vitest";
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import {
  regionLabelLayers,
  regionLabelOpacityRamp,
  regionLabelPointFeatures,
  REGION_LABEL_LAYER_ID,
  REGION_LABEL_SOURCE_ID,
  REGION_LABEL_OPACITY,
} from "./regionLabels";
import { PARCHMENT } from "./tokens";
import { layerGroupOf } from "./layerOrder";
import type { FabricFeature } from "../../model/fabric";

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

  it("emits a single symbol layer on the dedicated region-labels point source", () => {
    expect(layers).toHaveLength(1);
    expect(layer.id).toBe(REGION_LABEL_LAYER_ID);
    expect(layer.type).toBe("symbol");
    // NOT the giant `fabric` polygon source — a canvas-filling region would
    // repeat the symbol per-tile there; one centroid point avoids it.
    expect(layer.source).toBe(REGION_LABEL_SOURCE_ID);
    expect(layer.source).not.toBe("fabric");
  });

  it("classifies into the fabric z-order group (below locations)", () => {
    expect(layerGroupOf(REGION_LABEL_LAYER_ID)).toBe("fabric");
  });

  it("filters to NAMED features — never gates existence by zoom", () => {
    const f = JSON.stringify(layer.filter);
    expect(f).toContain('"name"'); // has name
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
      sources: {
        [REGION_LABEL_SOURCE_ID]: { type: "geojson" as const, data: { type: "FeatureCollection" as const, features: [] } },
      },
      layers,
    };
    const errors = validateStyleMin(style as unknown as Parameters<typeof validateStyleMin>[0]);
    expect(errors.map((e) => e.message)).toEqual([]);
  });
});

describe("regionLabelPointFeatures — one centroid point per named region", () => {
  const poly = (
    id: string,
    name: string | undefined,
    coordinates: number[][][]
  ): FabricFeature =>
    ({
      type: "Feature",
      id,
      geometry: { type: "Polygon", coordinates },
      properties: { kind: "district", ...(name !== undefined ? { name } : {}) },
    }) as unknown as FabricFeature;

  const line = (id: string, name: string): FabricFeature =>
    ({
      type: "Feature",
      id,
      geometry: { type: "LineString", coordinates: [[0, 0], [10, 0]] },
      properties: { kind: "river", name },
    }) as unknown as FabricFeature;

  const unitSquare = [[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]]];

  it("emits exactly one POINT per named polygon at its centroid", () => {
    const fc = regionLabelPointFeatures([poly("a", "Alpha", unitSquare)]);
    expect(fc.features).toHaveLength(1);
    const f = fc.features[0];
    expect(f.geometry.type).toBe("Point");
    expect((f.geometry as GeoJSON.Point).coordinates).toEqual([2, 2]);
    expect(f.properties?.name).toBe("Alpha");
  });

  it("skips unnamed polygons and line kinds (only named area regions get a label)", () => {
    const fc = regionLabelPointFeatures([
      poly("named", "Kept", unitSquare),
      poly("unnamed", undefined, unitSquare),
      line("river", "Ignored River"),
    ]);
    expect(fc.features.map((f) => f.properties?.name)).toEqual(["Kept"]);
  });

  it("area-weights a donut (holes) so the label lands OFF the enclosed island", () => {
    // A big square sea with a central square island hole (opposite winding).
    // A naive vertex-average would sit at the shared center (ON the island); the
    // area-weighted centroid of a SYMMETRIC donut also sits at center, so offset
    // the hole to prove holes are subtracted, not averaged in.
    const outer = [[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]];
    // Hole in the RIGHT half, wound opposite (clockwise) to the CCW outer ring.
    const hole = [[60, 40], [60, 60], [80, 60], [80, 40], [60, 40]];
    const fc = regionLabelPointFeatures([poly("sea", "The Deep", [outer, hole])]);
    expect(fc.features).toHaveLength(1);
    const [x, y] = (fc.features[0].geometry as GeoJSON.Point).coordinates;
    // Removing right-side area pulls the centroid LEFT of the plate center (50).
    expect(x).toBeLessThan(50);
    // The hole is vertically centered, so y stays ~50.
    expect(y).toBeCloseTo(50, 0);
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
