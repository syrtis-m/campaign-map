import type { LayerSpecification } from "maplibre-gl";

/** Per-session travel path — a solid line tracing the locations a
 * session note wikilinks, in order. Modeled on `connectionLayers`: themed via
 * a passed token so it reads consistently across every map style, drawn above
 * terrain/basemap and connections, below canon pins/labels. Solid (vs.
 * connections' dashed line) so the two read as visually distinct layers when
 * both are on screen at once. */
export function sessionPathLayers(opts: { lineColor: string }): LayerSpecification[] {
  return [
    {
      id: "session-path-line",
      type: "line",
      source: "session-path",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": opts.lineColor,
        "line-width": ["interpolate", ["linear"], ["zoom"], 4, 1.5, 14, 3.5],
        "line-opacity": 0.9,
      },
    } as unknown as LayerSpecification,
  ];
}
