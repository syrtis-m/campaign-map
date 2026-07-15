import type { LayerSpecification } from "maplibre-gl";
import type { ThemeTokens } from "./tokens";

/**
 * Named-region overview labels — a centroid label for any sketched REGION
 * polygon (forest / farmland / park / district / water etc.) that carries a
 * `name`. Styled distinctly from location labels: the theme's region glyph
 * stack (`fontRegion`), letterspaced + uppercased for a small-caps-ish area-name
 * look, in the fainter `labelMinor` ink, so it reads as a background area label,
 * never competing with a location name.
 *
 * The layer rides on the SAME `fabric` source as the sketch shapes — a symbol
 * layer with the default `symbol-placement: point` puts the label at each
 * polygon's centroid automatically, so no separate centroid source is needed and
 * a rename/redraw of the sketch reflects instantly (the fabric mirror already
 * carries `name`). The filter is `has name AND polygon geometry` — line kinds
 * (rivers/roads/walls) are excluded here; only area regions get the overview
 * label.
 *
 * VISIBILITY — an OPACITY RAMP, never a minzoom gate on existence (CLAUDE law:
 * fabric renders at every zoom; opacity ramps are the sanctioned fade tool). The
 * static layer ships a plain constant opacity (no baked absolute zoom — overview
 * zoom is campaign-relative and unknown at build time). MapView installs the
 * real campaign-relative ramp at `applyFocusReveal` time via `setPaintProperty`
 * (see `regionLabelOpacityRamp`): full at the overview (Wide) level, fading to 0
 * by the Mid level, so region names anchor the far-out view and get out of the
 * way as you zoom into the detail. The id is `fabric-…`, so it classifies into
 * the `fabric` z-order group (below locations) with zero changes to
 * `layerOrder.ts`.
 */

export const REGION_LABEL_LAYER_ID = "fabric-region-label";

/** Constant fallback opacity baked into the static style (overwritten at runtime
 * by the campaign-relative ramp). A visible-everywhere fallback is a safe
 * default — never a blank void — for a campaign that never captured an overview
 * zoom (e.g. a real-city map with no fitBounds pass). */
export const REGION_LABEL_OPACITY = 0.7;

export function regionLabelLayers(tokens: ThemeTokens): LayerSpecification[] {
  return [
    {
      id: REGION_LABEL_LAYER_ID,
      type: "symbol",
      source: "fabric",
      // Named AREA regions only. `geometry-type` keeps line kinds (river/road/
      // wall) out — those are not overview area labels. NO zoom in the filter
      // (that silently invalidates the whole style); the fade is a paint ramp.
      filter: ["all", ["has", "name"], ["==", ["geometry-type"], "Polygon"]],
      layout: {
        "text-field": ["get", "name"],
        "text-font": [tokens.fontRegion],
        "text-size": ["interpolate", ["linear"], ["zoom"], 4, 12, 12, 15],
        // Small-caps-ish area-name treatment: letterspaced + uppercased.
        "text-letter-spacing": 0.18,
        "text-transform": "uppercase",
        "text-max-width": 7,
        "text-line-height": 1.3,
        // Region names sort AFTER (yield to) location labels within their own
        // collision bucket via a high sort key; they also fade out before the
        // detail zooms, so they stay a background wash.
        "symbol-sort-key": 100,
        "text-padding": 4,
      },
      paint: {
        "text-color": tokens.labelMinor,
        "text-halo-color": tokens.land,
        "text-halo-width": 1.25,
        "text-opacity": REGION_LABEL_OPACITY,
      },
    } as unknown as LayerSpecification,
  ];
}

/**
 * The campaign-relative opacity ramp MapView installs at runtime once the
 * overview (Wide) zoom is known: full near the overview, gone by the Mid level
 * (overview + 3, matching the focus-stepper spacing). An opacity ramp — the
 * sanctioned zoom-fade — NOT a minzoom gate; the label feature always exists,
 * it just becomes transparent as you zoom past the overview into the detail.
 */
export function regionLabelOpacityRamp(overviewZoom: number): unknown {
  return [
    "interpolate",
    ["linear"],
    ["zoom"],
    overviewZoom,
    REGION_LABEL_OPACITY,
    overviewZoom + 3,
    0,
  ];
}
