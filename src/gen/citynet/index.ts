/**
 * City-network entry point: `generateCityNetwork` computes the whole city
 * network for a ProcgenRegion — Stage-A skeleton plus the Stage-B grown
 * street web plus Stage-C blocks/parcels/footprints, wards, and outskirts —
 * as a pure function of `(citySeed, region, profile, constraints)`, and
 * `clipNetworkToTile` cuts that one artifact into the per-tile,
 * per-generatorId buckets the cache stores and the map paints.
 *
 * Containment contract: EVERY emitted coordinate lies inside (or exactly on)
 * the region polygon — the sketch is the outer limit of all output. Streets
 * and quays are clipped to the region upstream (skeleton/growth); the small
 * decorative rings built here from a center point (plaza, landmarks, court
 * bulbs, wall-band quads) are containment-GUARDED at emission instead:
 * a ring with any vertex outside the region is skipped whole (deterministic,
 * counted implicitly by absence — never thrown).
 *
 * Determinism/seam argument: the network is computed once, not per tile, so
 * two tiles never need order-free math to agree — they clip the *same bytes*.
 * D5 is enforced here: every emitted coordinate is quantized to the
 * millimeter, and every feature list (whole network and every clip bucket)
 * is canonically sorted by first coordinate then id — the id tiebreak is
 * load-bearing because all arterials share the center first coordinate.
 * Clipping reuses `clip.ts` (Liang-Barsky / Sutherland-Hodgman): a segment
 * crossing a shared tile edge gets a bit-identical boundary point from both
 * neighbors, so the 2×2 seam gate passes.
 */
import { CITY_STYLE_CONTRACT, contractGids } from "../procgen/styleContract";
import { hashSeed, mulberry32 } from "../rng";
import type { BBox } from "../spatialHash";
import { clipPolylineToBBox, clipPolygonToBBox, type Vec2 } from "../clip";
import type { GenerationConstraints } from "../types";
import { blockedByWater, blockedByHole, indexConstraints, type FabricConstraintIndex } from "../fabricConstraints";
import { sdfPolygon, type Field } from "../fields/sdf";
import { splitLineOutsideChannel } from "../upstream";
import { generationCenter, regionContains, type ProcgenRegion } from "../region";
import type { FabricFeature } from "../../model/fabric";
import { PROFILES, type AxialConfig, type CityProfile } from "./profiles";
import type { ProfileId } from "./domain";
import { makeCostField } from "./costField";
import { buildSkeleton } from "./skeleton";
import { growNetwork, collectGrownChains, collectCourtTips, COURT_RADIUS_M } from "./growth";
import { driveBoulevards } from "./axial";
import { driveRingRoads, concentricCanalRuns } from "./rings";
import { extractBlocks, chamferRing } from "./faces";
import { subdivideBlocks } from "./parcels";
import { buildWards } from "./wards";
import { buildOutskirts } from "./outskirts";
import { makeCityness, attenuateCitynessByCanopy } from "./cityness";
import { inBankSetback } from "./bankTangent";
import { sharedEdgeStubs } from "./adjacentDistricts";
import { buildUpstreamVegetationField } from "../upstream";

// Package barrel: the host (MapView, generationService, worker, modal) imports
// domain + profile helpers and types from `../citynet` directly.
export * from "./domain";
export * from "./profiles";

type Pt = [number, number];

/**
 * Per-tile generator ids the region network clips into:
 * streets (arterials/bridges/waterfront/grown), blocks (faces), parcels,
 * footprints, landmarks (plaza/church/market), and wards (`city-district` —
 * deliberately the legacy Voronoi district id so wards inherit its paint
 * layer). Derived from the style contract so a bucket cannot be emitted without
 * a paint binding, nor bound without a cache key.
 */
export const DOMAIN_TILE_GENERATOR_IDS: readonly string[] = contractGids(CITY_STYLE_CONTRACT);

/** Canopy depth (m) past which a parcel/footprint centroid is "deep in the
 * wood" and rejected (plan 037, vegetation → city). Beyond the attenuation
 * band so only genuinely enclosed lots drop — the town keeps its wooded fringe. */
export const CANOPY_DENSE_M = 30;

/** Form-based street width: the metre width emitted on a
 * `city-street` feature for its `roadClass`, read straight off the profile's
 * width table. Unknown classes fall back to `street` (the ordinary width).
 * Emitted as an explicit `width` property so themes ramp px from it and the
 * metrics measure it directly instead of re-deriving from the class. */
function widthFor(profile: CityProfile, roadClass: string): number {
  const w = profile.streetWidths;
  switch (roadClass) {
    case "arterial":
      return w.arterial;
    case "ring":
      return w.ring;
    case "alley":
      return w.alley;
    case "boulevard":
      return w.boulevard;
    default:
      return w.street;
  }
}

/** D5 coordinate quantization: millimeter lattice. */
function q(v: number): number {
  return Math.round(v * 1000) / 1000;
}
function qLine(coords: Pt[]): Pt[] {
  return coords.map(([x, y]) => [q(x), q(y)]);
}

/** The generation center canal rings anchor to — MIRRORS `skeleton.ts`'s
 * `resolveGenerationCenter`: a contained `centerOverride` wins (mm-quantized),
 * else the computed `generationCenter`. Kept here so canals (built before the
 * skeleton) share the skeleton's exact center. */
function resolveCenter(region: ProcgenRegion, override?: [number, number]): Pt {
  if (override) {
    const c: Pt = [q(override[0]), q(override[1])];
    if (regionContains(region, c[0], c[1])) return c;
  }
  return generationCenter(region);
}

/** The `type:` frontmatter value that marks a Location pin as a market square
 * (plan 039 §1.1). A pin of this type inside the district anchors the plaza. */
export const MARKET_PIN_TYPE = "market";

/**
 * The generation center a typed `market` canon pin implies (plan 039 §1.1), or
 * `undefined` when there is none. Considers only `Point` canon features of
 * `type: market` strictly inside the region; when several qualify, the one
 * NEAREST the computed `generationCenter` wins (closed-form distance, tie-broken
 * by mm-quantized x then y — no seed, no order dependence). The returned point
 * is the pin's own mm-quantized position, so the plaza snaps exactly onto the
 * GM's square. Untyped pins never qualify ⇒ absent ⇒ byte-identical to v2.
 */
function marketPinCenter(region: ProcgenRegion, canonFeatures?: GeoJSON.Feature[]): Pt | undefined {
  if (!canonFeatures || canonFeatures.length === 0) return undefined;
  const auto = generationCenter(region);
  let best: Pt | null = null;
  let bestD = Infinity;
  for (const f of canonFeatures) {
    if (f.geometry.type !== "Point") continue;
    const type = String((f.properties as Record<string, unknown> | null)?.type ?? "");
    if (type !== MARKET_PIN_TYPE) continue;
    const [rx, ry] = f.geometry.coordinates as Pt;
    if (!regionContains(region, rx, ry)) continue;
    const c: Pt = [q(rx), q(ry)];
    const d = Math.hypot(c[0] - auto[0], c[1] - auto[1]);
    if (best === null || d < bestD || (d === bestD && (c[0] < best[0] || (c[0] === best[0] && c[1] < best[1])))) {
      best = c;
      bestD = d;
    }
  }
  return best ?? undefined;
}

/** First coordinate of a feature, for the canonical sort key. */
function firstCoord(f: GeoJSON.Feature): Pt {
  const g = f.geometry;
  if (g.type === "LineString") return g.coordinates[0] as Pt;
  if (g.type === "Polygon") return g.coordinates[0][0] as Pt;
  if (g.type === "MultiPolygon") return g.coordinates[0][0][0] as Pt;
  if (g.type === "Point") return g.coordinates as Pt;
  return [0, 0];
}

/**
 * Clip a polygon's rings (`[outer, ...holes]`, each closed) to a bbox, keeping
 * the holes. Two tiles clipping the same pre-clip polygon against their shared
 * edge compute bit-identical boundary points (`clipPolygonToBBox`), so the
 * seam is invisible. Returns null when the outer ring clips away entirely; a
 * hole that clips away is dropped.
 */
function clipRingsToBBox(polygon: Pt[][], bbox: BBox): Pt[][] | null {
  const outer = clipPolygonToBBox(polygon[0] as Pt[], bbox);
  if (outer.length < 3) return null;
  const rings: Pt[][] = [[...outer, outer[0]]];
  for (let h = 1; h < polygon.length; h++) {
    const hole = clipPolygonToBBox(polygon[h] as Pt[], bbox);
    if (hole.length >= 3) rings.push([...hole, hole[0]]);
  }
  return rings;
}

/** Canonical order: first coordinate x, then y, then id. The id compare is
 * mandatory — arterials all share the center first coordinate, so a
 * coordinate-only comparator would leave them unordered (nondeterministic). */
function sortCanonical(features: GeoJSON.Feature[]): void {
  features.sort((a, b) => {
    const ca = firstCoord(a);
    const cb = firstCoord(b);
    return ca[0] - cb[0] || ca[1] - cb[1] || Number(a.id) - Number(b.id);
  });
}

/**
 * Compute the whole (unclipped) network for a region: Stage-A skeleton, then
 * the Stage-B growth loop seeded from it, then Stage-C. Pure — reads
 * only its arguments (D6). `profileId` arrives separately because the region
 * carries geometry only; the registry's params schema owns profile choice.
 * Coordinates are quantized and the feature list is canonically sorted before
 * return.
 */
/**
 * Additive per-run city params. Supplied by the registry from the persisted
 * procgen block; OMITTED (undefined) for callers that don't opt in.
 * `seamBoulevard` promotes the na-grid quadrant-collision seam into ONE diagonal
 * boulevard; `growthRings` (1 or 2) adds euro-medieval's older inner ring road.
 */
export interface CityParamOverrides {
  seamBoulevard?: boolean;
  growthRings?: number;
}

export function generateCityNetwork(
  citySeed: number,
  region: ProcgenRegion,
  profileId: ProfileId,
  constraints: GenerationConstraints,
  centerOverride?: [number, number],
  overrides?: CityParamOverrides
): GeoJSON.Feature[] {
  // Plan 039 §1.1: a typed `market` canon pin inside the region ATTRACTS the
  // plaza + arterial star, generalizing the shipped `center` param. Precedence
  // is closed-form: an explicit `centerOverride` (params.center) wins; else the
  // deterministic nearest market pin; else the computed generationCenter. Untyped
  // pins keep today's route-around behavior (they never become a center), so a
  // city with no explicit center AND no market pin is byte-identical to v2. No
  // new seed derivation — the pin's own mm-quantized position IS the center.
  const effCenter = centerOverride ?? marketPinCenter(region, constraints.canonFeatures);
  // Effective profile: the data-table profile plus the additive per-run params.
  // A fresh clone (never mutating PROFILES). Absent overrides ⇒ identical to
  // the base profile.
  const profile: CityProfile = { ...PROFILES[profileId] };
  if (overrides?.seamBoulevard !== undefined) profile.seamBoulevard = overrides.seamBoulevard;
  if (overrides?.growthRings !== undefined) profile.growthRings = overrides.growthRings;
  // Seam boulevard: na-grid's collision seam becomes a single diagonal
  // breakthrough boulevard — reuse the axial operator (a lone hashed-bearing
  // chord reads diagonal across the cardinal grid — the Market-Street cut).
  if (!profile.axial && profile.seamBoulevard) {
    profile.axial = { count: 1, mode: "breakthrough", elbow: 0 } satisfies AxialConfig;
  }

  // Canal rings: build the concentric canals BEFORE the cost field /
  // skeleton and fold them into the constraints as `river` lines, so the shared
  // citynet water machinery (bridges where radials cross, quays along banks,
  // footprints kept out of the water) drives them with no new plumbing. The
  // center matches the skeleton's (same inputs → `resolveCenter` mirrors
  // `resolveGenerationCenter`), so canals and radials share one origin.
  let effConstraints = constraints;
  let canalRuns: Pt[][] = [];
  if (profile.concentric?.mode === "canals") {
    const center = resolveCenter(region, effCenter);
    canalRuns = concentricCanalRuns(region, center, profile.concentric);
    if (canalRuns.length > 0) {
      const canalFeatures: FabricFeature[] = canalRuns.map((run, i) => ({
        type: "Feature",
        id: `canal:${region.id}:${i}`,
        geometry: { type: "LineString", coordinates: run.map(([x, y]) => [q(x), q(y)]) },
        properties: { kind: "river" },
      }));
      effConstraints = {
        ...constraints,
        fabricFeatures: [...(constraints.fabricFeatures ?? []), ...canalFeatures],
      };
    }
  }

  // Generated canopy (plan 037, forest/park → city): an SDF positive inside the
  // upstream vegetation. null with no upstream ⇒ every coupled path below is an
  // identity no-op (byte-identical uncoupled city). Streets thin in the woods
  // (attenuated cityness) and parcels/footprints are rejected where the canopy
  // is DENSE — the canopy itself is NEVER clipped (the town reads as a clearing
  // through paint order, the standing rejection of "city clips canopy").
  const canopy = buildUpstreamVegetationField(constraints.upstream);
  const cost = makeCostField(citySeed, region, effConstraints);
  const skel = buildSkeleton(citySeed, region, profile, effConstraints, cost, effCenter);
  const features: GeoJSON.Feature[] = [];

  /** Plan-020 containment guard for center-built decorative rings. */
  const ringInside = (ring: Pt[]): boolean => {
    for (const [x, y] of ring) {
      if (!regionContains(region, x, y)) return false;
    }
    return true;
  };

  skel.arterials.forEach((art) => {
    if (art.coords.length < 2) return;
    // Fixed key order for byte-stable cache; `degraded` appended last, only
    // when true (D5).
    const properties: Record<string, unknown> = {
      generated: true,
      generatorId: "city-street",
      type: "street",
      roadClass: "arterial",
      width: widthFor(profile, "arterial"),
      regionId: region.id,
    };
    if (art.degraded) properties.degraded = true;
    features.push({
      type: "Feature",
      id: hashSeed(citySeed, "arterial", art.key),
      geometry: { type: "LineString", coordinates: qLine(art.coords) },
      properties,
    });
  });

  skel.bridges.forEach((b, i) => {
    if (b.coords.length < 2) return;
    features.push({
      type: "Feature",
      id: hashSeed(citySeed, "bridge", i),
      geometry: { type: "LineString", coordinates: qLine(b.coords) },
      properties: {
        generated: true,
        generatorId: "city-street",
        type: "bridge",
        roadClass: "arterial",
        width: widthFor(profile, "arterial"),
        regionId: region.id,
      },
    });
  });

  skel.waterfront.forEach((w, i) => {
    if (w.coords.length < 2) return;
    features.push({
      type: "Feature",
      id: hashSeed(citySeed, "waterfront", i),
      geometry: { type: "LineString", coordinates: qLine(w.coords) },
      properties: {
        generated: true,
        generatorId: "city-street",
        type: "street",
        roadClass: "street",
        width: widthFor(profile, "street"),
        regionId: region.id,
      },
    });
  });

  if (skel.plaza.length >= 4 && ringInside(skel.plaza)) {
    features.push({
      type: "Feature",
      id: hashSeed(citySeed, "plaza"),
      geometry: { type: "Polygon", coordinates: [qLine(skel.plaza)] },
      properties: {
        generated: true,
        generatorId: "city-landmark",
        type: "plaza",
        regionId: region.id,
      },
    });
  }

  skel.landmarks.forEach((lm, i) => {
    if (lm.ring.length < 4 || !ringInside(lm.ring)) return;
    features.push({
      type: "Feature",
      id: hashSeed(citySeed, "landmark", i),
      geometry: { type: "Polygon", coordinates: [qLine(lm.ring)] },
      properties: {
        generated: true,
        generatorId: "city-landmark",
        type: "landmark",
        landmark: lm.kind,
        regionId: region.id,
      },
    });
  });

  // Wall / ring / gates (profile-gated, may be null). The ring traces the
  // sketched outline via insetRing; gates are ring vertices by construction.
  if (skel.wall) {
    features.push({
      type: "Feature",
      id: hashSeed(citySeed, "ring"),
      geometry: { type: "LineString", coordinates: qLine(skel.wall.ring) },
      properties: {
        generated: true,
        generatorId: "city-street",
        type: "street",
        roadClass: "ring",
        width: widthFor(profile, "ring"),
        regionId: region.id,
      },
    });
    skel.wall.wallSegments.forEach((quad, i) => {
      if (!ringInside(quad)) return;
      features.push({
        type: "Feature",
        id: hashSeed(citySeed, "wallseg", i),
        geometry: { type: "Polygon", coordinates: [qLine(quad)] },
        properties: {
          generated: true,
          generatorId: "city-landmark",
          type: "wall",
          regionId: region.id,
        },
      });
    });
    skel.wall.gates.forEach(([gx, gy], i) => {
      features.push({
        type: "Feature",
        id: hashSeed(citySeed, "gate", i),
        geometry: { type: "Point", coordinates: [q(gx), q(gy)] },
        properties: {
          generated: true,
          generatorId: "city-landmark",
          type: "gate",
          regionId: region.id,
        },
      });
    });
  }

  // Stage B: grow the street web off the skeleton, emit merged chains
  // (roadClass "street" or "alley" — chains never mix classes). Chain
  // keys are position-derived (endpoint node keys), never order-derived.
  const { graph } = growNetwork(citySeed, region, profile, effConstraints, skel, canopy);
  // Axial breakthrough: profiles that opt in (haussmann, baroque-axial, and
  // na-grid+seamBoulevard) cut wide boulevards THROUGH the grown fabric here —
  // spliced planar into the graph as `boulevard`-class grown edges BEFORE
  // faces/parcels, so the blocks they cross re-close and re-parcel fronting the
  // cut with no reflow pass. A no-op for every profile without `axial` (and
  // without the seam upgrade).
  if (profile.axial) driveBoulevards(citySeed, graph, region, profile, skel);
  // Concentric ring roads (radial-star): splice the connector rings into the
  // graph as `ring`-class grown edges so the radial arterials × rings box the
  // wedge blocks (BEFORE faces, same stage order as the axial cut).
  if (profile.concentric?.mode === "roads") {
    driveRingRoads(graph, region, skel.center, profile.concentric);
  }
  // Growth rings (euro-medieval `growthRings: 2`): one older inner ring road
  // inside the outer wall — the Paris Châtelet reading.
  if ((profile.growthRings ?? 1) >= 2) {
    driveRingRoads(graph, region, skel.center, { count: 1, mode: "roads", innerFrac: 0.5, outerFrac: 0.5 });
  }
  for (const chain of collectGrownChains(graph)) {
    if (chain.coords.length < 2) continue;
    features.push({
      type: "Feature",
      id: hashSeed(citySeed, "grown", chain.key),
      geometry: { type: "LineString", coordinates: qLine(chain.coords) },
      properties: {
        generated: true,
        generatorId: "city-street",
        type: "street",
        roadClass: chain.roadClass,
        width: widthFor(profile, chain.roadClass),
        regionId: region.id,
      },
    });
  }

  // Court bulbs (na-suburb): cul-de-sac profiles cap their
  // unsnapped street tips with small octagons — the suburb signature. A tip
  // close enough to the sketched boundary that its bulb would poke past it
  // keeps its street but loses the bulb (containment guard).
  if (profile.culdesacs) {
    for (const tip of collectCourtTips(graph)) {
      const ring: Pt[] = [];
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * 2 * Math.PI;
        ring.push([tip.x + COURT_RADIUS_M * Math.cos(a), tip.y + COURT_RADIUS_M * Math.sin(a)]);
      }
      ring.push(ring[0]);
      if (!ringInside(ring)) continue;
      features.push({
        type: "Feature",
        id: hashSeed(citySeed, "court", tip.key),
        geometry: { type: "Polygon", coordinates: [qLine(ring)] },
        properties: {
          generated: true,
          generatorId: "city-landmark",
          type: "court",
          regionId: region.id,
        },
      });
    }
  }

  // Stage C: faces → blocks → parcels → footprints, plus wards.
  // Block identity is the face's sorted node keys (position-derived); parcel/
  // footprint identity is (blockKey, split path) — never emission order (D2).
  // effConstraints folds in the canal rings as water, so blocks that span a
  // canal are dropped and footprints stay out of the water.
  const fabricIdx = indexConstraints(effConstraints, region.ring);
  const { blocks } = extractBlocks(graph, region);
  const dryBlocks = blocks.filter((b) => {
    // A face bounded by two quays can span the river; buildings don't swim. A
    // face falling in a contained nested-region hole (plan 037) is dropped too.
    let sx = 0;
    let sy = 0;
    const n = b.ring.length - 1;
    for (let i = 0; i < n; i++) {
      sx += b.ring[i][0];
      sy += b.ring[i][1];
    }
    const cx = sx / n;
    const cy = sy / n;
    return !blockedByWater(fabricIdx, cx, cy) && !blockedByHole(fabricIdx, cx, cy);
  });
  // Corner treatment: chamfered profiles (eixample) cut every convex block
  // corner back before emission AND before parcelling, so the octagonal blocks
  // read on screen and footprints front the cut corner instead of poking into
  // it. For chamfer===0, `shapedBlocks` IS `dryBlocks`.
  const shapedBlocks =
    profile.chamfer > 0
      ? dryBlocks.map((b) => ({ ...b, ring: chamferRing(b.ring, profile.chamfer) }))
      : dryBlocks;
  for (const block of shapedBlocks) {
    features.push({
      type: "Feature",
      id: hashSeed(citySeed, "block", block.nodeKeys.join("|")),
      geometry: { type: "Polygon", coordinates: [qLine(block.ring)] },
      properties: {
        generated: true,
        generatorId: "city-block",
        type: "block",
        regionId: region.id,
      },
    });
  }

  // Parcels read the SAME canopy-attenuated cityness as growth (coarser lots in
  // the woods), and a parcel/footprint whose centroid sits in DENSE canopy is
  // rejected outright (`deepInCanopy`) — buildings don't grow under a closed
  // canopy. No upstream ⇒ identity wrap + `deepInCanopy` always false ⇒
  // byte-identical.
  const cityness = attenuateCitynessByCanopy(
    makeCityness(citySeed, region, constraints.canonFeatures ?? []),
    canopy
  );
  const deepInCanopy = (ring: Pt[]): boolean => {
    if (canopy === null) return false;
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < ring.length; i++) {
      cx += ring[i][0];
      cy += ring[i][1];
    }
    return canopy(cx / ring.length, cy / ring.length) >= CANOPY_DENSE_M;
  };
  const ringCentroid = (ring: Pt[]): Pt => {
    let px = 0;
    let py = 0;
    for (let i = 0; i < ring.length; i++) {
      px += ring[i][0];
      py += ring[i][1];
    }
    return [px / ring.length, py / ring.length];
  };
  const { parcels, footprints } = subdivideBlocks(citySeed, shapedBlocks, profile, cityness);
  for (const p of parcels) {
    if (deepInCanopy(p.ring)) continue; // no parcel deep in the wood (plan 037)
    const [pcx, pcy] = ringCentroid(p.ring);
    if (blockedByHole(fabricIdx, pcx, pcy)) continue; // no parcel in a contained region (plan 037)
    if (inBankSetback(fabricIdx.channelRings, pcx, pcy)) continue; // building setback off the channel bank (plan 038.1)
    const ring = [...p.ring, p.ring[0]];
    features.push({
      type: "Feature",
      id: hashSeed(citySeed, "parcel", p.blockKey, p.path),
      geometry: { type: "Polygon", coordinates: [qLine(ring)] },
      properties: {
        generated: true,
        generatorId: "city-parcel",
        type: "parcel",
        regionId: region.id,
      },
    });
  }
  for (const fp of footprints) {
    // Buildings don't swim: a footprint on a block that STRADDLES the water —
    // dry centroid, but this sub-parcel falls in the river/channel — is dropped.
    // No effect for a city with no water (blockedByWater is false everywhere ⇒
    // every footprint is kept).
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < fp.ring.length; i++) {
      cx += fp.ring[i][0];
      cy += fp.ring[i][1];
    }
    const fcx = cx / fp.ring.length;
    const fcy = cy / fp.ring.length;
    if (blockedByWater(fabricIdx, fcx, fcy)) continue;
    if (blockedByHole(fabricIdx, fcx, fcy)) continue; // no footprint in a contained region (plan 037)
    if (deepInCanopy(fp.ring)) continue; // buildings don't grow under a closed canopy (plan 037)
    if (inBankSetback(fabricIdx.channelRings, fcx, fcy)) continue; // building setback off the channel bank (plan 038.1)
    const ring = [...fp.ring, fp.ring[0]];
    features.push({
      type: "Feature",
      id: hashSeed(citySeed, "footprint", fp.blockKey, fp.path),
      geometry: { type: "Polygon", coordinates: [qLine(ring)] },
      properties: {
        generated: true,
        generatorId: "city-footprint",
        type: "footprint",
        regionId: region.id,
      },
    });
  }

  for (const ward of buildWards(citySeed, region, skel)) {
    features.push({
      type: "Feature",
      id: hashSeed(citySeed, "ward", ward.siteKey),
      geometry: { type: "Polygon", coordinates: [qLine(ward.ring)] },
      properties: {
        generated: true,
        generatorId: "city-district",
        type: "district",
        ward: ward.tag,
        regionId: region.id,
      },
    });
  }

  // Outskirts: ribbon houses along arterials beyond the growth
  // extent, then fields, then nothing toward the boundary. Containment is
  // enforced inside buildOutskirts (all quad corners in-region).
  const outskirts = buildOutskirts(citySeed, region, profile, skel, cityness, fabricIdx);
  for (const rf of outskirts.ribbonFootprints) {
    const [rcx, rcy] = ringCentroid(rf.ring);
    if (inBankSetback(fabricIdx.channelRings, rcx, rcy)) continue; // no ribbon in the bank setback (plan 038.1)
    features.push({
      type: "Feature",
      id: hashSeed(citySeed, "ribbon", rf.key),
      geometry: { type: "Polygon", coordinates: [qLine(rf.ring)] },
      properties: {
        generated: true,
        generatorId: "city-footprint",
        type: "footprint",
        regionId: region.id,
      },
    });
  }
  for (const field of outskirts.fields) {
    features.push({
      type: "Feature",
      id: hashSeed(citySeed, "field", field.key),
      geometry: { type: "Polygon", coordinates: [qLine(field.ring)] },
      properties: {
        generated: true,
        generatorId: "city-landmark",
        type: "field",
        regionId: region.id,
      },
    });
  }

  // Canal water (canal-rings): the concentric canal centerlines emit as WATER —
  // a distinct `city-landmark` type=`canal` line the theme paints with the
  // water hue (a fat blue casing ≈ RIVER_HALF_WIDTH×2 wide), rendered BELOW the
  // streets so the radial bridges read OVER the canals. Empty for every
  // non-canal preset.
  canalRuns.forEach((run, i) => {
    if (run.length < 2) return;
    features.push({
      type: "Feature",
      id: hashSeed(citySeed, "canal", i),
      geometry: { type: "LineString", coordinates: qLine(run) },
      properties: {
        generated: true,
        generatorId: "city-landmark",
        type: "canal",
        width: 30,
        regionId: region.id,
      },
    });
  });

  // Adjacent-district shared-edge agreement (plan 038.6): where a neighbouring
  // district sketch ring shares an edge with this region, both sides hash the
  // shared-edge geometry to derive bit-matching arterial stubs + gates that meet
  // exactly on the edge (the tile-seam pattern — never reads the neighbour's
  // OUTPUT). Empty when no district is adjacent ⇒ byte-inert. Stubs are
  // arterial-grade streets; gates are `city-landmark` points on the edge.
  const shared = sharedEdgeStubs(citySeed, region, constraints);
  shared.stubs.forEach((st) => {
    features.push({
      type: "Feature",
      id: hashSeed(citySeed, "sharedstub", st.key),
      geometry: { type: "LineString", coordinates: qLine(st.coords) },
      properties: {
        generated: true,
        generatorId: "city-street",
        type: "street",
        roadClass: "arterial",
        width: widthFor(profile, "arterial"),
        regionId: region.id,
      },
    });
  });
  shared.gates.forEach(([gx, gy], i) => {
    features.push({
      type: "Feature",
      id: hashSeed(citySeed, "sharedgate", Math.round(gx * 10), Math.round(gy * 10), i),
      geometry: { type: "Point", coordinates: [q(gx), q(gy)] },
      properties: {
        generated: true,
        generatorId: "city-landmark",
        type: "gate",
        regionId: region.id,
      },
    });
  });

  // Contained nested regions (plan 037 item 5): every emitted feature is CLIPPED
  // against the holes — street lines split at the ring (interior parts dropped),
  // points/polygons whose site falls inside a hole removed — so NO city geometry
  // sits inside a contained park/district (the skeleton ring/arterials/plaza/
  // wards are caught here, not just the centroid-guarded blocks). Then the HOLE
  // gets a perimeter FRONTAGE street tracing just OUTSIDE its ring + hashed
  // ENTRANCE points ON the ring (position-derived — the tile-seam hash). The city
  // never reads the inner region's OUTPUT, only its sketch ring. Uniform for
  // park-in-city and district-in-district (a citadel). No holes ⇒ the whole pass
  // is skipped (byte-identical to the uncoupled city).
  if (fabricIdx.holeRings.length > 0) {
    const clipped = clipFeaturesToHoles(features, fabricIdx.holeRings);
    features.length = 0;
    features.push(...clipped);
    emitHoleFrontage(citySeed, region, fabricIdx, features);
  }

  sortCanonical(features);
  return features;
}

/** Union SDF of the hole rings (positive inside any hole). */
function holeField(holeRings: Pt[][]): Field {
  const fields = holeRings.map((r) => sdfPolygon(r));
  return (x, y): number => {
    let max = -Infinity;
    for (const f of fields) {
      const d = f(x, y);
      if (d > max) max = d;
    }
    return max;
  };
}

/** Representative site of a polygon ring (outer-ring vertex mean). */
function ringSite(ring: Pt[]): Pt {
  let sx = 0;
  let sy = 0;
  const n = ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.length - 1 : ring.length;
  for (let i = 0; i < n; i++) {
    sx += ring[i][0];
    sy += ring[i][1];
  }
  return [sx / n, sy / n];
}

/**
 * Clip every network feature against the contained-region holes (plan 037 item
 * 5): a street LineString is split at the hole boundary (interior runs dropped;
 * an untouched line keeps its original id + feature); a Point or Polygon whose
 * site falls inside a hole is removed. Pure f(features, holeRings).
 */
function clipFeaturesToHoles(features: GeoJSON.Feature[], holeRings: Pt[][]): GeoJSON.Feature[] {
  const field = holeField(holeRings);
  const inside = (x: number, y: number): boolean => field(x, y) >= 0;
  const out: GeoJSON.Feature[] = [];
  for (const f of features) {
    const g = f.geometry;
    if (g.type === "Point") {
      const [x, y] = g.coordinates as Pt;
      if (!inside(x, y)) out.push(f);
    } else if (g.type === "LineString") {
      const coords = g.coordinates as Pt[];
      const parts = splitLineOutsideChannel(coords, field);
      if (parts.length === 1 && parts[0].length === coords.length) {
        out.push(f); // untouched — keep the original id
      } else {
        parts.forEach((part, i) => {
          if (part.length < 2) return;
          out.push({
            type: "Feature",
            id: hashSeed(Number(f.id) >>> 0, "hole-clip", i),
            geometry: { type: "LineString", coordinates: part.map(([x, y]) => [q(x), q(y)]) },
            properties: f.properties,
          });
        });
      }
    } else if (g.type === "Polygon") {
      const [x, y] = ringSite(g.coordinates[0] as Pt[]);
      if (!inside(x, y)) out.push(f);
    } else if (g.type === "MultiPolygon") {
      const [x, y] = ringSite((g.coordinates as Pt[][][])[0][0]);
      if (!inside(x, y)) out.push(f);
    } else {
      out.push(f);
    }
  }
  return out;
}

/** Half-width offset (m) of the frontage street from the contained ring. */
const FRONTAGE_OFFSET_M = 6;
/** Per-ring-edge hashed inclusion probability for an entrance point. */
const ENTRANCE_P = 0.4;
/** A ring edge shorter than this hosts no entrance (a degenerate stub). */
const MIN_ENTRANCE_EDGE_M = 16;

/** Signed shoelace area × 2 of a ring (open or closed). */
function ringArea2(ring: Pt[]): number {
  let a = 0;
  const n = ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.length - 1 : ring.length;
  for (let i = 0; i < n; i++) {
    const b = ring[(i + 1) % n];
    a += ring[i][0] * b[1] - b[0] * ring[i][1];
  }
  return a;
}

/**
 * Emit the perimeter frontage street + hashed entrances for every contained
 * nested region. The frontage is the ring pushed OUTWARD along per-vertex
 * normals (winding-aware) by `FRONTAGE_OFFSET_M`, containment-guarded to the
 * outer region; entrances are the midpoints of the ring's longer edges whose
 * hashed score clears `ENTRANCE_P` (position-keyed — the tile-seam pattern).
 */
function emitHoleFrontage(
  citySeed: number,
  region: ProcgenRegion,
  idx: FabricConstraintIndex,
  features: GeoJSON.Feature[]
): void {
  for (let h = 0; h < idx.holeRings.length; h++) {
    const ring = idx.holeRings[h];
    const n = ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.length - 1 : ring.length;
    if (n < 3) continue;
    const outwardSign = ringArea2(ring) > 0 ? -1 : 1; // left normal points inward for CCW
    const frontage: Pt[] = [];
    for (let i = 0; i < n; i++) {
      const prev = ring[(i - 1 + n) % n];
      const cur = ring[i];
      const next = ring[(i + 1) % n];
      const l1 = leftUnitNormal(prev, cur);
      const l2 = leftUnitNormal(cur, next);
      let mx = l1[0] + l2[0];
      let my = l1[1] + l2[1];
      const ml = Math.hypot(mx, my) || 1;
      mx /= ml;
      my /= ml;
      frontage.push([cur[0] + outwardSign * FRONTAGE_OFFSET_M * mx, cur[1] + outwardSign * FRONTAGE_OFFSET_M * my]);
    }
    frontage.push(frontage[0]); // close
    // Containment guard: skip a frontage that pokes outside the outer region
    // (a hole hugging the boundary) — the hole rejection still holds either way.
    if (frontage.every(([x, y]) => regionContains(region, x, y))) {
      features.push({
        type: "Feature",
        id: hashSeed(citySeed, "frontage", h),
        geometry: { type: "LineString", coordinates: qLine(frontage) },
        properties: {
          generated: true,
          generatorId: "city-street",
          type: "street",
          roadClass: "street",
          width: 4,
          regionId: region.id,
        },
      });
    }
    // Entrances hashed on the ring edges (position-keyed, deterministic).
    for (let i = 0; i < n; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % n];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < MIN_ENTRANCE_EDGE_M) continue;
      const rng = mulberry32(hashSeed(citySeed, "entrance", Math.round(a[0]), Math.round(a[1]), Math.round(b[0]), Math.round(b[1])));
      if (rng() >= ENTRANCE_P) continue;
      const ex = q((a[0] + b[0]) / 2);
      const ey = q((a[1] + b[1]) / 2);
      features.push({
        type: "Feature",
        id: hashSeed(citySeed, "entrance", Math.round(ex * 10), Math.round(ey * 10)),
        geometry: { type: "Point", coordinates: [ex, ey] },
        properties: {
          generated: true,
          generatorId: "city-landmark",
          type: "gate",
          regionId: region.id,
        },
      });
    }
  }
}

/** Unit left-normal of edge a→b (deterministic; zero-length edge ⇒ [0,0]). */
function leftUnitNormal(a: Pt, b: Pt): Pt {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  return [-dy / len, dx / len];
}

function toVec2(coords: Pt[]): Vec2[] {
  return coords.map(([x, y]) => ({ x, y }));
}

/**
 * Clip a whole-region network to a tile bbox, bucketed by each feature's
 * per-tile `generatorId`. LineStrings split into one feature per clipped part;
 * polygons are Sutherland-Hodgman clipped and re-closed (empty/degenerate
 * results dropped); points use half-open containment so exactly one tile claims
 * a boundary point. Every returned bucket is canonically re-sorted.
 */
export function clipNetworkToTile(
  network: GeoJSON.Feature[],
  bbox: BBox
): Record<string, GeoJSON.Feature[]> {
  const buckets: Record<string, GeoJSON.Feature[]> = {};
  const push = (gid: string, f: GeoJSON.Feature): void => {
    (buckets[gid] ??= []).push(f);
  };

  for (const f of network) {
    const gid = String((f.properties as Record<string, unknown>)?.generatorId ?? "unknown");
    const g = f.geometry;

    if (g.type === "LineString") {
      const parts = clipPolylineToBBox(toVec2(g.coordinates as Pt[]), bbox);
      parts.forEach((part, partIndex) => {
        if (part.length < 2) return;
        // Zero-length artifact guard (observed live): a polyline
        // grazing a tile corner can clip to a 2-point part of ~0 length.
        let len = 0;
        for (let i = 1; i < part.length; i++) len += Math.hypot(part[i].x - part[i - 1].x, part[i].y - part[i - 1].y);
        if (len < 0.01) return;
        push(gid, {
          type: "Feature",
          id: hashSeed(Number(f.id) >>> 0, partIndex),
          geometry: { type: "LineString", coordinates: part.map((p) => [p.x, p.y]) },
          properties: f.properties,
        });
      });
    } else if (g.type === "Polygon") {
      const rings = clipRingsToBBox(g.coordinates as Pt[][], bbox);
      if (!rings) continue; // degenerate/empty outer
      push(gid, {
        type: "Feature",
        id: hashSeed(Number(f.id) >>> 0, "clip"),
        geometry: { type: "Polygon", coordinates: rings },
        properties: f.properties,
      });
    } else if (g.type === "MultiPolygon") {
      // Clip each sub-polygon (outer + holes) to the tile; drop those that fall
      // entirely outside. One artifact → one MultiPolygon per tile, holes kept
      // so forest clearings survive the tiling.
      const polys: Pt[][][] = [];
      for (const poly of g.coordinates as Pt[][][]) {
        const rings = clipRingsToBBox(poly, bbox);
        if (rings) polys.push(rings);
      }
      if (polys.length === 0) continue;
      push(gid, {
        type: "Feature",
        id: hashSeed(Number(f.id) >>> 0, "clip"),
        geometry: { type: "MultiPolygon", coordinates: polys },
        properties: f.properties,
      });
    } else if (g.type === "Point") {
      const [x, y] = g.coordinates as Pt;
      if (x >= bbox.minX && x < bbox.maxX && y >= bbox.minY && y < bbox.maxY) {
        push(gid, f);
      }
    }
  }

  for (const gid of Object.keys(buckets)) sortCanonical(buckets[gid]);
  return buckets;
}
