import type { LayerSpecification } from "maplibre-gl";
import { iconCategoryExpression } from "../icons";

/**
 * Canon-location circle + label layers, shared by every theme (obsidian-native and the
 * four handcrafted genre themes). CLAUDE.md: "themes own ALL paint" — every theme calls
 * this with its own tokens, but the feature schema and collision/zoom-range logic (F1)
 * stay identical so canon and (later) generated content render indistinguishably (F2).
 *
 * `opts.icons` (plan 006 spike): when set, adds a `canon-point-icon` symbol layer using
 * per-type-category glyphs registered by `registerTypeIcons` (src/map/icons.ts). Opt-in
 * and only ever passed by `obsidian-native` (src/map/theme.ts) — the four handcrafted
 * themes keep the plain circle for now; see plans/006-NOTES.md for why the rollout to
 * all five themes is a separate follow-up, not part of this spike.
 */
export function canonLayers(opts: {
  pointColor: string;
  pointHaloColor: string;
  textColor: string;
  textHaloColor: string;
  fontStack: string;
  icons?: boolean;
}): LayerSpecification[] {
  const zoomFilter = ["all", ["<=", ["get", "minZoom"], ["zoom"]], ["<=", ["zoom"], ["get", "maxZoom"]]];
  const layers: LayerSpecification[] = [
    {
      // Google Maps keeps a small dot for saved places at any zoom, even when
      // there's no room to show the full pin/label — a location shouldn't
      // just vanish below its type's zoomMin. Filtered to *only* the zoomed-
      // out-past-minZoom case so it never double-renders under canon-point.
      id: "canon-point-far",
      type: "circle",
      source: "canon",
      filter: ["<", ["zoom"], ["get", "minZoom"]],
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["get", "importance"], 1, 4, 7, 2],
        "circle-color": opts.pointColor,
        "circle-opacity": 0.75,
      },
    } as unknown as LayerSpecification,
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
  ];

  if (opts.icons) {
    layers.push({
      // Rendered above canon-point (icon glyph on top of the existing halo
      // circle, not a replacement — see the module doc comment: if an icon
      // image is somehow missing, the circle underneath is still there, so
      // nothing regresses). Anchored center, same zoomFilter/source as
      // canon-point so the two are always co-located.
      id: "canon-point-icon",
      type: "symbol",
      source: "canon",
      filter: zoomFilter,
      layout: {
        "icon-image": ["concat", "type-", iconCategoryExpression()],
        "icon-size": ["interpolate", ["linear"], ["get", "importance"], 1, 1, 7, 0.6],
        "icon-anchor": "center",
        // Regions/cities (importance <= 2) never collide-hide; everything
        // else participates in normal symbol collision like canon-label.
        "icon-allow-overlap": ["<=", ["get", "importance"], 2],
        "symbol-sort-key": ["get", "importance"],
      },
    } as unknown as LayerSpecification);
  }

  layers.push({
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
  } as unknown as LayerSpecification);

  return layers;
}
