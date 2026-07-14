import type { LayerSpecification } from "maplibre-gl";
import type { ThemeTokens } from "../tokens";
import { riverIconImageExpr } from "../../riverGlyphs";

/**
 * Derive the bank-casing stroke from the theme's river hue: same hue, darker —
 * the deliberate dark-edge stroke of the cartographic depth idiom (plan 028
 * §1.1; OSM Carto rule: everything WATER-hued stays exactly `fabricRiver`, so
 * fill/fill overlaps never artifact — the casing is the one deliberate
 * departure). Derived here because tokens.ts is outside this box's footprint
 * (∥ P1 protocol); if a dedicated casing token lands later, this helper
 * collapses into it. Non-6-digit-hex inputs pass through unchanged.
 */
function darken(hex: string, amount: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const ch = (v: number): string =>
    Math.max(0, Math.min(255, Math.round(v * (1 - amount))))
      .toString(16)
      .padStart(2, "0");
  return `#${ch((n >> 16) & 0xff)}${ch((n >> 8) & 0xff)}${ch(n & 0xff)}`;
}

/** Linear channel-wise hex blend `a*(1−t) + b*t` — the point-bar SAND tone is a
 * blend of the theme's land and its cultivated ochre (`fabricFarmland`), so a
 * point bar reads as warm silt distinct from both the land island and the
 * water (plan 028 §1.4). Kept local for the same ∥-protocol reason as
 * `darken` (tokens.ts is outside this box). */
function mix(a: string, b: string, t: number): string {
  const ma = /^#([0-9a-f]{6})$/i.exec(a);
  const mb = /^#([0-9a-f]{6})$/i.exec(b);
  if (!ma || !mb) return a;
  const na = parseInt(ma[1], 16);
  const nb = parseInt(mb[1], 16);
  const ch = (sa: number, sb: number): string =>
    Math.max(0, Math.min(255, Math.round(sa * (1 - t) + sb * t)))
      .toString(16)
      .padStart(2, "0");
  return `#${ch((na >> 16) & 0xff, (nb >> 16) & 0xff)}${ch((na >> 8) & 0xff, (nb >> 8) & 0xff)}${ch(na & 0xff, nb & 0xff)}`;
}

/**
 * River fabric (plan 022 §3.1; bank casing + merged channel per plan 028
 * §1.1). Order is the depth idiom: dark bank casing UNDER the channel fill
 * (only the outer half of the stroke shows → dark edge, light core), islands
 * land-hued ABOVE the water. NO zoom LOD (Jonah 2026-07-12).
 */
export function riverLayers(t: ThemeTokens): LayerSpecification[] {
  return [
    {
      // Bank casing (plan 028 §1.1): the generator's left/right/braid bank
      // LineStrings, stroked dark UNDER the channel fill. Round joins/caps keep
      // the casing continuous across the shared per-segment joint vertices.
      id: "generated-river-bank",
      type: "line",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "river-bank"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": darken(t.fabricRiver, 0.3), "line-width": 1.6 },
    } as unknown as LayerSpecification,
    {
      // The generated channel is water — same hue as a sketched river/water
      // (F2: one legend per kind). Opacity 1 (was 0.85 pre-028): the merged
      // ribbons deliberately OVERLAP at joints and braids, and any opacity < 1
      // double-darkens the overlap into a visible seam bar; full opacity also
      // lets the under-painted casing read as an edge, not a wash.
      id: "generated-river-channel",
      type: "fill",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "river-channel"],
      paint: { "fill-color": t.fabricRiver, "fill-opacity": 1 },
    } as unknown as LayerSpecification,
    {
      // Confluence Y-merge gusset (plan 028 §1.4): the widened water wedge that
      // smooths two rivers meeting into a Y. Water-hued (hue discipline — the
      // overlap with the channel shares the fabricRiver fill, never artifacts).
      id: "generated-river-confluence",
      type: "fill",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "river-confluence"],
      paint: { "fill-color": t.fabricRiver, "fill-opacity": 1 },
    } as unknown as LayerSpecification,
    {
      // Delta distributaries (plan 028 §1.4): the bird's-foot arms fanning off
      // the terminal mouth — water, same hue as the channel.
      id: "generated-river-distributary",
      type: "fill",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "river-distributary"],
      paint: { "fill-color": t.fabricRiver, "fill-opacity": 1 },
    } as unknown as LayerSpecification,
    {
      // Estuary trumpet (plan 028 §1.4): the exponential tidal flare at a mouth
      // opening into open water — water-hued.
      id: "generated-river-estuary",
      type: "fill",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "river-estuary"],
      paint: { "fill-color": t.fabricRiver, "fill-opacity": 1 },
    } as unknown as LayerSpecification,
    {
      // Oxbow lakes (plan 028 §1.4): abandoned-meander water bodies beside the
      // tightest bends — still water, the same river hue.
      id: "generated-river-oxbow",
      type: "fill",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "river-oxbow"],
      paint: { "fill-color": t.fabricRiver, "fill-opacity": 1 },
    } as unknown as LayerSpecification,
    {
      // River islands: dry land inside a braided reach — land hue, painted
      // ABOVE the channel water (later in the array) so the island reads as a
      // hole of ground in the water.
      id: "generated-river-island",
      type: "fill",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "river-island"],
      paint: { "fill-color": t.land, "fill-opacity": 0.95 },
    } as unknown as LayerSpecification,
    {
      // Point bars (plan 028 §1.4): sandy inner-bend crescents — a warm silt
      // tone (land ↔ cultivated-ochre blend), painted above the channel water
      // like a small beach.
      id: "generated-river-point-bar",
      type: "fill",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "river-point-bar"],
      paint: { "fill-color": mix(t.land, t.fabricFarmland, 0.6), "fill-opacity": 0.95 },
    } as unknown as LayerSpecification,
    {
      // Water-symbol glyphs (plan 028 §1.4): ford / rapids / falls SDF icons at
      // hashed steep/calm candidates. Tinted to a dark river tone; the symbol
      // is rotated across-stream by the generator's `rotation` prop. NO zoom
      // LOD (Jonah 2026-07-12) — icon-allow-overlap so they always render.
      id: "generated-river-glyph",
      type: "symbol",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "river-glyph"],
      layout: {
        "icon-image": riverIconImageExpr(),
        "icon-size": 0.55,
        "icon-rotate": ["get", "rotation"],
        "icon-rotation-alignment": "map",
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      },
      paint: { "icon-color": darken(t.fabricRiver, 0.45) },
    } as unknown as LayerSpecification,
  ];
}
