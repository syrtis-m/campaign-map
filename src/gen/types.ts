import type { BBox } from "./spatialHash";
import type { NamingGenre } from "./naming/culture";
import type { FabricFeature } from "../model/fabric";

/**
 * Shared constraints contract for every Phase 3+ generator: `(seed, bbox,
 * constraints) => Feature[]`. Threaded from line one (not retrofitted) per
 * docs/02 §5 — canon geometry feeds generators as constraints, and generators
 * never overwrite canon.
 */
export interface GenerationConstraints {
  /** Campaign's fixed bounds (its `.map.md` bbox) — constant across every
   * tile request. Fields/singularities must derive position from this, never
   * from the tile bbox being generated, or adjacent tiles diverge. */
  worldBounds: BBox;
  /** Existing canon location features in or near the requested tile+halo.
   * Generators route around them; regeneration never touches them. */
  canonFeatures?: GeoJSON.Feature[];
  /** ALL sketched fabric (plan 019 Phase 3) — same coordinate space as
   * worldBounds, passed WHOLE to every tile (never pre-clipped, like a
   * corridor in plan 014) or adjacent tiles would derive different fields
   * and break seams. Water/rivers block streets and district sites; roads
   * steer the street field; walls stop streets. Sketched districts are NOT
   * constraints since plan 020 — a district polygon is a procgen REGION
   * (the container generation runs inside), handled by the region/registry
   * machinery, not by this list's constraint index. `fabric.ts` is a pure
   * zod leaf, so this import keeps generators host-agnostic. */
  fabricFeatures?: FabricFeature[];
  /** Naming culture genre for any generator that pre-names its output (e.g.
   * settlements) — defaults per-generator if omitted. */
  namingGenre?: NamingGenre;
  /** Restricts naming to a campaign's chosen culture ids (map-naming-cultures
   * frontmatter) — see culturesForGenre's restrictTo. Omit for the full
   * genre set. */
  namingCultureIds?: string[];
  /** City-domain arterial destinations (procgen v3 §5.0): `world-route`
   * endpoints near the domain, threaded WHOLE by the host from `world-route`
   * output when present. Position-hashed already, so passing them keeps the
   * network a pure function of its inputs (D6). When absent, the citynet
   * skeleton falls back to hashed compass bearings. `x`/`y` are world-space
   * meters (same space as `worldBounds`); `bearing` is the route's approach
   * angle in radians. Read only by `src/gen/citynet/` — never by tile-scoped
   * generators. */
  routeHints?: { x: number; y: number; bearing: number }[];
}
