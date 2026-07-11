/**
 * Wards (procgen v3 §5.3.4): the district-Voronoi concept survives at ward
 * scale only — a handful of cells over Stage-A sites (plaza center + points
 * along each arterial), tagged market/craft/temple/slum by hash and
 * waterfront adjacency, clipped to the domain disc. Themes may tint them
 * subtly; blocks do NOT derive from wards (they come from faces.ts).
 *
 * Determinism argument: sites are position-derived from the skeleton
 * (arc-length points on arterial polylines + the domain center), canonically
 * sorted and deduplicated before Delaunay (d3-delaunay is deterministic for
 * identical input arrays — same discipline as `voronoiCells.ts`, which this
 * mirrors for explicit site lists instead of jittered-grid sites). Tags hash
 * on the site's position key, never its index in any incidental order (D2).
 */
import { Delaunay } from "d3-delaunay";
import { hashSeed, mulberry32, pick } from "../rng";
import { pointInRing } from "../fabricConstraints";
import { ensureClosedRing } from "../voronoiCells";
import type { CityDomain } from "./domain";
import { domainBBox } from "./domain";
import type { SkeletonOutput } from "./skeleton";

type Pt = [number, number];

/** Fractions of each arterial's arc length where ward sites sit. */
export const WARD_SITE_FRACTIONS = [0.45, 0.8] as const;
/** Two sites closer than this merge (first in canonical order wins). */
export const WARD_SITE_MIN_SPACING_M = 60;
/** Sides of the polygon approximating the domain disc for ward clipping. */
export const DISC_CLIP_SIDES = 48;
/** Hashed-pick ward tags; "gate" and "market" also arrive via adjacency
 * overrides (gate wards contain a wall gate; the market ward holds the plaza). */
export const WARD_TAGS = ["craft", "temple", "slum", "market"] as const;
export type WardTag = (typeof WARD_TAGS)[number] | "gate";

export interface Ward {
  /** Closed ring, world meters, clipped to the domain disc. */
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

/** Regular CCW polygon approximating the domain disc. */
function discPolygon(domain: CityDomain): Pt[] {
  const ring: Pt[] = [];
  for (let i = 0; i < DISC_CLIP_SIDES; i++) {
    const a = (i / DISC_CLIP_SIDES) * 2 * Math.PI;
    ring.push([domain.cx + domain.radius * Math.cos(a), domain.cy + domain.radius * Math.sin(a)]);
  }
  return ring;
}

/**
 * Build the ward polygons for a domain. Pure function of
 * (citySeed, domain, skeleton).
 */
export function buildWards(citySeed: number, domain: CityDomain, skeleton: SkeletonOutput): Ward[] {
  // Sites: plaza center + arc-length points along each arterial.
  const raw: Pt[] = [[domain.cx, domain.cy]];
  for (const art of skeleton.arterials) {
    for (const frac of WARD_SITE_FRACTIONS) {
      const p = pointAtFraction(art.coords, frac);
      if (p) raw.push(p);
    }
  }
  // Canonical order, then dedupe by min spacing (first of a cluster wins).
  raw.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const sites: Pt[] = [];
  for (const p of raw) {
    if (sites.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < WARD_SITE_MIN_SPACING_M)) continue;
    sites.push(p);
  }
  if (sites.length < 3) return [];

  const bbox = domainBBox(domain);
  const delaunay = Delaunay.from(sites);
  const voronoi = delaunay.voronoi([bbox.minX, bbox.minY, bbox.maxX, bbox.maxY]);
  const disc = discPolygon(domain);

  const wards: Ward[] = [];
  sites.forEach((site, i) => {
    const cell = voronoi.cellPolygon(i) as Pt[] | null;
    if (!cell) return;
    const clipped = clipToConvex(cell, disc);
    if (clipped.length < 3) return;
    const siteKey = `${Math.round(site[0] * 100)},${Math.round(site[1] * 100)}`;

    // Tag priority: plaza cell = market; a cell containing a wall gate =
    // gate ward (v3.3); waterfront-adjacent cells lean craft (quays mean
    // trade); the rest hash on the site position.
    let tag: WardTag;
    if (pointInRing(clipped, domain.cx, domain.cy)) {
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
