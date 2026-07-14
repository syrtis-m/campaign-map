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
    // ── Farmland (plan 022 §4.9, plan 022 §3.5) ──────────────────────────────
    // Farmland is stage 2 (agriculture) and the city is stage 3, so the whole
    // farm stack sits EARLY in this array — BELOW the district/footprint/street
    // layers — so a city sketched over/beside farmland reads with the city on
    // top (advisor 2026-07-13; deliberately NOT forest's mid-array slot, which
    // paints canopy above city footprints). NO zoom LOD (Jonah 2026-07-12).
    {
      // Tilled fields — the warm cultivated `fabricFarmland` wash (F2: one
      // legend per kind; a generated field and a sketched farmland read as the
      // same class of thing). Plain token; `crop` is carried on each feature for
      // future theme texture but never branched here (keeps the paint a plain
      // token so the coverage guard's fillColor() stays valid).
      id: "generated-farm-field",
      type: "fill",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "farm-field"],
      paint: { "fill-color": t.fabricFarmland, "fill-opacity": 0.7 },
    } as unknown as LayerSpecification,
    {
      // Farm lanes / section roads — the fabric road hue (F2), a thin dirt
      // track, ABOVE the field fill so the lanes read over the crops.
      id: "generated-farm-lane",
      type: "line",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "farm-lane"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": t.fabricRoad,
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.8, 16, 2.5],
        "line-opacity": 0.85,
      },
    } as unknown as LayerSpecification,
    {
      // Field-edge hedges/fences — hedgerows read as the deeper woodland green,
      // fences as the stone/timber `fabricWall` hue (branch on the `hedging`
      // property carried by every hedge feature). Above the field, below the
      // buildings/trees.
      id: "generated-farm-hedge",
      type: "line",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "farm-hedge"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["match", ["get", "hedging"], "fences", t.fabricWall, t.fabricForest],
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.6, 16, 1.8],
        "line-opacity": 0.8,
      },
    } as unknown as LayerSpecification,
    {
      // Farmstead footprints — heavier buildings in the roadMinor hue, like the
      // city footprints (F2: a building reads as a building), ABOVE the fields.
      id: "generated-farm-building",
      type: "fill",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "farm-building"],
      paint: { "fill-color": t.roadMinor, "fill-opacity": 0.7 },
    } as unknown as LayerSpecification,
    {
      // Orchard trees — regular tree rows, small stipple circles in the deeper
      // canopy green (F2: reads as the same greenery as forest/park trees),
      // ABOVE the fields so the rows keep a legible texture.
      id: "generated-orchard-tree",
      type: "circle",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "orchard-tree"],
      paint: { "circle-radius": 1.5, "circle-color": t.fabricForest, "circle-opacity": 0.95 },
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
      // Procgen v4.5 river (plan 022 §3.1): the generated channel is water —
      // same hue as a sketched river/water (F2: one legend per kind). Islands
      // paint AFTER (below in this array = under? no: later = on top), so the
      // island layer follows this one. NO zoom LOD (Jonah 2026-07-12).
      id: "generated-river-channel",
      type: "fill",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "river-channel"],
      paint: { "fill-color": t.fabricRiver, "fill-opacity": 0.85 },
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
      // Procgen v4.6 forest canopy (plan 022 §3.2): woodland fill in the
      // deeper `fabricForest` green (F2: one legend per kind — a generated
      // forest and a sketched forest read as the same class of thing). NO zoom
      // LOD (Jonah 2026-07-12). Canopy paints FIRST so clearings + trees layer
      // above it. Forest is stage 2 (below city, which is stage 3): its layer
      // id sorts before the district/street/footprint layers in this array, so
      // a town in the woods reads as a clearing without the forest ever seeing
      // the city (plan 022 §3.2 one-direction rule).
      id: "generated-forest-canopy",
      type: "fill",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "forest-canopy"],
      paint: { "fill-color": t.fabricForest, "fill-opacity": 0.8 },
    } as unknown as LayerSpecification,
    {
      // Forest clearings: open ground punched into the canopy — land hue,
      // painted ABOVE the canopy so the glade reads as a hole of ground.
      id: "generated-forest-clearing",
      type: "fill",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "forest-clearing"],
      paint: { "fill-color": t.land, "fill-opacity": 0.85 },
    } as unknown as LayerSpecification,
    {
      // Individual trees: small stipple circles in a darker shade of the
      // canopy, painted ABOVE canopy + clearings so the forest keeps a legible
      // texture even where the canopy fill thins near the ragged edge.
      id: "generated-forest-tree",
      type: "circle",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "forest-tree"],
      paint: { "circle-radius": 1.6, "circle-color": t.fabricForest, "circle-opacity": 0.95 },
    } as unknown as LayerSpecification,
    {
      // Procgen v4.7 park (plan 022 §3.3): the ground fabric — a manicured lawn
      // in the per-theme `fabricPark` green (F2: a generated park and a sketched
      // park read as the same class of thing). NO zoom LOD (Jonah 2026-07-12).
      // The ground paints FIRST so every other park element layers above it.
      id: "generated-park-lawn",
      type: "fill",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "park-lawn"],
      paint: { "fill-color": t.fabricPark, "fill-opacity": 0.55 },
    } as unknown as LayerSpecification,
    {
      // Planting beds: denser cultivation than the lawn — the deeper woodland
      // green (fabricForest) reads as shrub/flower beds. Above the lawn.
      id: "generated-park-bed",
      type: "fill",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "park-bed"],
      paint: { "fill-color": t.fabricForest, "fill-opacity": 0.7 },
    } as unknown as LayerSpecification,
    {
      // Karesansui raked-gravel court (japanese-garden): pale stony ground in
      // the sandstone `fabricWall` hue, a low wash so the rocks read on top.
      id: "generated-park-court",
      type: "fill",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "park-court"],
      paint: { "fill-color": t.fabricWall, "fill-opacity": 0.4 },
    } as unknown as LayerSpecification,
    {
      // Garden paths: same hue as sketched roads (F2). Above the ground fills,
      // below the water so a bridge (not the path) carries a pond crossing.
      id: "generated-park-path",
      type: "fill",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "park-path"],
      paint: { "fill-color": t.fabricRoad, "fill-opacity": 0.85 },
    } as unknown as LayerSpecification,
    {
      // Pond: the composition anchor — water hue (F2: reads as the same water
      // as a sketched pond). Above the ground + paths so it reads as a pool.
      id: "generated-park-pond",
      type: "fill",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "park-pond"],
      paint: { "fill-color": t.fabricWater, "fill-opacity": 0.9 },
    } as unknown as LayerSpecification,
    {
      // Pond island: dry land in the pond — land hue, ABOVE the pond water so it
      // reads as a hole of ground (same idiom as a river island).
      id: "generated-park-island",
      type: "fill",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "park-island"],
      paint: { "fill-color": t.land, "fill-opacity": 0.95 },
    } as unknown as LayerSpecification,
    {
      // Bridges: short decks where the path crosses to the island — the stone
      // `fabricWall` hue, ABOVE the pond + island so the span reads over water.
      id: "generated-park-bridge",
      type: "fill",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "park-bridge"],
      paint: { "fill-color": t.fabricWall, "fill-opacity": 0.95 },
    } as unknown as LayerSpecification,
    {
      // Rock groupings (japanese-garden): solid stones — the stone hue at full
      // opacity, ABOVE the gravel court so a karesansui reads rocks-on-gravel.
      id: "generated-park-rock",
      type: "circle",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "park-rock"],
      paint: { "circle-radius": 2.2, "circle-color": t.fabricWall, "circle-opacity": 0.95 },
    } as unknown as LayerSpecification,
    {
      // Park trees: specimen/scatter trees in the deeper canopy green, painted
      // ABOVE everything so the greenery keeps a legible stipple.
      id: "generated-park-tree",
      type: "circle",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "park-tree"],
      paint: { "circle-radius": 1.8, "circle-color": t.fabricForest, "circle-opacity": 0.95 },
    } as unknown as LayerSpecification,
    {
      // Procgen v4.8 wall (plan 022 §3.4): the outboard MOAT — water hue (F2:
      // reads as the same water as a sketched river/pond). Painted FIRST of the
      // wall stack so the masonry band + towers sit above it. NO zoom LOD.
      id: "generated-wall-moat",
      type: "fill",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "wall-moat"],
      paint: { "fill-color": t.fabricWater, "fill-opacity": 0.8 },
    } as unknown as LayerSpecification,
    {
      // The masonry band — the sketched-wall stone hue (F2: a generated wall
      // and a sketched/city wall read as the same class of thing). Above the
      // moat, below the towers. Palisades share the hue; the theme could tint
      // per `wallStyle` later (the property is carried on every feature).
      id: "generated-wall-quad",
      type: "fill",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "wall-quad"],
      paint: { "fill-color": t.fabricWall, "fill-opacity": 0.85 },
    } as unknown as LayerSpecification,
    {
      // Towers / bastions: solid stone at full opacity, ABOVE the band so a
      // curtain wall reads as wall-plus-towers and a bastioned trace reads as
      // angular star-fort points.
      id: "generated-wall-tower",
      type: "fill",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "wall-tower"],
      paint: { "fill-color": t.fabricWall, "fill-opacity": 1 },
    } as unknown as LayerSpecification,
    {
      // Gates: unnamed stone dots where a sketched road pierces the wall — small
      // circles, never Location pins (I4). Same idiom as the city gate points.
      id: "generated-wall-gate",
      type: "circle",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "wall-gate"],
      paint: { "circle-radius": 3, "circle-color": t.fabricWall, "circle-opacity": 0.95 },
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
