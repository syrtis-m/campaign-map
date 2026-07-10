/**
 * Deterministic offline "populate this area" generator (plan 010 / docs/03
 * Phase 5's "LLM hook: populate this district with N shops" — no LLM, no
 * network call. Scatters `count` seeded points inside a bbox and asks the
 * caller's `nameFor` (culture-aware, see MapView.populateArea) to name each.
 * Pure: no DOM/map/Obsidian imports (CLAUDE.md generator contract).
 * Determinism is sacred: same (seed, bbox, type, count, salt) → identical
 * output forever.
 */
import type { BBox } from "./spatialHash";
import { hashSeed } from "./rng";

export interface PopulateSpec {
  seed: number;
  bbox: BBox;
  type: string;
  count: number;
  nameFor: (x: number, y: number) => string;
  /** Distinguishes independent populate runs over the same bbox/seed/count. */
  salt?: string;
}

export interface PopulatedLocation {
  name: string;
  type: string;
  point: [number, number];
}

export function populateArea(spec: PopulateSpec): PopulatedLocation[] {
  const { seed, bbox, type, count, nameFor } = spec;
  const salt = spec.salt ?? "populate";
  const out: PopulatedLocation[] = [];
  const w = bbox.maxX - bbox.minX;
  const h = bbox.maxY - bbox.minY;

  for (let i = 0; i < count; i++) {
    // hashSeed already returns a uint32 (>>> 0'd); normalize to [0, 1) the
    // same way mulberry32 does (divide by 2^32, not 0xffffffff, so the
    // result never rounds up to exactly 1 and escapes the bbox).
    const rx = hashSeed(seed, i, 0, salt) / 4294967296;
    const ry = hashSeed(seed, i, 1, salt) / 4294967296;
    const x = bbox.minX + rx * w;
    const y = bbox.minY + ry * h;
    out.push({ name: nameFor(x, y), type, point: [x, y] });
  }
  return out;
}
