/**
 * City domains (procgen v3 §3.1): the unit of city generation is no longer the
 * tile but a bounded disc — center, radius, profile — recorded in the manifest
 * as part of the GM's request. The whole street network is computed once per
 * domain as a pure function of `(campaignSeed, domain, constraints)`; every
 * tile that overlaps the domain clips its bbox from that one artifact. That is
 * how seam-safety survives a *sequential* generator: adjacent tiles don't need
 * order-free math to agree — they agree because they clip the same bytes.
 *
 * Determinism argument for this module: a domain's identity and seed are
 * derived only from its center snapped to a fixed 30 m lattice (D1/D6 — no
 * floating-point center ever reaches the seed, no host-side field like
 * `createdAt` ever crosses into generation). Two GM clicks that snap to the
 * same lattice cell address the same domain and the same `citySeed`, so the
 * same city regenerates forever — position-keyed like everything else in
 * `src/gen/` (see `spatialHash.ts`).
 */
import { hashSeed } from "../rng";
import type { BBox } from "../spatialHash";

/** Center-snapping lattice for domains: a click is quantized to this grid so
 * near-identical clicks resolve to one domain (D1 — center is lattice-exact). */
export const DOMAIN_LATTICE_M = 30;
/** Default disc radius when the GM doesn't specify one. */
export const DOMAIN_DEFAULT_RADIUS_M = 900;
/** Clamp range for a domain radius (host validates; documented here as the
 * generator's supported envelope). Matches the manifest zod bounds' spirit. */
export const DOMAIN_MIN_RADIUS_M = 400;
export const DOMAIN_MAX_RADIUS_M = 1500;

export type ProfileId = "euro-medieval" | "euro-continental" | "na-grid" | "na-suburb";

export interface CityDomain {
  /** `dom:<anchorCellX>:<anchorCellY>` — stable, position-keyed. */
  id: string;
  /** Center in generation-space meters, snapped to the 30 m lattice. */
  cx: number;
  cy: number;
  /** Disc radius in meters (400–1500). */
  radius: number;
  profile: ProfileId;
  /** Host-side creation timestamp. Never read by any generator (D6). */
  createdAt: number;
}

/** Snap a scalar to the 30 m lattice: `Math.round(v/30)*30`. */
export function snapToLattice(v: number): number {
  return Math.round(v / DOMAIN_LATTICE_M) * DOMAIN_LATTICE_M;
}

/** The 30 m lattice cell of the *snapped* point (integer cell coordinates). */
export function anchorCellForPoint(x: number, y: number): { cellX: number; cellY: number } {
  return {
    cellX: Math.round(snapToLattice(x) / DOMAIN_LATTICE_M),
    cellY: Math.round(snapToLattice(y) / DOMAIN_LATTICE_M),
  };
}

/** Position-keyed domain id from a lattice cell. */
export function domainIdForCell(cellX: number, cellY: number): string {
  return `dom:${cellX}:${cellY}`;
}

/**
 * Build a domain from a raw click point: the center is snapped to the lattice
 * (so the id and the seed are lattice-exact) and the id is derived from that
 * snapped cell. `createdAt` is carried through untouched for the host — never
 * consulted by generation.
 */
export function makeDomain(
  x: number,
  y: number,
  radius: number,
  profile: ProfileId,
  createdAt: number
): CityDomain {
  const { cellX, cellY } = anchorCellForPoint(x, y);
  return {
    id: domainIdForCell(cellX, cellY),
    cx: snapToLattice(x),
    cy: snapToLattice(y),
    radius,
    profile,
    createdAt,
  };
}

/**
 * The domain's `citySeed`: `hashSeed(campaignSeed, "domain", cellX, cellY)`.
 * Derived from the lattice cell, not the float center — the single hinge that
 * makes "same click region → same city, forever" hold (D1/D6).
 */
export function citySeedFor(campaignSeed: number, domain: CityDomain): number {
  const { cellX, cellY } = anchorCellForPoint(domain.cx, domain.cy);
  return hashSeed(campaignSeed, "domain", cellX, cellY);
}

/** Is `(x,y)` inside the domain disc (inclusive of the boundary)? */
export function pointInDomain(d: CityDomain, x: number, y: number): boolean {
  return Math.hypot(x - d.cx, y - d.cy) <= d.radius;
}

/** Do two domain discs intersect? (Overlap is rejected at the host; §10.) */
export function domainsOverlap(a: CityDomain, b: CityDomain): boolean {
  return Math.hypot(a.cx - b.cx, a.cy - b.cy) < a.radius + b.radius;
}

/** World bbox of the domain disc, optionally grown by `margin` meters (the
 * cost field uses a 200 m margin so A* can bend just outside the disc). */
export function domainBBox(d: CityDomain, margin = 0): BBox {
  return {
    minX: d.cx - d.radius - margin,
    minY: d.cy - d.radius - margin,
    maxX: d.cx + d.radius + margin,
    maxY: d.cy + d.radius + margin,
  };
}
