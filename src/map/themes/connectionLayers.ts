import type { LayerSpecification } from "maplibre-gl";

/** Point-crawl travel connections — one dashed line layer, themed via tokens so
 * it reads consistently across every map style (parchment → neon-sprawl). Drawn
 * above terrain/basemap, below canon pins/labels. */
export function connectionLayers(opts: { lineColor: string }): LayerSpecification[] {
  return [
    {
      id: "connection-line",
      type: "line",
      source: "connections",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": opts.lineColor,
        "line-width": ["interpolate", ["linear"], ["zoom"], 4, 1, 14, 2.5],
        "line-dasharray": [2, 2],
        "line-opacity": 0.8,
      },
    } as unknown as LayerSpecification,
  ];
}
