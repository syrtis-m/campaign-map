import type { LayerSpecification } from "maplibre-gl";

/**
 * Canon-location circle + label layers, shared by every theme (obsidian-native and the
 * four handcrafted genre themes). CLAUDE.md: "themes own ALL paint" — every theme calls
 * this with its own tokens, but the feature schema and collision/zoom-range logic (F1)
 * stay identical so canon and (later) generated content render indistinguishably (F2).
 */
export function canonLayers(opts: {
  pointColor: string;
  pointHaloColor: string;
  textColor: string;
  textHaloColor: string;
  fontStack: string;
}): LayerSpecification[] {
  const zoomFilter = ["all", ["<=", ["get", "minZoom"], ["zoom"]], ["<=", ["zoom"], ["get", "maxZoom"]]];
  return [
    {
      id: "canon-point",
      type: "circle",
      source: "canon",
      filter: zoomFilter,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["get", "importance"], 1, 7, 7, 3],
        "circle-color": opts.pointColor,
        "circle-stroke-width": 1.5,
        "circle-stroke-color": opts.pointHaloColor,
      },
    } as unknown as LayerSpecification,
    {
      id: "canon-label",
      type: "symbol",
      source: "canon",
      filter: zoomFilter,
      layout: {
        "text-field": ["get", "name"],
        "text-font": [opts.fontStack],
        "text-size": ["interpolate", ["linear"], ["get", "importance"], 1, 18, 7, 11],
        "text-offset": [0, 1.1],
        "text-anchor": "top",
        "symbol-sort-key": ["get", "importance"],
        "text-optional": true,
      },
      paint: {
        "text-color": opts.textColor,
        "text-halo-color": opts.textHaloColor,
        "text-halo-width": 1.5,
      },
    } as unknown as LayerSpecification,
  ];
}
