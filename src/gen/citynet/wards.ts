/**
 * Wards: the district-Voronoi concept applies at ward scale only — a handful
 * of cells over Stage-A sites (plaza center + points along each arterial),
 * tagged market/craft/temple/slum by hash and waterfront adjacency, clipped to
 * the sketched region. Themes may tint them subtly; blocks do NOT derive from
 * wards (they come from faces.ts). A district polygon IS the city container, so
 * it never excludes its own ward sites.
 *
 * Region clipping: a CONVEX region ring is an exact Sutherland-Hodgman clip
 * target, so cells are clipped to it (the migrated 32-gon is convex). A CONCAVE
 * ring is not, so cells with ANY vertex outside the region are dropped whole —
 * deterministic but conservative; wards near concave notches are simply absent.
 * LIMITATION: a candidate for a later polygon-boolean pass. Determinism over
 * completeness.
 *
 * Determinism argument: sites are position-derived from the skeleton
 * (arc-length points on arterial polylines + the generation center),
 * canonically sorted and deduplicated before Delaunay (d3-delaunay is
 * deterministic for identical input arrays — same discipline as
 * `voronoiCells.ts`). Tags hash on the site's position key, never its index
 * in any incidental order (D2).
 */
import { Delaunay } from "d3-delaunay";
import { hashSeed, mulberry32, pick } from "../rng";
import { pointInRing } from "../fabricConstraints";
import { ensureClosedRing } from "../voronoiCells";
import { regionContains, ringIsConvex, type ProcgenRegion } from "../region";
import type { SkeletonOutput } from "./skeleton";

type Pt = [number, number];

/** Fractions of each arterial part's arc length where ward sites sit. */
export const WARD_SITE_FRACTIONS = [0.45, 0.8] as const;
/** Two sites closer than this merge (first in canonical order wins). */
export const WARD_SITE_MIN_SPACING_M = 60;
/** Hashed-pick ward tags; "gate" and "market" also arrive via adjacency
 * overrides (gate wards contain a wall gate; the market ward holds the plaza). */
export const WARD_TAGS = ["craft", "temple", "slum", "market"] as const;
export type WardTag = (typeof WARD_TAGS)[number] | "gate";

export interface Ward {
  /** Closed ring, world meters, inside the region. */
  ring: Pt[];
  tag: WardTag;
  /** Position-derived site identity (feature-id hash input). */
  siteKey: string;
}

/** Point at `frac` of a polyline's arc length. */
function pointAtFraction(coords: Pt[], frac: number): Pt | null {
  if (coords.length < 2) return null;
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    total += Math.hypot(coords[i][0] - coords[i - 1][0], coords[i][1] - coords[i - 1][1]);
  }
  if (total === 0) return null;
  let target = total * frac;
  for (let i = 1; i < coords.length; i++) {
    const seg = Math.hypot(coords[i][0] - coords[i - 1][0], coords[i][1] - coords[i - 1][1]);
    if (target <= seg) {
      const t = seg === 0 ? 0 : target / seg;
      return [
        coords[i - 1][0] + t * (coords[i][0] - coords[i - 1][0]),
        coords[i - 1][1] + t * (coords[i][1] - coords[i - 1][1]),
      ];
    }
    target -= seg;
  }
  return coords[coords.length - 1];
}

/** Sutherland-Hodgman clip of a ring against a convex CCW polygon. */
function clipToConvex(ring: Pt[], clip: Pt[]): Pt[] {
  let poly = ring;
  for (let i = 0; i < clip.length; i++) {
    if (poly.length === 0) break;
    const a = clip[i];
    const b = clip[(i + 1) % clip.length];
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const inside = (p: Pt): boolean => ex * (p[1] - a[1]) - ey * (p[0] - a[0]) >= 0;
    const out: Pt[] = [];
    for (let j = 0; j < poly.length; j++) {
      const curr = poly[j];
      const prev = poly[(j - 1 + poly.length) % poly.length];
      const ci = inside(curr);
      const pi = inside(prev);
      const cross = (p: Pt, q: Pt): Pt => {
        const denom = ex * (q[1] - p[1]) - ey * (q[0] - p[0]);
        const t = denom === 0 ? 0 : (ex * (a[1] - p[1]) - ey * (a[0] - p[0])) / denom;
        return [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])];
      };
      if (ci) {
        if (!pi) out.push(cross(prev, curr));
        out.push(curr);
      } else if (pi) {
        out.push(cross(prev, curr));
      }
    }
    poly = out;
  }
  return poly;
}

/**
 * Build the ward polygons for a region. Pure function of
 * (citySeed, region, skeleton).
 */
export function buildWards(citySeed: number, region: ProcgenRegion, skeleton: SkeletonOutput): Ward[] {
  // Sites: generation center + arc-length points along each arterial part.
  const raw: Pt[] = [skeleton.center];
  for (const art of skeleton.arterials) {
    for (const frac of WARD_SITE_FRACTIONS) {
      const p = pointAtFraction(art.coords, frac);
      if (p) raw.push(p);
    }
  }
  // Canonical order, then keep in-region sites, deduped by min spacing
  // (first of a cluster wins).
  raw.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const sites: Pt[] = [];
  for (const p of raw) {
    if (!regionContains(region, p[0], p[1])) continue;
    if (sites.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < WARD_SITE_MIN_SPACING_M)) continue;
    sites.push(p);
  }
  if (sites.length < 3) return [];

  const bbox = region.bbox;
  const delaunay = Delaunay.from(sites);
  const voronoi = delaunay.voronoi([bbox.minX, bbox.minY, bbox.maxX, bbox.maxY]);
  const convex = ringIsConvex(region.ring);
  const clipRing = region.ring.slice(0, -1); // open CCW ring for the convex clip

  const wards: Ward[] = [];
  sites.forEach((site, i) => {
    const cell = voronoi.cellPolygon(i) as Pt[] | null;
    if (!cell) return;
    let clipped: Pt[];
    if (convex) {
      clipped = clipToConvex(cell, clipRing);
    } else {
      // Concave v1 rule (module JSDoc): keep the cell only if every vertex is
      // inside the region — drop it whole otherwise.
      const open = cell.length >= 2 && cell[0][0] === cell[cell.length - 1][0] && cell[0][1] === cell[cell.length - 1][1]
        ? cell.slice(0, -1)
        : cell;
      clipped = open.every(([x, y]) => regionContains(region, x, y)) ? open : [];
    }
    if (clipped.length < 3) return;
    const siteKey = `${Math.round(site[0] * 100)},${Math.round(site[1] * 100)}`;

    // Tag priority: the generation-center cell = market; a cell containing a
    // wall gate = gate ward; waterfront-adjacent cells lean craft
    // (quays mean trade); the rest hash on the site position.
    let tag: WardTag;
    if (pointInRing(clipped, skeleton.center[0], skeleton.center[1])) {
      tag = "market";
    } else if (skeleton.wall && skeleton.wall.gates.some(([x, y]) => pointInRing(clipped, x, y))) {
      tag = "gate";
    } else if (
      skeleton.waterfront.some((w) => w.coords.some(([x, y]) => pointInRing(clipped, x, y)))
    ) {
      tag = "craft";
    } else {
      tag = pick(mulberry32(hashSeed(citySeed, "ward", siteKey)), WARD_TAGS);
    }
    wards.push({ ring: ensureClosedRing(clipped), tag, siteKey });
  });

  wards.sort(
    (a, b) => a.ring[0][0] - b.ring[0][0] || a.ring[0][1] - b.ring[0][1] || (a.siteKey < b.siteKey ? -1 : 1)
  );
  return wards;
}
