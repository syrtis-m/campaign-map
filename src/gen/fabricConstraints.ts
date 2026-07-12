/**
 * Sketched-fabric constraints for generators (plan 019, Phase 3): the GM's
 * hand-drawn background geometry (Fabric.geojson) feeds every generator run
 * — sketch a river, regenerate, streets stop at the water; sketch a road,
 * the street network aligns to it (generalizing plan 014's corridor
 * elaboration to *every* sketched road).
 *
 * Pure/headless (no DOM/map/Obsidian imports) and seam-safe by construction:
 * every predicate here is a pure function of world coordinates + the WHOLE
 * fabric collection (callers pass all features to every tile, identical
 * inputs like `worldBounds`) — never of tile identity or generation order.
 */
import type { FabricFeature } from "../model/fabric";
import type { AngleSampler } from "./city/streamlines";
import { sampleFieldAngle, type TensorFieldParams } from "./city/tensorField";

type Pt = [number, number];

/** Rivers are lines; streets treat them as water within this half-width. */
export const RIVER_HALF_WIDTH = 15;
/** Road-alignment tensor weight/decay — same values as plan 014's corridor
 * blend (corridor.ts), so a sketched road steers streets the way a
 * generate-mode corridor used to. */
export const ROAD_ALIGN_STRENGTH = 3;
export const ROAD_FALLOFF = 60;

export interface FabricConstraintIndex {
  waterRings: Pt[][];
  riverLines: Pt[][];
  roadLines: Pt[][];
  wallLines: Pt[][];
}

const EMPTY: FabricConstraintIndex = {
  waterRings: [],
  riverLines: [],
  roadLines: [],
  wallLines: [],
};

/** Buckets fabric features by the constraint role their kind plays. Park
 * polygons impose nothing on generators (streets through a park are fine).
 * District polygons impose nothing either since plan 020: a district is a
 * PROCGEN REGION — the container city generation runs inside — not a
 * constraint on it (the plan-019 ward-site exclusion is retired). */
export function indexFabricConstraints(features: FabricFeature[] | undefined): FabricConstraintIndex {
  if (!features || features.length === 0) return EMPTY;
  const idx: FabricConstraintIndex = {
    waterRings: [],
    riverLines: [],
    roadLines: [],
    wallLines: [],
  };
  for (const f of features) {
    const g = f.geometry;
    if (f.properties.kind === "water" && g.type === "Polygon") {
      idx.waterRings.push(g.coordinates[0] as Pt[]);
    } else if (f.properties.kind === "river" && g.type === "LineString") {
      idx.riverLines.push(g.coordinates as Pt[]);
    } else if (f.properties.kind === "road" && g.type === "LineString") {
      idx.roadLines.push(g.coordinates as Pt[]);
    } else if (f.properties.kind === "wall" && g.type === "LineString") {
      idx.wallLines.push(g.coordinates as Pt[]);
    }
  }
  return idx;
}

/** Ray-cast point-in-polygon — pure arithmetic on the ring, deterministic. */
export function pointInRing(ring: Pt[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Distance to — and direction of — the nearest segment of `line`. Strict
 * `<` keeps the first of tied segments: deterministic tie-breaking (same
 * contract as corridor.ts's nearestSegment). */
export function nearestOnLine(line: Pt[], x: number, y: number): { dist: number; angle: number } {
  let best = { dist: Infinity, angle: 0 };
  for (let i = 0; i < line.length - 1; i++) {
    const [ax, ay] = line[i];
    const [bx, by] = line[i + 1];
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

/** Inside a sketched water polygon, or within a river's half-width. */
export function blockedByWater(idx: FabricConstraintIndex, x: number, y: number): boolean {
  for (const ring of idx.waterRings) {
    if (pointInRing(ring, x, y)) return true;
  }
  for (const line of idx.riverLines) {
    if (nearestOnLine(line, x, y).dist < RIVER_HALF_WIDTH) return true;
  }
  return false;
}

function segmentsIntersect(p1: Pt, p2: Pt, p3: Pt, p4: Pt): boolean {
  const d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0]);
  if (d === 0) return false; // parallel/collinear: treated as non-blocking (deterministic either way)
  const t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d;
  const u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

/** Does the segment a→b cross any sketched wall? Streets stop at walls. */
export function crossesWall(idx: FabricConstraintIndex, a: Pt, b: Pt): boolean {
  for (const wall of idx.wallLines) {
    for (let i = 0; i < wall.length - 1; i++) {
      if (segmentsIntersect(a, b, wall[i], wall[i + 1])) return true;
    }
  }
  return false;
}

/**
 * Cuts a traced streamline where it enters water or crosses a wall, keeping
 * the longest clear run (first of ties — deterministic). "Longest run", not
 * "prefix": a trace is backward-tail → seed → forward-tail, so a prefix cut
 * would discard a whole street just because its far tail started in a lake.
 * The trace itself is identical on every tile (same seed, same field), so
 * the cut points are too — seam-safe.
 */
export function truncateAtBarriers<P extends { x: number; y: number }>(
  idx: FabricConstraintIndex,
  line: P[]
): P[] {
  const hasWater = idx.waterRings.length > 0 || idx.riverLines.length > 0;
  const hasWalls = idx.wallLines.length > 0;
  if (!hasWater && !hasWalls) return line;

  let best: P[] = [];
  let current: P[] = [];
  const commit = (): void => {
    if (current.length > best.length) best = current;
    current = [];
  };
  for (const p of line) {
    if (hasWater && blockedByWater(idx, p.x, p.y)) {
      commit();
      continue;
    }
    if (hasWalls && current.length > 0) {
      const prev = current[current.length - 1];
      if (crossesWall(idx, [prev.x, prev.y], [p.x, p.y])) commit();
    }
    current.push(p);
  }
  commit();
  return best;
}

/**
 * Blends nearest-sketched-road alignment into the base tensor field, using
 * the same mod-pi tensor summation as corridor.ts (angles must be summed as
 * {cos2t, sin2t}, never averaged directly). Returns null when there are no
 * sketched roads so callers can keep the cheaper raw-field path.
 */
export function fabricAngleSampler(
  base: TensorFieldParams,
  idx: FabricConstraintIndex
): AngleSampler | null {
  if (idx.roadLines.length === 0) return null;
  return (x, y) => {
    const baseAngle = sampleFieldAngle(base, x, y);
    let a = Math.cos(2 * baseAngle);
    let b = Math.sin(2 * baseAngle);
    for (const road of idx.roadLines) {
      const near = nearestOnLine(road, x, y);
      const w = ROAD_ALIGN_STRENGTH * Math.exp(-near.dist / ROAD_FALLOFF);
      a += w * Math.cos(2 * near.angle);
      b += w * Math.sin(2 * near.angle);
    }
    return Math.atan2(b, a) / 2;
  };
}
