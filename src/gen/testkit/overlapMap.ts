/**
 * Overlap test map — the shared fixture surface for the pipeline arc (plans
 * 031–039). One deterministic geometry source, two artifacts: headless Vitest
 * fixtures (imported directly) and the `dev-vault/Campaigns/Overlap` campaign
 * (emitted by `scripts/emit-overlap-campaign.ts` — regenerate with
 * `npx tsx scripts/emit-overlap-campaign.ts`).
 *
 * Every builder is pure and returns the SAME bytes on every call: literal
 * coordinates, literal ids, seeds derived once from
 * `hashSeed(OVERLAP_CAMPAIGN_SEED, featureId)` (the locked "region seed =
 * hashSeed(campaignSeed, featureId)" convention — the persisted artifact
 * carries the resulting literal), versions read from each algorithm's
 * `currentVersion` so the fixture never silently pins stale contracts.
 *
 * Scenario → plan traceability (coupling matrix,
 * plans/research-generation-pipeline.md §2):
 *   S1 river-crosses-district      river spine enters/exits the main district
 *                                  (channel adaptation + bridges — shipped edge,
 *                                  regression surface for 031/034)
 *   S2 wall-around-city            closed wall polyline tracing the district
 *                                  ring (gates vs generated arterials — plan 037)
 *   S3 forest-overlaps-river       forest polygon over an upstream river reach
 *                                  (channel exclusion + riparian — plan 037)
 *   S4 farmland-adjacent           farmland shares the district's east edge AND
 *                                  overlaps the river downstream (peri-urban
 *                                  move + long-lots — plans 035/038)
 *   S5 park-in-district            park strictly nested inside the district
 *                                  (hole-with-frontage — 037; urban split — 035)
 *   S6 adjacent-districts          second district sharing the south edge
 *                                  exactly (hashed shared-edge stubs — plan 038)
 *   S7 mountain-near-river-farmland  mountain NEAR the river (never coupled)
 *                                  overlapping upland farmland (terrain→farmland
 *                                  yes / terrain→river no — 035/036 litmus)
 *   S8 canon pins                  typed `market` pin inside the district +
 *                                  untyped boundary pins (plan 039)
 *
 * Pure module: zod-shaped model types + the registry only — no DOM, no map, no
 * Obsidian (testkit is headless).
 */
import type { FabricCollection, FabricFeature, FabricKind, ProcgenBlock } from "../../model/fabric";
import { algorithmById } from "../procgen/registry";
import { hashSeed } from "../rng";

type Pt = [number, number];

/** Campaign seed — mirrored in `Overlap.map.md` frontmatter. */
export const OVERLAP_CAMPAIGN_SEED = 7341;
/** Fictional bounded box, map units (same convention as Kanto/Ashfall). */
export const OVERLAP_BOUNDS: readonly [number, number, number, number] = [-12, -12, 12, 12];
/** 1 map unit = 100 m ⇒ the world is 2.4 × 2.4 km. */
export const OVERLAP_SCALE_M_PER_UNIT = 100;
/** Campaign id notes reference in `map:` frontmatter. */
export const OVERLAP_MAP_ID = "overlap";

/** Close an open ring (append the first vertex) — polygon builders share it so
 * every emitted ring is closed by construction. */
function closed(open: Pt[]): Pt[] {
  return [...open.map((p): Pt => [p[0], p[1]]), [open[0][0], open[0][1]]];
}

/** Build the procgen block for `featureId`: seed from the locked
 * hashSeed(campaignSeed, featureId) convention, version pinned to the
 * algorithm's CURRENT contract, params validated by the algorithm's own zod
 * schema so a drifted registry fails the build loudly, never emits a stale
 * fixture. */
function procgenBlock(
  algorithmId: string,
  featureId: string,
  params: Record<string, unknown>,
  presetId?: string
): ProcgenBlock {
  const alg = algorithmById(algorithmId);
  if (!alg) throw new Error(`overlapMap: unknown algorithm "${algorithmId}"`);
  const parsed = alg.paramsSchema.parse(params);
  return {
    algorithm: algorithmId,
    seed: hashSeed(OVERLAP_CAMPAIGN_SEED, featureId),
    version: alg.currentVersion,
    params: parsed,
    ...(presetId !== undefined ? { presetId } : {}),
  };
}

function polygonFeature(
  id: string,
  kind: FabricKind,
  openRing: Pt[],
  opts: { name?: string; procgen?: ProcgenBlock } = {}
): FabricFeature {
  return {
    type: "Feature",
    id,
    geometry: { type: "Polygon", coordinates: [closed(openRing)] },
    properties: {
      kind,
      ...(opts.name !== undefined ? { name: opts.name } : {}),
      ...(opts.procgen !== undefined ? { procgen: opts.procgen } : {}),
    },
  };
}

function lineFeature(
  id: string,
  kind: FabricKind,
  coordinates: Pt[],
  opts: { name?: string; procgen?: ProcgenBlock } = {}
): FabricFeature {
  return {
    type: "Feature",
    id,
    geometry: { type: "LineString", coordinates: coordinates.map((p): Pt => [p[0], p[1]]) },
    properties: {
      kind,
      ...(opts.name !== undefined ? { name: opts.name } : {}),
      ...(opts.procgen !== undefined ? { procgen: opts.procgen } : {}),
    },
  };
}

// ─── Shared geometry anchors ─────────────────────────────────────────────────
// The main district's ring is the load-bearing shape: the wall traces it (S2),
// the annex district shares its SOUTH edge (S6), the east farmland shares its
// EAST edge (S4), the park nests inside it (S5), the river crosses it (S1).

/** Main district open ring, CCW. East edge (3,-2.5)→(3,2.5) is the straight
 * 500 m edge farmland shares; south edge (-3,-2.5)→(3,-2.5) is the 600 m edge
 * the annex district shares. ~600 × 550 m. */
export const MAIN_DISTRICT_RING: readonly Pt[] = [
  [-3, -2.5],
  [3, -2.5],
  [3, 2.5],
  [-0.5, 3.2],
  [-3.6, 1.0],
];

/** River spine, upstream (NW) → downstream (SE). Crosses the forest (S3), then
 * the main district (S1, entering the NW edge and exiting the east edge), then
 * the east farmland (S4 downstream overlap). Passes NEAR the mountain without
 * ever touching it (S7 litmus: terrain never reaches hydrology). */
export const RIVER_SPINE: readonly Pt[] = [
  [-6.5, 7.5],
  [-5.2, 5.6],
  [-4.2, 4.4],
  [-3.2, 3.4],
  [-1.8, 2.0],
  [0.2, 1.4],
  [1.6, 0.2],
  [4.0, -2.2],
  [5.5, -3.4],
  [7.0, -4.5],
  [8.5, -6.2],
];

/** Forest open ring — sits over the river's upstream reach (spine vertices
 * (-5.2,5.6) and (-4.2,4.4) are strictly inside); disjoint from the district,
 * the mountain, and the upland farmland. */
export const FOREST_RING: readonly Pt[] = [
  [-5.6, 3.4],
  [-2.6, 3.6],
  [-2.3, 6.6],
  [-4.6, 7.3],
  [-5.9, 5.8],
];

/** East farmland open ring, CCW. Its west edge (3,2.5)→(3,-2.5) IS the main
 * district's east edge (identical endpoints — the S4 long shared edge); the
 * river's downstream spine crosses its interior. */
export const FARMLAND_EAST_RING: readonly Pt[] = [
  [3, -2.5],
  [6.5, -5.5],
  [8, -3.5],
  [7.5, 0.5],
  [3, 2.5],
];

/** Park open ring — strictly inside the main district (≥ ~40 m margin), clear
 * of the river's in-district reach (S5 nested hole-with-frontage). ~82,000 m². */
export const PARK_RING: readonly Pt[] = [
  [-2.7, -1.7],
  [0.4, -1.9],
  [0.7, 0.7],
  [-2.4, 1.1],
];

/** Annex district open ring, CCW. Its north edge (3,-2.5)→(-3,-2.5) IS the main
 * district's south edge reversed (identical endpoints — S6 shared-edge stubs). */
export const ANNEX_DISTRICT_RING: readonly Pt[] = [
  [-3, -6.0],
  [2.4, -6.2],
  [3, -2.5],
  [-3, -2.5],
];

/** Mountain open ring — ~110 m from the river's upstream spine at its nearest
 * (near, NEVER overlapping — S7), overlapping the upland farmland's north end. */
export const MOUNTAIN_RING: readonly Pt[] = [
  [-11, 4.0],
  [-8, 4.4],
  [-7.6, 7.8],
  [-10.6, 8.4],
];

/** Upland farmland open ring — its north end sits inside the mountain ring
 * (S7 terrain→farmland coupling); disjoint from river and forest. */
export const FARMLAND_UPLAND_RING: readonly Pt[] = [
  [-9.5, 1.5],
  [-6.4, 1.8],
  [-6.2, 5.2],
  [-9.2, 5.6],
];

// ─── Scenario builders ──────────────────────────────────────────────────────

/** S1/S2/S4/S5/S6 anchor: the main district, city procgen (euro-medieval). */
export function buildMainDistrict(): FabricFeature {
  const id = "overlap-district-main";
  return polygonFeature(id, "district", [...MAIN_DISTRICT_RING], {
    name: "Coppersquare",
    procgen: procgenBlock("city", id, { profile: "euro-medieval" }, "euro-medieval"),
  });
}

/** S1/S3/S4/S7: the river, lazy-lowland preset (wide enough that the channel —
 * not just the spine — visibly interacts with every region it crosses). */
export function buildRiver(): FabricFeature {
  const id = "overlap-river";
  return lineFeature(id, "river", [...RIVER_SPINE], {
    name: "The Threadwater",
    procgen: procgenBlock(
      "river",
      id,
      { windiness: 0.85, braiding: 0.5, width: 26, widthGrowth: 0.7, braidBias: 0.2, slopeSensitivity: 1 },
      "lazy-lowland"
    ),
  });
}

/** S2: closed wall polyline tracing the main district ring exactly. On-boundary
 * (not offset) is deliberate: the district's east/south edges are shared with
 * farmland/annex (S4/S6), so any outward offset would cut those regions; a
 * curtain wall ON the ring is also exactly where generated arterials exit —
 * the plan-037 gate-vs-arterial surface. Moat off for the same reason. */
export function buildCityWall(): FabricFeature {
  const id = "overlap-wall";
  return lineFeature(id, "wall", closed([...MAIN_DISTRICT_RING]), {
    name: "Coppersquare Wall",
    procgen: procgenBlock(
      "wall",
      id,
      { style: "curtain-wall", towerSpacing: 60, moat: false, gatehouseScale: 1 },
      "curtain-wall"
    ),
  });
}

/** S3: forest over the river's upstream reach (channel exclusion + riparian). */
export function buildForest(): FabricFeature {
  const id = "overlap-forest";
  return polygonFeature(id, "forest", [...FOREST_RING], {
    name: "Fernside Wood",
    procgen: procgenBlock(
      "forest",
      id,
      { variety: "broadleaf", density: 0.7, clearings: 0.12, edgeRaggedness: 0.45 },
      "broadleaf"
    ),
  });
}

/** S4: peri-urban farmland sharing the district's east edge, river downstream
 * through its interior (long-lots — plan 038; peri-urban move — plan 035). */
export function buildFarmlandEast(): FabricFeature {
  const id = "overlap-farmland-east";
  return polygonFeature(id, "farmland", [...FARMLAND_EAST_RING], {
    name: "Quayside Fields",
    procgen: procgenBlock(
      "farmland",
      id,
      { fieldType: "enclosed-patchwork", fieldSize: 0.5, hedging: "hedgerows", laneDensity: 0.4, farmsteads: 0.45 },
      "enclosed-patchwork"
    ),
  });
}

/** S5: park strictly nested inside the main district (urban-park split — plan
 * 035; nested hole-with-frontage — plan 037). */
export function buildParkInner(): FabricFeature {
  const id = "overlap-park";
  return polygonFeature(id, "park", [...PARK_RING], {
    name: "Wardmoot Green",
    procgen: procgenBlock("park", id, { variety: "city-park", pathDensity: 0.5, pond: true }, "city-park"),
  });
}

/** S6: annex district sharing the main district's south edge exactly (ε = 0 —
 * the strongest form of "within ε"; hashed shared-edge stubs hash identical
 * durable geometry — plan 038). Different profile so stub agreement is tested
 * across dissimilar street fields. */
export function buildAnnexDistrict(): FabricFeature {
  const id = "overlap-district-annex";
  return polygonFeature(id, "district", [...ANNEX_DISTRICT_RING], {
    name: "Newquarter",
    procgen: procgenBlock("city", id, { profile: "euro-continental" }, "euro-continental"),
  });
}

/** S7: mountain near (never overlapping) the river, overlapping the upland
 * farmland — the plans-035/036 litmus pair. */
export function buildMountain(): FabricFeature {
  const id = "overlap-mountain";
  return polygonFeature(id, "mountain", [...MOUNTAIN_RING], {
    name: "The Greywatch",
    procgen: procgenBlock("mountain", id, { terrain: "alpine", amplitude: 0.85, roughness: 0.6 }, "alpine"),
  });
}

/** S7: upland farmland under the mountain's south slope — paddy-terraces, the
 * terrain-coupled preset (contour-following banks read the elevation field). */
export function buildFarmlandUpland(): FabricFeature {
  const id = "overlap-farmland-upland";
  return polygonFeature(id, "farmland", [...FARMLAND_UPLAND_RING], {
    name: "Greywatch Terraces",
    procgen: procgenBlock(
      "farmland",
      id,
      { fieldType: "paddy-terraces", fieldSize: 0.35, hedging: "none", laneDensity: 0.4, farmsteads: 0.25 },
      "paddy-terraces"
    ),
  });
}

/** The full Overlap fabric, stable order (order is part of the fixture's
 * byte-identity contract — never reorder without re-emitting the campaign). */
export function buildOverlapCampaignFabric(): FabricCollection {
  return {
    type: "FeatureCollection",
    features: [
      buildMainDistrict(),
      buildAnnexDistrict(),
      buildRiver(),
      buildCityWall(),
      buildForest(),
      buildFarmlandEast(),
      buildParkInner(),
      buildMountain(),
      buildFarmlandUpland(),
    ],
  };
}

// ─── S8: canon pins ─────────────────────────────────────────────────────────

export interface OverlapPin {
  /** Note basename (becomes `Locations/<name>.md`). */
  name: string;
  /** `type:` frontmatter — omitted for the untyped boundary pins. */
  type?: string;
  /** `visibility:` frontmatter — omitted where the default should apply. */
  visibility?: "wide" | "mid" | "close";
  /** Map-unit point (`geometry:` frontmatter). */
  point: Pt;
  /** Note body. */
  body: string;
}

/** S8 canon pins: one typed `market` pin strictly inside the main district
 * (plan 039 typed-attractor litmus), one typed district anchor for the annex,
 * and three untyped pins sitting on/near coupling boundaries. */
export const OVERLAP_PINS: readonly OverlapPin[] = [
  {
    name: "Coppersquare Market",
    type: "market",
    visibility: "mid",
    point: [1.6, -1.2],
    body: "The market square of Coppersquare — plan 039's typed `market` pin, strictly inside the main district and clear of park and river.",
  },
  {
    name: "Newquarter",
    type: "district",
    visibility: "wide",
    point: [-0.3, -4.3],
    body: "The annex quarter south of the walls (S6 anchor).",
  },
  {
    name: "Old Quay",
    point: [3.05, -1.25],
    body: "Untyped pin at the district/farmland shared east edge, beside the river's exit crossing (S1/S4 boundary).",
  },
  {
    name: "Southgate Shrine",
    point: [0.2, -2.45],
    body: "Untyped pin hugging the shared district/annex south edge and the wall line (S2/S6 boundary).",
  },
  {
    name: "Fernside Stone",
    point: [-4.6, 5.1],
    body: "Untyped pin inside the forest near the river's upstream reach (S3 overlap).",
  },
];
