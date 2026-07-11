/**
 * City street generation: tensor-field streamlines seeded from a
 * position-deterministic grid (src/gen/spatialHash.ts), clipped to the
 * requested tile. Pure/headless — no DOM/map/Obsidian imports.
 */
import { hashSeed } from "../rng";
import type { BBox } from "../spatialHash";
import { expandBBox, jitteredGridPoints } from "../spatialHash";
import type { GenerationConstraints } from "../types";
import { clipPolylineToBBox } from "../clip";
import {
  blockedByWater,
  fabricAngleSampler,
  indexFabricConstraints,
  truncateAtBarriers,
} from "../fabricConstraints";
import { traceStreamline, type AngleSampler } from "./streamlines";
import { buildTensorField, sampleFieldAngle } from "./tensorField";

export { generateDistricts } from "./districts";
export { generateCityBlocks } from "./blocks";
export {
  generateCorridorStreets,
  chaikinSmooth,
  CORRIDOR_HALO,
  CORRIDOR_INFLUENCE,
} from "./corridor";

// Tuning within docs/06 §3 ranges (streamline dsep 20-60m-equiv).
export const STREET_SEED_CELL_SIZE = 60;
export const STREET_STEP_SIZE = 8;
export const STREET_MAX_STEPS = 12;
/** Seam-safety invariant: halo must cover the longest possible streamline
 * half-length, or a streamline crossing a tile edge could be seeded outside
 * one neighbor's halo and diverge from the other's. */
export const STREET_HALO = STREET_STEP_SIZE * STREET_MAX_STEPS;

function pointsOf(feature: GeoJSON.Feature): [number, number][] {
  const g = feature.geometry;
  if (g.type === "Point") return [g.coordinates as [number, number]];
  return [];
}

/** `(seed, bbox, constraints) => Feature[]` — the canonical generator signature. */
export function generateCityStreets(
  campaignSeed: number,
  bbox: BBox,
  constraints: GenerationConstraints
): GeoJSON.Feature[] {
  const field = buildTensorField(campaignSeed, constraints.worldBounds);
  const haloBBox = expandBBox(bbox, STREET_HALO);
  const seeds = jitteredGridPoints(campaignSeed, haloBBox, STREET_SEED_CELL_SIZE, "street-seed");

  const canonPoints = (constraints.canonFeatures ?? []).flatMap(pointsOf);
  // Sketched fabric steers generation (plan 019 Phase 3): roads blend into
  // the direction field (every sketched road is a constraint — the
  // generalization of plan 014's corridor blend), water/rivers block seeds
  // and truncate traces, walls truncate traces. All pure functions of world
  // coordinates + the whole fabric collection — seam-safe.
  const fabric = indexFabricConstraints(constraints.fabricFeatures);
  const sampler: AngleSampler =
    fabricAngleSampler(field, fabric) ?? ((x, y) => sampleFieldAngle(field, x, y));

  const features: GeoJSON.Feature[] = [];
  for (const seed of seeds) {
    // Canon geometry is never overwritten by generators (CLAUDE.md locked
    // decision): streets route around settled ground instead of through it.
    const tooCloseToCanon = canonPoints.some(
      ([cx, cy]) => Math.hypot(cx - seed.x, cy - seed.y) < STREET_SEED_CELL_SIZE * 0.5
    );
    if (tooCloseToCanon) continue;
    if (blockedByWater(fabric, seed.x, seed.y)) continue;

    const line = truncateAtBarriers(
      fabric,
      traceStreamline(sampler, seed, {
        stepSize: STREET_STEP_SIZE,
        maxSteps: STREET_MAX_STEPS,
        bounds: haloBBox,
      })
    );
    if (line.length < 2) continue;

    const parts = clipPolylineToBBox(line, bbox);
    parts.forEach((part, partIndex) => {
      if (part.length < 2) return;
      features.push({
        type: "Feature",
        id: hashSeed(campaignSeed, seed.cellX, seed.cellY, "street", partIndex),
        geometry: { type: "LineString", coordinates: part.map((p) => [p.x, p.y]) },
        properties: {
          generated: true,
          generatorId: "city-street",
          type: "street(named)",
        },
      });
    });
  }

  // Canonical order: never let output depend on incidental iteration order
  // upstream — required for hash-identical caching after a `.mapcache/`
  // delete-and-regenerate.
  features.sort((a, b) => {
    const ca = (a.geometry as GeoJSON.LineString).coordinates[0];
    const cb = (b.geometry as GeoJSON.LineString).coordinates[0];
    return ca[0] - cb[0] || ca[1] - cb[1];
  });
  return features;
}
