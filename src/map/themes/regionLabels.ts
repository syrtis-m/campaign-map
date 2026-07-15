import type { LayerSpecification } from "maplibre-gl";
import type { ThemeTokens } from "./tokens";
import type { FabricFeature } from "../../model/fabric";

/**
 * Named-region overview labels — a centroid label for any sketched REGION
 * polygon (forest / farmland / park / district / water / landform etc.) that
 * carries a `name`. Styled distinctly from location labels: the theme's region
 * glyph stack (`fontRegion`), letterspaced + uppercased for a small-caps-ish
 * area-name look, in the fainter `labelMinor` ink, so it reads as a background
 * area label, never competing with a location name.
 *
 * The layer rides on its OWN dedicated `region-labels` GeoJSON source of ONE
 * centroid POINT per named region (built by `regionLabelPointFeatures` at fabric
 * refresh time), NOT on the `fabric` polygon source. Symbol placement on a giant
 * polygon (`symbol-placement: point`) repeats the label once per TILE the polygon
 * spans — a canvas-filling sea plate showed "THE DEEP" four-plus times. A point
 * source collapses each region to a single label at its polygon centroid (a
 * multi-ring / donut sea's centroid is area-weighted over its rings, so the label
 * lands in open water, not on the enclosed island), regardless of the region's
 * on-screen size. A rename/redraw still reflects instantly — the point source is
 * rederived from the same fabric mirror on every `refreshFabric`.
 *
 * The layer filter stays `has name` as a defensive belt (the point source is
 * already pre-filtered to named regions); line kinds never reach the source, so
 * the old `geometry-type == Polygon` clause is gone.
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

/** Dedicated GeoJSON source for the one-centroid-point-per-region features
 * (`regionLabelPointFeatures`). Distinct from the `fabric` polygon source so a
 * canvas-filling region gets exactly one label, never one per spanned tile. */
export const REGION_LABEL_SOURCE_ID = "region-labels";

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
      source: REGION_LABEL_SOURCE_ID,
      // The source already holds ONE named-region centroid point each; `has name`
      // is a defensive belt. NO zoom in the filter (that silently invalidates the
      // whole style); the fade is a paint ramp.
      filter: ["has", "name"],
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

type LabelPt = [number, number];

/**
 * Area-weighted polygon centroid over ALL rings. A hole ring (opposite winding
 * to the outer ring, as GeoJSON / a donut sea uses) carries an opposite-signed
 * cross term, so it is subtracted automatically — the centroid of a canvas-sized
 * sea with a central island hole is pulled OFF the island into open water. Falls
 * back to the mean of the outer ring's vertices for a degenerate (zero-area)
 * polygon so a label always lands somewhere sane.
 */
function polygonCentroid(rings: LabelPt[][]): LabelPt {
  let area2 = 0;
  let cx = 0;
  let cy = 0;
  for (const ring of rings) {
    for (let i = 0; i + 1 < ring.length; i++) {
      const [x0, y0] = ring[i];
      const [x1, y1] = ring[i + 1];
      const cross = x0 * y1 - x1 * y0;
      area2 += cross;
      cx += (x0 + x1) * cross;
      cy += (y0 + y1) * cross;
    }
  }
  // centroid = (1/(6A))·Σ(x_i+x_{i+1})·cross, with A = area2/2 ⇒ 6A = 3·area2.
  // The sign of area2 cancels between numerator and denominator, so hole winding
  // never flips the result.
  if (area2 !== 0) return [cx / (3 * area2), cy / (3 * area2)];
  const outer = rings[0] ?? [];
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let i = 0; i + 1 < outer.length; i++) {
    sx += outer[i][0];
    sy += outer[i][1];
    n++;
  }
  return n > 0 ? [sx / n, sy / n] : [0, 0];
}

/**
 * Build the `region-labels` source data: ONE centroid POINT feature per named
 * polygon region in the fabric. Line kinds (river/road/wall/relief) and unnamed
 * shapes are skipped — only named area regions get an overview label. This is the
 * dedicated-point-source mechanism that replaces per-tile symbol repetition on
 * the giant `fabric` polygon source; MapView rederives it on every fabric
 * refresh, so a rename / redraw reflects immediately.
 */
export function regionLabelPointFeatures(
  features: readonly FabricFeature[]
): GeoJSON.FeatureCollection {
  const out: GeoJSON.Feature[] = [];
  for (const f of features) {
    const name = f.properties.name;
    if (typeof name !== "string" || name.length === 0) continue;
    if (f.geometry.type !== "Polygon") continue;
    const rings = f.geometry.coordinates as LabelPt[][];
    if (rings.length === 0 || rings[0].length < 3) continue;
    const [x, y] = polygonCentroid(rings);
    out.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [x, y] },
      properties: { name },
    });
  }
  return { type: "FeatureCollection", features: out };
}
