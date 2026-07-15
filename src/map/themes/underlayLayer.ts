import type { LayerSpecification, SourceSpecification } from "maplibre-gl";

/**
 * Reference-image underlay (plan 041 "trace mode"). A MapLibre `image` source +
 * `raster` layer that renders a positioned reference picture BELOW all fabric
 * (above the background) so a GM can trace a published map's coastline/ridges/
 * regions with the existing sketch tools. Display-only: it never regenerates
 * anything and it sits in its own z-group (`underlay`, between `background` and
 * `basemap` — see layerOrder.ts).
 *
 * The image URL is resolved through the DataAdapter (`getResourcePath`, never Node
 * fs — the same mechanism the font glyphs use) BEFORE the pure style builder runs,
 * so this module stays synchronous and has no object-URL lifecycle to leak.
 */

export const UNDERLAY_LAYER_ID = "underlay";
export const UNDERLAY_SOURCE_ID = "underlay-image";

/** A positioned underlay descriptor, resolved (url + display-unit corners) for the
 * style builders. `sw`/`ne` are the two anchor corners in display units. */
export interface UnderlayDescriptor {
  url: string;
  /** South-west corner [x, y] in display units (min-x, min-y). */
  sw: [number, number];
  /** North-east corner [x, y] in display units (max-x, max-y). */
  ne: [number, number];
  opacity: number;
  visible: boolean;
}

/**
 * The four image corners MapLibre's `image` source wants, in its required order:
 * top-left, top-right, bottom-right, bottom-left. Derived from the two anchor
 * corners (sw = min-x/min-y, ne = max-x/max-y) so the GM only places two points.
 */
export function underlayImageCoordinates(
  sw: [number, number],
  ne: [number, number]
): [[number, number], [number, number], [number, number], [number, number]] {
  const [minX, minY] = sw;
  const [maxX, maxY] = ne;
  return [
    [minX, maxY], // top-left
    [maxX, maxY], // top-right
    [maxX, minY], // bottom-right
    [minX, minY], // bottom-left
  ];
}

/** The `image` source spec for the underlay. */
export function underlaySourceSpec(descriptor: UnderlayDescriptor): SourceSpecification {
  return {
    type: "image",
    url: descriptor.url,
    coordinates: underlayImageCoordinates(descriptor.sw, descriptor.ne),
  } as SourceSpecification;
}

/** The `raster` layer spec for the underlay. Opacity is clamped 0..1; visibility
 * is a layout property so a live toggle is a cheap `setLayoutProperty`. */
export function underlayLayer(descriptor: UnderlayDescriptor): LayerSpecification {
  return {
    id: UNDERLAY_LAYER_ID,
    type: "raster",
    source: UNDERLAY_SOURCE_ID,
    layout: { visibility: descriptor.visible ? "visible" : "none" },
    paint: {
      "raster-opacity": Math.max(0, Math.min(1, descriptor.opacity)),
      // A reference underlay should read as a flat trace surface, not resampled/
      // faded at the seams — no fade-in, full resampling.
      "raster-fade-duration": 0,
    },
  } as LayerSpecification;
}
