import type { LayerSpecification } from "maplibre-gl";
import type { ThemeTokens } from "../tokens";

/**
 * Per-feature street-width → px multiplier, reused at every zoom
 * stop of `generated-street`'s `line-width`. It reads the emitted `width`
 * (metres) and normalises to the 12 m ordinary-street reference, FLOORED at 0.7
 * (alleys never blink out sub-pixel) and CAPPED at 6 (an 85 m superblock canyon
 * stays legible without swallowing the frame). A widthless legacy feature
 * (sketch-corridor, roadClass "major") derives its metres from `roadClass` so
 * it flows through the identical ramp. Kept OUTSIDE the zoom `interpolate` (a
 * pure data expression, no `["zoom"]`) — MapLibre silently invalidates the
 * whole style at load if `zoom` is nested under `["*", …]` (map loads blank,
 * no error), so only this multiplier is folded into each interpolate output.
 */
const W_MULT: unknown = [
  "max",
  0.7,
  [
    "min",
    6,
    [
      "/",
      [
        "coalesce",
        ["get", "width"],
        ["match", ["get", "roadClass"], ["major", "arterial"], 18, "ring", 16, ["alley", "court"], 5, 12],
      ],
      12,
    ],
  ],
];

/**
 * City fabric. Split across the emitted array: the district/footprint/parcel/
 * landmark/gate block sits in the middle (above farm/world-region, below the
 * river/forest/park/wall blocks); the street network paints LAST of all
 * generated layers (above everything else in this source) so streets read over
 * the fabric they thread through. generatedLayers.ts keeps the two fragments in
 * their original positions — do not merge them (that would reorder streets and
 * break style byte-identity).
 */
export function cityLayers(t: ThemeTokens): LayerSpecification[] {
  return [
    {
      // Districts are the *persistent* city fabric — large area fills stay
      // legible when thin street lines thin to sub-pixel on zoom-out. Same
      // hue as sketched districts (fabricDistrict); opacity sits below the
      // sketched 0.18 because generated districts tile EVERY cell — a
      // full-coverage wash at sketch opacity slabbed the near-black neon
      // base, while a sketched district is one shape.
      id: "generated-district",
      type: "fill",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "city-district"],
      paint: { "fill-color": t.fabricDistrict, "fill-opacity": 0.09 },
    } as unknown as LayerSpecification,
    {
      // No zoom LOD: footprints render at every zoom like all fabric (see
      // src/model/fabric.ts) — never re-add a minzoom gate. Far-out
      // readability (e.g. an opacity ramp) stays a theme paint decision.
      id: "generated-footprint",
      type: "fill",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "city-footprint"],
      paint: { "fill-color": t.roadMinor, "fill-opacity": 0.3 },
    } as unknown as LayerSpecification,
    {
      // Parcels: hairline lot boundaries. No zoom LOD — parcels render at
      // every zoom (same ruling as generated-footprint above).
      id: "generated-parcel",
      type: "line",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "city-parcel"],
      paint: { "line-color": t.roadMinor, "line-width": 0.5, "line-opacity": 0.35 },
    } as unknown as LayerSpecification,
    {
      // City landmarks: the plaza reads as paved open ground
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
          // cul-de-sac court bulbs (na-suburb) read as pavement
          "court", t.fabricRoad,
          t.roadMinor,
        ],
        "fill-opacity": ["match", ["get", "type"], "plaza", 0.25, "wall", 0.85, "field", 0.12, "court", 0.3, 0.5],
      },
    } as unknown as LayerSpecification,
    {
      // Canal rings (the canal-rings preset): the concentric canals emit as
      // `city-landmark` type=`canal` LINES (the water machinery reads them as
      // rivers internally; here they read as WATER). A fat blue casing ≈ the
      // 30 m canal width — same water hue as a sketched river (F2: provenance
      // invisible per kind), rendered BELOW the streets so the radial bridges
      // read over the canals. No zoom LOD (standing fabric ruling).
      id: "generated-canal",
      type: "line",
      source: "generated",
      filter: [
        "all",
        ["==", ["get", "generatorId"], "city-landmark"],
        ["==", ["get", "type"], "canal"],
        ["==", ["geometry-type"], "LineString"],
      ],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": t.fabricRiver,
        "line-opacity": 0.85,
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 3, 12, 7, 18, 16],
      },
    } as unknown as LayerSpecification,
    {
      // City gates: unnamed fabric points where arterials pierce the
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
  ];
}

export function cityStreetLayers(t: ThemeTokens): LayerSpecification[] {
  return [
    {
      id: "generated-street",
      type: "line",
      source: "generated",
      // sketch-corridor streets are city streets by another generator — same
      // paint, so old cached elaborations read as native.
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
        // GM's drawn arterial stays legible over its branches.
        // Width-driven: every generated street carries an explicit `width`
        // (metres); the theme ramps px from it so a preset's form hierarchy
        // (Manhattan avenues vs streets, a superblock's 85 m arterial CANYONS
        // vs its lanes) reads directly, not just via roadClass. The multiplier
        // = width ÷ 12 m (the ordinary-street reference), FLOORED at 0.7 so
        // alleys never blink out sub-pixel and CAPPED at 6 so an 85 m canyon
        // stays legible without swallowing the frame. Legacy features with no
        // `width` (sketch-corridor, roadClass "major") fall back to a
        // class→width mapping, so their px is unchanged. The zoom `interpolate`
        // MUST stay the top-level expression — MapLibre rejects `zoom` nested
        // inside `["*", …]` and silently invalidates the whole style (map loads
        // blank, no error), so the per-feature width multiplier is folded into
        // each interpolate output.
        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          8, ["*", 1, W_MULT],
          12, ["*", 1.6, W_MULT],
          18, ["*", 3.5, W_MULT],
        ],
      },
    } as unknown as LayerSpecification,
  ];
}
