import { describe, it, expect } from "vitest";
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import {
  regionLabelLayers,
  regionLabelOpacityRamp,
  regionLabelPointFeatures,
  regionLabelSourceData,
  REGION_LABEL_LAYER_ID,
  REGION_LABEL_SOURCE_ID,
  REGION_LABEL_OPACITY,
} from "./regionLabels";
import type { CampaignConfig } from "../../model/campaignConfig";
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

  // ─── Inverted sea (Item 3, Cradle bug 2026-07-15) ──────────────────────────
  const invertedSea = (id: string, name: string, coast: number[][]): FabricFeature =>
    ({
      type: "Feature",
      id,
      geometry: { type: "Polygon", coordinates: [coast] },
      properties: { kind: "landform", name, procgen: { algorithm: "landform", seed: 1, version: 1, params: { mode: "sea", band: 5, invert: true } } },
    }) as unknown as FabricFeature;

  it("places an inverted sea's label in the WATER (outside the island coast), not mid-island", () => {
    // Island coast centred at the origin; its drawn ring's centroid is the island
    // CENTER — the old behaviour put "The Deep" there, the one dry spot.
    const coast = [[-10, -10], [10, -10], [10, 10], [-10, 10], [-10, -10]];
    const fc = regionLabelPointFeatures([invertedSea("sea", "The Deep", coast)], {
      cfgBounds: [-100, -100, 100, 100],
      seaDatum: 0,
    });
    expect(fc.features).toHaveLength(1);
    const [x, y] = (fc.features[0].geometry as GeoJSON.Point).coordinates;
    // Outside the island coast bbox ([-10,10]²) and inside the campaign box.
    expect(Math.abs(x) > 10 || Math.abs(y) > 10).toBe(true);
    expect(x).toBeGreaterThanOrEqual(-100);
    expect(x).toBeLessThanOrEqual(100);
  });

  it("leaves a normal named region's label at its centroid (invert path untouched)", () => {
    const fc = regionLabelPointFeatures([poly("farm", "Green Acres", unitSquare)], {
      cfgBounds: [-100, -100, 100, 100],
      seaDatum: 0,
    });
    expect((fc.features[0].geometry as GeoJSON.Point).coordinates).toEqual([2, 2]);
  });
});

// ─── Live-wiring regression (the "mid-island THE DEEP" bug) ────────────────────
//
// The inverted-sea label was correct in `regionLabelPointFeatures` (unit-tested),
// but the CampaignConfig → RegionLabelOptions threading MapView.refreshFabric does
// had NO test — an ItemView can't be driven headlessly. `regionLabelSourceData` is
// that threading extracted; these tests are the integration guard: a Cradle-shaped
// inverted sea (island coast at the box centre) must NEVER be labelled mid-island,
// on the first derivation or any later one, config present OR not.
describe("regionLabelSourceData — MapView.refreshFabric label wiring", () => {
  // Ray-cast point-in-polygon (the label must land OUTSIDE the drawn coast ring).
  const insideRing = (ring: number[][], x: number, y: number): boolean => {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };

  // Cradle-shaped inverted sea: a square island coast centred on the box origin (so
  // the naive ring centroid ([0,0]) is the one spot that is NOT water), sized to sit
  // WITHIN the campaign box — the real relationship (the Cradle coast fits inside its
  // [-9.2, 9.2] bounds and even inside the [-8,-6,8,6] fallback box).
  const coast = [
    [-4, -4],
    [4, -4],
    [4, 4],
    [-4, 4],
    [-4, -4],
  ];
  const seaFeature = {
    type: "Feature",
    id: "sea",
    geometry: { type: "Polygon", coordinates: [coast] },
    properties: {
      kind: "landform",
      name: "The Deep",
      procgen: { algorithm: "landform", seed: 1, version: 1, params: { mode: "sea", band: 5, invert: true } },
    },
  } as unknown as FabricFeature;

  const config = {
    crs: "fictional",
    bounds: [-40, -40, 40, 40],
    terrain: { campAmp: 0, seaDatum: 0, grade: false },
  } as unknown as CampaignConfig;

  const deepPoint = (fc: GeoJSON.FeatureCollection): [number, number] => {
    const f = fc.features.find((x) => x.properties?.name === "The Deep")!;
    return (f.geometry as GeoJSON.Point).coordinates as [number, number];
  };

  it("threads config bounds/crs/seaDatum so the inverted-sea label lands in WATER, not mid-island", () => {
    const [x, y] = deepPoint(regionLabelSourceData([seaFeature], config));
    expect(insideRing(coast, x, y)).toBe(false); // outside the island coast = water
    expect(x).toBeGreaterThanOrEqual(-100);
    expect(x).toBeLessThanOrEqual(100);
  });

  it("first-load safety: even an ABSENT config (defensive edge) lands a normal coast in water, never the ring centroid", () => {
    // On a genuine first open `this.campaign` is set BEFORE loadFabric fires the
    // repaint, so refreshFabric always sees the config — there is no one-refresh lag
    // that flashes the mid-island centroid. This exercises the defensive absent-config
    // path anyway: placement is DATA-driven (procgen.params.invert), not opts-driven,
    // so a normally-sized coast (inside the [-8,-6,8,6] fallback box) still lands in
    // open water. (A coast LARGER than the fallback box is the sole edge where the
    // pole-of-inaccessibility falls back to box-centre — not reachable in practice,
    // since the config that bounds the water is present.)
    const [x, y] = deepPoint(regionLabelSourceData([seaFeature], undefined));
    expect(insideRing(coast, x, y)).toBe(false);
    // Definitely NOT the naive centroid (0,0) that the old ring-centroid path gave.
    expect(Math.hypot(x, y)).toBeGreaterThan(0);
  });

  it("a normal (non-inverted) region keeps its centroid through the wiring", () => {
    const farm = {
      type: "Feature",
      id: "farm",
      geometry: { type: "Polygon", coordinates: [[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]]] },
      properties: { kind: "farmland", name: "Green Acres" },
    } as unknown as FabricFeature;
    const fc = regionLabelSourceData([farm], config);
    expect((fc.features[0].geometry as GeoJSON.Point).coordinates).toEqual([2, 2]);
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
