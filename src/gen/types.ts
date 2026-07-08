import type { BBox } from "./spatialHash";

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
}
