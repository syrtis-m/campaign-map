/**
 * City-network entry point (procgen v3 §3.4/§5, generalized to sketched
 * regions in plan 020 §6): `generateCityNetwork` computes the whole city
 * network for a ProcgenRegion — Stage-A skeleton plus the Stage-B grown
 * street web plus Stage-C blocks/parcels/footprints, wards, and outskirts —
 * as a pure function of `(citySeed, region, profile, constraints)`, and
 * `clipNetworkToTile` cuts that one artifact into the per-tile,
 * per-generatorId buckets the cache stores and the map paints.
 *
 * Plan 020 contract: EVERY emitted coordinate lies inside (or exactly on)
 * the region polygon — the sketch is the outer limit of all output. Streets
 * and quays are clipped to the region upstream (skeleton/growth); the small
 * decorative rings built here from a center point (plaza, landmarks, court
 * bulbs, wall-band quads) are containment-GUARDED at emission instead:
 * a ring with any vertex outside the region is skipped whole (deterministic,
 * counted implicitly by absence — never thrown).
 *
 * Determinism/seam argument: the network is computed once, not per tile, so
 * two tiles never need order-free math to agree — they clip the *same bytes*
 * (§3.1). D5 is enforced here: every emitted coordinate is quantized to the
 * millimeter, and every feature list (whole network and every clip bucket)
 * is canonically sorted by first coordinate then id — the id tiebreak is
 * load-bearing because all arterials share the center first coordinate.
 * Clipping reuses `clip.ts` (Liang-Barsky / Sutherland-Hodgman): a segment
 * crossing a shared tile edge gets a bit-identical boundary point from both
 * neighbors, so the 2×2 seam gate passes.
 */
import { hashSeed } from "../rng";
import type { BBox } from "../spatialHash";
import { clipPolylineToBBox, clipPolygonToBBox, type Vec2 } from "../clip";
import type { GenerationConstraints } from "../types";
import { blockedByWater, indexFabricConstraints } from "../fabricConstraints";
import { regionContains, type ProcgenRegion } from "../region";
import { PROFILES } from "./profiles";
import type { ProfileId } from "./domain";
import { makeCostField } from "./costField";
import { buildSkeleton } from "./skeleton";
import { growNetwork, collectGrownChains, collectCourtTips, COURT_RADIUS_M } from "./growth";
import { extractBlocks } from "./faces";
import { subdivideBlocks } from "./parcels";
import { buildWards } from "./wards";
import { buildOutskirts } from "./outskirts";
import { makeCityness } from "./cityness";

// Package barrel: the host (MapView, generationService, worker, modal) imports
// domain + profile helpers and types from `../citynet` directly.
export * from "./domain";
export * from "./profiles";

type Pt = [number, number];

/**
 * Per-tile generator ids the region network clips into — all live as of v3.2:
 * streets (arterials/bridges/waterfront/grown), blocks (faces), parcels,
 * footprints, landmarks (plaza/church/market), and wards (`city-district` —
 * deliberately the legacy Voronoi district id so wards inherit its paint
 * layer; the legacy generator stops running on domain tiles from v3.2).
 */
export const DOMAIN_TILE_GENERATOR_IDS: readonly string[] = [
  "city-street",
  "city-block",
  "city-parcel",
  "city-footprint",
  "city-landmark",
  "city-district",
];

/** D5 coordinate quantization: millimeter lattice. */
function q(v: number): number {
  return Math.round(v * 1000) / 1000;
}
function qLine(coords: Pt[]): Pt[] {
  return coords.map(([x, y]) => [q(x), q(y)]);
}

/** First coordinate of a feature, for the canonical sort key. */
function firstCoord(f: GeoJSON.Feature): Pt {
  const g = f.geometry;
  if (g.type === "LineString") return g.coordinates[0] as Pt;
  if (g.type === "Polygon") return g.coordinates[0][0] as Pt;
  if (g.type === "Point") return g.coordinates as Pt;
  return [0, 0];
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
 * the Stage-B growth loop seeded from it (v3.1), then Stage-C. Pure — reads
 * only its arguments (D6). `profileId` arrives separately because the region
 * carries geometry only; the registry's params schema owns profile choice
 * (plan 020 §5). Coordinates are quantized and the feature list is
 * canonically sorted before return.
 */
export function generateCityNetwork(
  citySeed: number,
  region: ProcgenRegion,
  profileId: ProfileId,
  constraints: GenerationConstraints
): GeoJSON.Feature[] {
  const profile = PROFILES[profileId];
  const cost = makeCostField(citySeed, region, constraints);
  const skel = buildSkeleton(citySeed, region, profile, constraints, cost);
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

  // Wall / ring / gates (v3.3, §5.1.5 — profile-gated, may be null). The
  // ring traces the sketched outline via insetRing (plan 020 §6); gates are
  // ring vertices by construction.
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

  // Stage B (v3.1): grow the street web off the skeleton, emit merged chains
  // (roadClass "street" or "alley" — chains never mix classes, v3.4). Chain
  // keys are position-derived (endpoint node keys), never order-derived.
  const { graph } = growNetwork(citySeed, region, profile, constraints, skel);
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
        regionId: region.id,
      },
    });
  }

  // Court bulbs (§5.2 na-suburb, v3.4): cul-de-sac profiles cap their
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

  // Stage C (v3.2): faces → blocks → parcels → footprints, plus wards.
  // Block identity is the face's sorted node keys (position-derived); parcel/
  // footprint identity is (blockKey, split path) — never emission order (D2).
  const fabricIdx = indexFabricConstraints(constraints.fabricFeatures);
  const { blocks } = extractBlocks(graph, region);
  const dryBlocks = blocks.filter((b) => {
    // A face bounded by two quays can span the river; buildings don't swim.
    let sx = 0;
    let sy = 0;
    const n = b.ring.length - 1;
    for (let i = 0; i < n; i++) {
      sx += b.ring[i][0];
      sy += b.ring[i][1];
    }
    return !blockedByWater(fabricIdx, sx / n, sy / n);
  });
  for (const block of dryBlocks) {
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

  const cityness = makeCityness(citySeed, region, constraints.canonFeatures ?? []);
  const { parcels, footprints } = subdivideBlocks(citySeed, dryBlocks, profile, cityness);
  for (const p of parcels) {
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

  // Outskirts (v3.3, §5.3.3): ribbon houses along arterials beyond the growth
  // extent, then fields, then nothing toward the boundary. Containment is
  // enforced inside buildOutskirts (all quad corners in-region).
  const outskirts = buildOutskirts(citySeed, region, profile, skel, cityness, fabricIdx);
  for (const rf of outskirts.ribbonFootprints) {
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

  sortCanonical(features);
  return features;
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
        // Zero-length artifact guard (observed live in v3.0): a polyline
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
      const clipped = clipPolygonToBBox(g.coordinates[0] as Pt[], bbox);
      if (clipped.length < 3) continue; // degenerate/empty
      const ring: Pt[] = [...clipped, clipped[0]];
      push(gid, {
        type: "Feature",
        id: hashSeed(Number(f.id) >>> 0, "clip"),
        geometry: { type: "Polygon", coordinates: [ring] },
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
