import type { LayerSpecification } from "maplibre-gl";
import type { ThemeTokens } from "./tokens";

/**
 * Real-city basemap layers reading the Protomaps "basemap" vector schema
 * (layers: earth, water, landuse, landcover, roads, buildings, places, pois,
 * boundaries — docs.protomaps.com). `sourceId` is the vault-backed PMTiles source
 * (src/map/pmtilesVaultProtocol.ts). Every theme calls this with its own tokens so
 * a real city can wear any genre's paint (architecture §4 — "any real city becomes
 * Night City at 2am" under neon-sprawl).
 */
export function basemapLayers(sourceId: string, t: ThemeTokens): LayerSpecification[] {
  const majorRoadFilter = ["in", ["get", "kind"], ["literal", ["highway", "major_road"]]];
  const minorRoadFilter = ["!", majorRoadFilter];

  const layers: LayerSpecification[] = [
    {
      id: "basemap-earth",
      type: "fill",
      source: sourceId,
      "source-layer": "earth",
      paint: { "fill-color": t.land },
    },
    {
      id: "basemap-landuse",
      type: "fill",
      source: sourceId,
      "source-layer": "landuse",
      paint: { "fill-color": t.water, "fill-opacity": 0.08 },
    },
    {
      id: "basemap-water",
      type: "fill",
      source: sourceId,
      "source-layer": "water",
      paint: { "fill-color": t.water },
    },
  ];

  // road casing (wide, under-layer) — modern-clean's gold outline / neon-sprawl's glow
  if (t.roadMajorCasing) {
    layers.push({
      id: "basemap-road-major-casing",
      type: "line",
      source: sourceId,
      "source-layer": "roads",
      filter: majorRoadFilter,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": t.roadMajorCasing,
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 2, 16, 10],
        "line-opacity": t.id === "neon-sprawl" ? 0.35 : 1,
        "line-blur": t.id === "neon-sprawl" ? 3 : 0,
      },
    } as unknown as LayerSpecification);
  }

  layers.push(
    {
      id: "basemap-road-minor",
      type: "line",
      source: sourceId,
      "source-layer": "roads",
      filter: minorRoadFilter,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": t.roadMinor,
        "line-width": ["interpolate", ["linear"], ["zoom"], 10, 0.5, 18, 3],
      },
    } as unknown as LayerSpecification,
    {
      id: "basemap-road-major",
      type: "line",
      source: sourceId,
      "source-layer": "roads",
      filter: majorRoadFilter,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": t.roadMajor,
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 1, 16, 6],
      },
    } as unknown as LayerSpecification,
    {
      id: "basemap-buildings",
      type: "fill",
      source: sourceId,
      "source-layer": "buildings",
      minzoom: 14,
      paint: { "fill-color": t.roadMinor, "fill-opacity": 0.25 },
    } as unknown as LayerSpecification,
    {
      id: "basemap-place-label",
      type: "symbol",
      source: sourceId,
      "source-layer": "places",
      layout: {
        "text-field": ["get", "name"],
        "text-font": [t.fontRegion],
        "text-size": [
          "interpolate",
          ["linear"],
          ["coalesce", ["get", "population_rank"], 5],
          0,
          11,
          20,
          20,
        ],
        "symbol-sort-key": ["-", 20, ["coalesce", ["get", "population_rank"], 0]],
        "text-optional": true,
      },
      paint: {
        "text-color": t.labelMajor,
        "text-halo-color": t.land,
        "text-halo-width": 1.2,
      },
    } as unknown as LayerSpecification
  );

  return layers;
}
