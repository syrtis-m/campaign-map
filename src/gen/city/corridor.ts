/**
 * Sketch-corridor street inference: a GM-drawn
 * road corridor (a fabric `road` feature in "generate" mode) is elaborated
 * into a street network that follows it — the corridor becomes a smoothed
 * major avenue, and branching minor streets grow off it through the same
 * tensor-field machinery as `generateCityStreets`.
 *
 * Pure/headless (no DOM/map/Obsidian imports) and seam-deterministic by the
 * same construction as the base generator:
 *  - the direction field is a pure function of (campaignSeed, worldBounds,
 *    corridor coordinates) and world position only — every tile that samples
 *    it sees the identical field (the corridor is passed WHOLE to every tile,
 *    never pre-clipped, exactly like worldBounds);
 *  - minor-street seeds come from the position-hashed jittered grid over a
 *    halo-padded bbox (spatialHash.ts) — no generation-order dependence;
 *  - streamlines are fixed-step (no dsep collision termination) and clipping
 *    is Liang-Barsky, so a street crossing a tile edge gets bit-identical
 *    boundary points from both tiles.
 */
import { hashSeed } from "../rng";
import type { BBox } from "../spatialHash";
import { cellRng, expandBBox, jitteredGridPoints } from "../spatialHash";
import type { GenerationConstraints } from "../types";
import { clipPolylineToBBox, type Vec2 } from "../clip";
import { traceStreamline, type AngleSampler } from "./streamlines";
import { buildTensorField, sampleFieldAngle, type TensorFieldParams } from "./tensorField";

type Pt = [number, number];

// Tuning within docs/06 §3 ranges, denser than the ambient street grid — a
// GM-drawn avenue implies a built-up corridor.
export const CORRIDOR_SMOOTH_ITERATIONS = 2;
export const CORRIDOR_SEED_CELL_SIZE = 40;
export const CORRIDOR_STEP_SIZE = 8;
export const CORRIDOR_MAX_STEPS = 10;
/** Same seam-safety invariant as STREET_HALO: must cover the longest possible
 * streamline half-length so an edge-crossing street is seeded inside both
 * neighbors' halos. */
export const CORRIDOR_HALO = CORRIDOR_STEP_SIZE * CORRIDOR_MAX_STEPS;
/** Minor streets only spawn within this distance of the corridor — the
 * elaboration hugs the sketch instead of carpeting the whole tile. */
export const CORRIDOR_INFLUENCE = 140;
/** Distance decay of the corridor-alignment tensor basis. */
export const CORRIDOR_FALLOFF = 60;
/** Corridor basis weight at distance 0 (base field weight is 1) — near the
 * avenue the network aligns to it; far away it relaxes to the ambient grid. */
export const CORRIDOR_ALIGN_STRENGTH = 3;

/**
 * Chaikin corner-cutting (simple sketch smoothing): each pass
 * replaces every segment with its 1/4 and 3/4 points, keeping the endpoints.
 * Pure floating-point arithmetic on the input — deterministic.
 */
export function chaikinSmooth(coords: Pt[], iterations: number): Pt[] {
  let pts = coords;
  for (let it = 0; it < iterations; it++) {
    if (pts.length < 3) break;
    const next: Pt[] = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[i + 1];
      next.push([ax * 0.75 + bx * 0.25, ay * 0.75 + by * 0.25]);
      next.push([ax * 0.25 + bx * 0.75, ay * 0.25 + by * 0.75]);
    }
    next.push(pts[pts.length - 1]);
    pts = next;
  }
  return pts;
}

/** Distance to — and direction of — the nearest corridor segment. Strict `<`
 * keeps the first of tied segments: deterministic tie-breaking. */
function nearestSegment(corridor: Pt[], x: number, y: number): { dist: number; angle: number } {
  let best = { dist: Infinity, angle: 0 };
  for (let i = 0; i < corridor.length - 1; i++) {
    const [ax, ay] = corridor[i];
    const [bx, by] = corridor[i + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
    const qx = ax + t * dx;
    const qy = ay + t * dy;
    const dist = Math.hypot(x - qx, y - qy);
    if (dist < best.dist) best = { dist, angle: Math.atan2(dy, dx) };
  }
  return best;
}

/**
 * Blends the corridor-alignment basis into the base tensor field using the
 * same line-field tensor summation as tensorField.ts (angles are mod-pi, so
 * they must be summed as {cos2t, sin2t} tensors, not averaged directly).
 * A pure function of world coordinates + constant inputs — seam-safe.
 */
function corridorAngleSampler(base: TensorFieldParams, corridor: Pt[]): AngleSampler {
  return (x, y) => {
    const baseAngle = sampleFieldAngle(base, x, y);
    const near = nearestSegment(corridor, x, y);
    const w = CORRIDOR_ALIGN_STRENGTH * Math.exp(-near.dist / CORRIDOR_FALLOFF);
    const a = Math.cos(2 * baseAngle) + w * Math.cos(2 * near.angle);
    const b = Math.sin(2 * baseAngle) + w * Math.sin(2 * near.angle);
    return Math.atan2(b, a) / 2;
  };
}

function pointsOf(feature: GeoJSON.Feature): Pt[] {
  const g = feature.geometry;
  if (g.type === "Point") return [g.coordinates as Pt];
  return [];
}

function toVec2(pts: Pt[]): Vec2[] {
  return pts.map(([x, y]) => ({ x, y }));
}

/**
 * `(seed, bbox, corridor, constraints) => Feature[]` — the corridor is an
 * extra deterministic input alongside the seed. Callers MUST pass the whole
 * drawn
 * corridor to every tile (like worldBounds, never the tile's clipped view of
 * it), or adjacent tiles would derive different fields and break seams.
 */
export function generateCorridorStreets(
  campaignSeed: number,
  bbox: BBox,
  corridor: GeoJSON.LineString,
  constraints: GenerationConstraints
): GeoJSON.Feature[] {
  const raw = corridor.coordinates as Pt[];
  if (raw.length < 2) return [];
  // Corridor identity: same corridor → same ids forever; two different
  // corridors through the same cell → distinct ids and distinct street rolls.
  const corridorId = hashSeed(campaignSeed, "sketch-corridor", JSON.stringify(raw));

  const smoothed = chaikinSmooth(raw, CORRIDOR_SMOOTH_ITERATIONS);
  const features: GeoJSON.Feature[] = [];

  // 1) The corridor itself, smoothed, as the major avenue.
  clipPolylineToBBox(toVec2(smoothed), bbox).forEach((part, partIndex) => {
    if (part.length < 2) return;
    features.push({
      type: "Feature",
      id: hashSeed(corridorId, "avenue", partIndex),
      geometry: { type: "LineString", coordinates: part.map((p) => [p.x, p.y]) },
      properties: {
        generated: true,
        generatorId: "sketch-corridor",
        type: "street(named)",
        roadClass: "major",
      },
    });
  });

  // 2) Branching minor streets: grid seeds near the corridor, traced through
  // the corridor-blended field — mostly perpendicular ribs, some parallels.
  const field = buildTensorField(campaignSeed, constraints.worldBounds);
  const parallel = corridorAngleSampler(field, smoothed);
  const perpendicular: AngleSampler = (x, y) => parallel(x, y) + Math.PI / 2;

  const haloBBox = expandBBox(bbox, CORRIDOR_HALO);
  const seeds = jitteredGridPoints(campaignSeed, haloBBox, CORRIDOR_SEED_CELL_SIZE, `corridor-seed-${corridorId}`);
  const canonPoints = (constraints.canonFeatures ?? []).flatMap(pointsOf);

  for (const seed of seeds) {
    const near = nearestSegment(smoothed, seed.x, seed.y);
    if (near.dist > CORRIDOR_INFLUENCE) continue;
    // Canon geometry is never overwritten by generators (CLAUDE.md).
    const tooCloseToCanon = canonPoints.some(
      ([cx, cy]) => Math.hypot(cx - seed.x, cy - seed.y) < CORRIDOR_SEED_CELL_SIZE * 0.5
    );
    if (tooCloseToCanon) continue;

    const rng = cellRng(campaignSeed, seed.cellX, seed.cellY, `corridor-kind-${corridorId}`);
    // Seeds sitting on the avenue always branch off it (a parallel there
    // would just re-trace the avenue); farther out, a seeded mix.
    const usePerpendicular = near.dist < 15 || rng() < 0.65;
    const line = traceStreamline(usePerpendicular ? perpendicular : parallel, seed, {
      stepSize: CORRIDOR_STEP_SIZE,
      maxSteps: CORRIDOR_MAX_STEPS,
      bounds: haloBBox,
    });
    if (line.length < 2) continue;

    clipPolylineToBBox(line, bbox).forEach((part, partIndex) => {
      if (part.length < 2) return;
      features.push({
        type: "Feature",
        id: hashSeed(corridorId, seed.cellX, seed.cellY, "corridor-street", partIndex),
        geometry: { type: "LineString", coordinates: part.map((p) => [p.x, p.y]) },
        properties: {
          generated: true,
          generatorId: "sketch-corridor",
          type: "street(named)",
          roadClass: "minor",
        },
      });
    });
  }

  // Canonical order (same rule as generateCityStreets): output must never
  // depend on incidental iteration order.
  features.sort((a, b) => {
    const ca = (a.geometry as GeoJSON.LineString).coordinates[0];
    const cb = (b.geometry as GeoJSON.LineString).coordinates[0];
    return ca[0] - cb[0] || ca[1] - cb[1];
  });
  return features;
}
