import type { LayerSpecification } from "maplibre-gl";
import type { ThemeTokens } from "./tokens";

/**
 * Generated fabric, painted with the SAME per-kind fabric tokens (plan 017)
 * as sketched fabric — quality-bar F2 (plan 019 rewrite): a generated road
 * and a sketched road differ in provenance, not legend. The two sources/
 * modules stay separate (generated output is regenerable cache; sketches are
 * durable), but the eye reads one class of thing per kind.
 *
 * No settlement point/label layers anymore: named places are Locations
 * (plan 019, D2) — the world-settlement generator is unwired from
 * generate-here, so nothing emits point features into this source.
 */
export function generatedLayers(t: ThemeTokens): LayerSpecification[] {
  return [
    {
      id: "generated-region",
      type: "fill",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "world-region"],
      paint: {
        "fill-color": [
          "match",
          ["get", "biome"],
          // Water biomes use the fabric water token so a generated ocean and
          // a sketched lake read as the same water (F2).
          "ocean", t.fabricWater,
          "coast", t.fabricWater,
          // all land biomes fall through to land — ocean vs. land is the
          // whole win here (it produces the coastline); per-biome hues are
          // a follow-up (see maintenance notes in plans/002).
          t.land,
        ],
        "fill-opacity": 0.9,
      },
    } as unknown as LayerSpecification,
    {
      // Districts are the *persistent* city fabric — large area fills stay
      // legible when thin street lines thin to sub-pixel on zoom-out. Same
      // hue as sketched districts (fabricDistrict); opacity sits below the
      // sketched 0.18 because generated districts tile EVERY cell — a
      // full-coverage wash at sketch opacity slabbed the near-black neon
      // base (see plan 017 notes), while a sketched district is one shape.
      id: "generated-district",
      type: "fill",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "city-district"],
      paint: { "fill-color": t.fabricDistrict, "fill-opacity": 0.09 },
    } as unknown as LayerSpecification,
    {
      // NO zoom LOD (Jonah 2026-07-12): generated building detail follows the
      // same standing Kanto-test ruling as all fabric — "LOD should only
      // impact visibility of location names; fabric always visible" (see
      // src/model/fabric.ts). The former minzoom:14 made footprints pop in/out
      // across zooms; they now render at every zoom like every other fabric
      // layer. (Paint-level treatment — e.g. an opacity ramp for far-out
      // readability — stays a theme decision, deliberately not re-added here.)
      id: "generated-footprint",
      type: "fill",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "city-footprint"],
      paint: { "fill-color": t.roadMinor, "fill-opacity": 0.3 },
    } as unknown as LayerSpecification,
    {
      // Procgen v3.2 parcels: hairline lot boundaries. NO zoom LOD (Jonah
      // 2026-07-12, same ruling as generated-footprint above) — parcels
      // render at every zoom now instead of the former minzoom:15.
      id: "generated-parcel",
      type: "line",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "city-parcel"],
      paint: { "line-color": t.roadMinor, "line-width": 0.5, "line-opacity": 0.35 },
    } as unknown as LayerSpecification,
    {
      // Procgen v3 city landmarks: the plaza reads as paved open ground
      // (road hue, light wash); church/market footprints read like heavier
      // buildings (denser than the ambient footprint fill); walls share the
      // sketched-wall stone hue (F2: one legend per kind); farm fields get a
      // faint cultivated-green wash (park hue, well below park opacity).
      id: "generated-landmark",
      type: "fill",
      source: "generated",
      filter: [
        "all",
        ["==", ["get", "generatorId"], "city-landmark"],
        ["==", ["geometry-type"], "Polygon"],
      ],
      paint: {
        "fill-color": [
          "match",
          ["get", "type"],
          "plaza", t.fabricRoad,
          "wall", t.fabricWall,
          "field", t.fabricPark,
          // cul-de-sac court bulbs (na-suburb, v3.4) read as pavement
          "court", t.fabricRoad,
          t.roadMinor,
        ],
        "fill-opacity": ["match", ["get", "type"], "plaza", 0.25, "wall", 0.85, "field", 0.12, "court", 0.3, 0.5],
      },
    } as unknown as LayerSpecification,
    {
      // City gates (v3.3): unnamed fabric points where arterials pierce the
      // wall — small stone-hued dots, never Location pins (I4).
      id: "generated-gate",
      type: "circle",
      source: "generated",
      filter: [
        "all",
        ["==", ["get", "generatorId"], "city-landmark"],
        ["==", ["get", "type"], "gate"],
        ["==", ["geometry-type"], "Point"],
      ],
      paint: { "circle-radius": 3, "circle-color": t.fabricWall, "circle-opacity": 0.9 },
    } as unknown as LayerSpecification,
    {
      // World routes are roads by another tier — fabric road hue, dashed to
      // read as an overland route rather than a street.
      id: "generated-route",
      type: "line",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "world-route"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": t.fabricRoad, "line-width": 1.5, "line-dasharray": [2, 2] },
    } as unknown as LayerSpecification,
    {
      id: "generated-street",
      type: "line",
      source: "generated",
      // sketch-corridor (plan 014) streets are city streets by another
      // generator — same paint, so old cached elaborations read as native.
      filter: ["match", ["get", "generatorId"], ["city-street", "sketch-corridor"], true, false],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        // Same hue as sketched roads (F2: provenance invisible per kind).
        "line-color": t.fabricRoad,
        // Width FLOOR of ~1px: streets used to interpolate down to 0.5px at
        // z10 (thinner still below), going sub-pixel and vanishing on a dark
        // base as you zoomed out. Never let a street render narrower than it
        // takes to be seen — it thickens with zoom for detail, but the low end
        // holds a visible minimum so the road network doesn't blink out.
        // Corridor avenues (roadClass "major") render a step wider so the
        // GM's drawn arterial stays legible over its branches. NOTE: the
        // zoom `interpolate` MUST be the top-level expression — MapLibre
        // rejects `zoom` nested inside another expression (e.g. `["*", …,
        // interpolate(zoom)]`) and that silently invalidates the whole style
        // (map loads blank, no error — 006-class). So the per-feature avenue
        // multiplier is folded into each interpolate output instead.
        // Procgen v3 (§6): roadClass → width is the theme's job. Arterials
        // read a step over ring roads, which read over plain streets;
        // alleys/courts sit under streets. Legacy "major" (corridor
        // avenues) keeps its arterial-equivalent width.
        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          8, ["*", 1, ["match", ["get", "roadClass"], ["major", "arterial"], 1.8, "ring", 1.5, ["alley", "court"], 0.7, 1]],
          12, ["*", 1.6, ["match", ["get", "roadClass"], ["major", "arterial"], 1.8, "ring", 1.5, ["alley", "court"], 0.7, 1]],
          18, ["*", 3.5, ["match", ["get", "roadClass"], ["major", "arterial"], 1.8, "ring", 1.5, ["alley", "court"], 0.7, 1]],
        ],
      },
    } as unknown as LayerSpecification,
  ];
}
