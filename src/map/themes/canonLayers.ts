import type { LayerSpecification } from "maplibre-gl";
import { FOCUS_DEPTHS, type FocusDepth } from "../../model/locationNote";

/** Constant on-map dot radius (px) for every location, canon or generated —
 * consistent size at every zoom, never importance-scaled. Shared so generated
 * settlements match canon exactly (provenance invisibility, quality-bar F2). */
export const CANON_DOT_RADIUS = 5;

/** Placeholder reveal floors (MapLibre zoom) for the depth-of-field label
 * buckets. `deep` labels are always on; `medium`/`shallow` reveal as you zoom
 * in. These defaults are overwritten per-campaign at runtime via
 * `map.setLayerZoomRange` once the campaign's overview zoom is known — the
 * three focus levels are relative to each campaign's fit, not absolute, so a
 * fictional world (overview ~z5) and a real city (overview ~z11) both get the
 * same three-step Wide/Mid/Close behavior (see MapView.applyFocusZooms). */
export const FOCUS_REVEAL_ZOOM_DEFAULT: Record<FocusDepth, number> = {
  deep: 0,
  medium: 12,
  shallow: 15,
};

export function focusLabelLayerId(prefix: string, depth: FocusDepth): string {
  return `${prefix}-label-${depth}`;
}

/**
 * The depth-of-field label layers: one symbol layer per bucket
 * (deep/medium/shallow), each filtered by the feature's `focus` property ONLY
 * and gated by the layer's numeric `minzoom` (the reveal floor). Zoom is NEVER
 * put in the filter — a `["zoom"]` expression compared to anything in a layer
 * `filter` silently invalidates the entire style (map loads blank, no console
 * error, unit tests stay green; this class of bug has shipped twice). The
 * always-on dot lives in a separate circle layer, so a location never vanishes
 * on zoom-out — only its name reveals/hides. Shared verbatim by canon and
 * generated sources so provenance stays invisible (quality-bar F2).
 */
export function focusLabelLayers(opts: {
  source: string;
  prefix: string;
  textColor: string;
  textHaloColor: string;
  fontStack: string;
}): LayerSpecification[] {
  return FOCUS_DEPTHS.map(
    (depth) =>
      ({
        id: focusLabelLayerId(opts.prefix, depth),
        type: "symbol",
        source: opts.source,
        minzoom: FOCUS_REVEAL_ZOOM_DEFAULT[depth],
        filter: ["==", ["get", "focus"], depth],
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
      }) as unknown as LayerSpecification
  );
}

/**
 * Canon-location circle + label layers, shared by every theme (obsidian-native and the
 * four handcrafted genre themes). CLAUDE.md: "themes own ALL paint" — every theme calls
 * this with its own tokens, but the feature schema and collision/depth-of-field logic
 * stay identical so canon and generated content render indistinguishably (F2).
 */
export function canonLayers(opts: {
  pointColor: string;
  pointHaloColor: string;
  textColor: string;
  textHaloColor: string;
  fontStack: string;
}): LayerSpecification[] {
  return [
    {
      // One dot, every zoom, one size — the always-present "bokeh" marker. It
      // has NO zoom filter and a CONSTANT radius, so a location never shrinks by
      // importance or vanishes when you zoom out; only its NAME reveals/hides,
      // per the depth-of-field buckets below.
      id: "canon-point",
      type: "circle",
      source: "canon",
      paint: {
        "circle-radius": CANON_DOT_RADIUS,
        "circle-color": opts.pointColor,
        "circle-stroke-width": 1.5,
        "circle-stroke-color": opts.pointHaloColor,
      },
    } as unknown as LayerSpecification,
    ...focusLabelLayers({
      source: "canon",
      prefix: "canon",
      textColor: opts.textColor,
      textHaloColor: opts.textHaloColor,
      fontStack: opts.fontStack,
    }),
  ];
}
