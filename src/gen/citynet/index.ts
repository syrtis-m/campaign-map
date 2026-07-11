/**
 * City-network entry point (procgen v3 §3.4, §5): `generateCityNetwork`
 * computes the whole city network for a domain — Stage-A skeleton plus the
 * Stage-B grown street web — as a pure function of `(citySeed, domain,
 * constraints)`, and `clipNetworkToTile` cuts that one artifact into the
 * per-tile, per-generatorId buckets the cache stores and the map paints.
 *
 * Determinism/seam argument: the network is computed once, not per tile, so two
 * tiles never need order-free math to agree — they clip the *same bytes*
 * (§3.1). D5 is enforced here: every emitted coordinate is quantized to the
 * millimeter, and every feature list (whole network and every clip bucket) is
 * canonically sorted by first coordinate then id — the id tiebreak is
 * load-bearing because all arterials share the domain-center first coordinate.
 * Clipping reuses `clip.ts` (Liang-Barsky / Sutherland-Hodgman): a segment
 * crossing a shared tile edge gets a bit-identical boundary point from both
 * neighbors, so the 2×2 seam gate passes.
 */
import { hashSeed } from "../rng";
import type { BBox } from "../spatialHash";
import { clipPolylineToBBox, clipPolygonToBBox, type Vec2 } from "../clip";
import type { GenerationConstraints } from "../types";
import { blockedByWater, indexFabricConstraints } from "../fabricConstraints";
import type { CityDomain } from "./domain";
import { PROFILES } from "./profiles";
import { makeCostField } from "./costField";
import { buildSkeleton } from "./skeleton";
import { growNetwork, collectGrownChains } from "./growth";
import { extractBlocks } from "./faces";
import { subdivideBlocks } from "./parcels";
import { buildWards } from "./wards";
import { makeCityness } from "./cityness";

// Package barrel: the host (MapView, generationService, worker, modal) imports
// domain + profile helpers and types from `../citynet` directly.
export * from "./domain";
export * from "./profiles";

type Pt = [number, number];

/**
 * Per-tile generator ids the domain network clips into — all live as of v3.2:
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
 * mandatory — arterials all share the domain-center first coordinate, so a
 * coordinate-only comparator would leave them unordered (nondeterministic). */
function sortCanonical(features: GeoJSON.Feature[]): void {
  features.sort((a, b) => {
    const ca = firstCoord(a);
    const cb = firstCoord(b);
    return ca[0] - cb[0] || ca[1] - cb[1] || Number(a.id) - Number(b.id);
  });
}

/**
 * Compute the whole (unclipped) network for a domain: Stage-A skeleton, then
 * the Stage-B growth loop seeded from it (v3.1). Pure — reads only its
 * arguments (D6). Coordinates are quantized and the feature list is
 * canonically sorted before return.
 */
export function generateCityNetwork(
  citySeed: number,
  domain: CityDomain,
  constraints: GenerationConstraints
): GeoJSON.Feature[] {
  const profile = PROFILES[domain.profile];
  const cost = makeCostField(citySeed, domain, constraints);
  const skel = buildSkeleton(citySeed, domain, profile, constraints, cost);
  const features: GeoJSON.Feature[] = [];

  skel.arterials.forEach((art, i) => {
    if (art.coords.length < 2) return;
    // Fixed key order for byte-stable cache; `degraded` appended last, only
    // when true (D5).
    const properties: Record<string, unknown> = {
      generated: true,
      generatorId: "city-street",
      type: "street",
      roadClass: "arterial",
      domainId: domain.id,
    };
    if (art.degraded) properties.degraded = true;
    features.push({
      type: "Feature",
      id: hashSeed(citySeed, "arterial", i),
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
        domainId: domain.id,
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
        domainId: domain.id,
      },
    });
  });

  if (skel.plaza.length >= 4) {
    features.push({
      type: "Feature",
      id: hashSeed(citySeed, "plaza"),
      geometry: { type: "Polygon", coordinates: [qLine(skel.plaza)] },
      properties: {
        generated: true,
        generatorId: "city-landmark",
        type: "plaza",
        domainId: domain.id,
      },
    });
  }

  skel.landmarks.forEach((lm, i) => {
    if (lm.ring.length < 4) return;
    features.push({
      type: "Feature",
      id: hashSeed(citySeed, "landmark", i),
      geometry: { type: "Polygon", coordinates: [qLine(lm.ring)] },
      properties: {
        generated: true,
        generatorId: "city-landmark",
        type: "landmark",
        landmark: lm.kind,
        domainId: domain.id,
      },
    });
  });

  // Stage B (v3.1): grow the street web off the skeleton, emit merged chains.
  // Chain keys are position-derived (endpoint node keys), never order-derived.
  const { graph } = growNetwork(citySeed, domain, profile, constraints, skel);
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
        roadClass: "street",
        domainId: domain.id,
      },
    });
  }

  // Stage C (v3.2): faces → blocks → parcels → footprints, plus wards.
  // Block identity is the face's sorted node keys (position-derived); parcel/
  // footprint identity is (blockKey, split path) — never emission order (D2).
  const fabricIdx = indexFabricConstraints(constraints.fabricFeatures);
  const { blocks } = extractBlocks(graph, domain);
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
        domainId: domain.id,
      },
    });
  }

  const cityness = makeCityness(citySeed, domain);
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
        domainId: domain.id,
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
        domainId: domain.id,
      },
    });
  }

  for (const ward of buildWards(citySeed, domain, skel)) {
    features.push({
      type: "Feature",
      id: hashSeed(citySeed, "ward", ward.siteKey),
      geometry: { type: "Polygon", coordinates: [qLine(ward.ring)] },
      properties: {
        generated: true,
        generatorId: "city-district",
        type: "district",
        ward: ward.tag,
        domainId: domain.id,
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
 * Clip a whole-domain network to a tile bbox, bucketed by each feature's
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
