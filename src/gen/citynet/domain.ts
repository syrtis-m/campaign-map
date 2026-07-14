/**
 * City domains — v3's disc-shaped generation request, RETIRING under plan
 * 020: the sketched district polygon (a ProcgenRegion) is now the unit of
 * city generation, and this module shrinks to what the v4.1 migration and
 * the transitional host shim still need — the lattice/seed helpers that give
 * an existing manifest domain its stable identity, plus `discToRing`, which
 * converts a disc to the 32-gon district polygon the migration writes into
 * Fabric.geojson.
 *
 * Determinism argument (unchanged): a domain's identity and seed derive only
 * from its center snapped to a fixed 30 m lattice (D1/D6 — no floating-point
 * center ever reaches the seed, no host-side field like `createdAt` ever
 * crosses into generation). `citySeedFor` is kept for migration so the
 * migrated region inherits the SAME seed its disc had — the city keeps its
 * identity across the plan-020 migration.
 */
import { hashSeed } from "../rng";

/** Center-snapping lattice for domains: a click is quantized to this grid so
 * near-identical clicks resolve to one domain (D1 — center is lattice-exact). */
export const DOMAIN_LATTICE_M = 30;
/** Sides of the polygon a disc migrates to (plan 020 §3.2). */
export const DISC_TO_RING_SEGMENTS = 32;

export type ProfileId =
  | "euro-medieval"
  | "euro-continental"
  | "na-grid"
  | "na-suburb"
  | "superblock"
  | "tartan-grid"
  | "ward-grid"
  | "eixample"
  | "haussmann"
  | "baroque-axial";

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
 *
 * @deprecated v4.1 removes the disc founding path (plan 020 §8.1) — kept for
 * the pre-migration host and disc-fixture tests.
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
 * Derived from the lattice cell, not the float center. Kept for the v4.1
 * migration (plan 020 §3.2): the migrated district's persisted procgen seed
 * is this value, so the migrated city regenerates from the same seed.
 */
export function citySeedFor(campaignSeed: number, domain: CityDomain): number {
  const { cellX, cellY } = anchorCellForPoint(domain.cx, domain.cy);
  return hashSeed(campaignSeed, "domain", cellX, cellY);
}

/**
 * Convert a disc domain to the closed polygon ring its migrated district
 * sketch carries (plan 020 §3.2): a CCW `segments`-gon (default 32) around
 * `(cx, cy)` at `radius`, mm-quantized, closed (first === last). The trig
 * samples fixed fractions of the circle (D4 sampling); the ring is then
 * mm-exact data.
 */
export function discToRing(domain: CityDomain, segments = DISC_TO_RING_SEGMENTS): [number, number][] {
  const ring: [number, number][] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * 2 * Math.PI;
    ring.push([
      Math.round((domain.cx + domain.radius * Math.cos(a)) * 1000) / 1000,
      Math.round((domain.cy + domain.radius * Math.sin(a)) * 1000) / 1000,
    ]);
  }
  ring.push(ring[0]);
  return ring;
}
