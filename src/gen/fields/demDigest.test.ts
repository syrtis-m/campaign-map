import { describe, it, expect } from "vitest";
import { perTileTerrainDigest, tileLngLatBounds } from "./index";
import type { FabricFeature } from "../../model/fabric";

/**
 * Per-tile DEM digest — scoped cache invalidation (the extrude-latency fix). An
 * edit to one stamp must change ONLY the digests of tiles that stamp actually
 * reaches; every other tile keeps its digest (⇒ cache hit ⇒ zero recompute). And
 * a stamp whose support ENTERS a tile must always be in that tile's digest (no
 * false-miss / stale bytes).
 */

const SCALE = 50;
const K = 25;
const BASE = { campAmp: 0, seaDatum: 0 };
const SEED = 7;

// Two adjacent tiles at z6. Gen-space bbox = lng/lat·SCALE.
const TZ = 6;
const TX = 24;
const TY = 36;
const LEFT = tileLngLatBounds(TZ, TX, TY);
const RIGHT = tileLngLatBounds(TZ, TX + 1, TY);
// A point comfortably inside the LEFT tile, and one inside the RIGHT tile.
const insideLeft: [number, number] = [((LEFT.west + LEFT.east) / 2) * SCALE, ((LEFT.north + LEFT.south) / 2) * SCALE];
const insideRight: [number, number] = [((RIGHT.west + RIGHT.east) / 2) * SCALE, ((RIGHT.north + RIGHT.south) / 2) * SCALE];

function reliefAt(id: string, center: [number, number], halfWidth: number, height = 200): FabricFeature {
  const [cx, cy] = center;
  return {
    type: "Feature",
    id,
    geometry: { type: "LineString", coordinates: [[cx - 5, cy], [cx + 5, cy]] },
    properties: { kind: "relief", procgen: { algorithm: "relief", seed: 1, version: 1, params: { polarity: "ridge", height, halfWidth, apron: 0 } } },
  } as FabricFeature;
}

function mountainAt(id: string, center: [number, number], half: number): FabricFeature {
  const [cx, cy] = center;
  return {
    type: "Feature",
    id,
    geometry: { type: "Polygon", coordinates: [[[cx - half, cy - half], [cx + half, cy - half], [cx + half, cy + half], [cx - half, cy + half], [cx - half, cy - half]]] },
    properties: { kind: "mountain", procgen: { algorithm: "mountain", seed: 3, version: 1, params: { terrain: "alpine", amplitude: 0.8, roughness: 0.5 } } },
  } as FabricFeature;
}

function riverAt(id: string, a: [number, number], b: [number, number]): FabricFeature {
  return {
    type: "Feature",
    id,
    geometry: { type: "LineString", coordinates: [a, b] },
    properties: { kind: "river", procgen: { algorithm: "river", seed: 9, version: 2, params: { width: 12 } } },
  } as FabricFeature;
}

const digestLeft = (feats: FabricFeature[]) => perTileTerrainDigest(feats, BASE, SEED, false, TZ, TX, TY, SCALE, K);
const digestRight = (feats: FabricFeature[]) => perTileTerrainDigest(feats, BASE, SEED, false, TZ, TX + 1, TY, SCALE, K);

describe("perTileTerrainDigest — scoped invalidation", () => {
  it("editing a stamp under one tile does NOT change a far tile's digest (the extrude win)", () => {
    const far = reliefAt("R", insideLeft, 100); // small reach, only under LEFT
    const near = mountainAt("M", insideRight, 2 * SCALE); // under RIGHT
    const before = digestRight([far, near]);
    // Edit the far (LEFT) stamp: bump its height param.
    const farEdited = reliefAt("R", insideLeft, 100, 900);
    const after = digestRight([farEdited, near]);
    expect(after).toBe(before); // RIGHT tile untouched ⇒ cache hit
  });

  it("editing a stamp under a tile DOES change that tile's digest (it re-derives)", () => {
    const stamp = reliefAt("R", insideLeft, 100);
    const before = digestLeft([stamp]);
    const edited = reliefAt("R", insideLeft, 100, 900);
    const after = digestLeft([edited]);
    expect(after).not.toBe(before);
  });

  it("is stable across feature enumeration order (the fold discipline)", () => {
    const a = reliefAt("A", insideLeft, 80);
    const b = mountainAt("B", insideLeft, 1 * SCALE);
    const c = riverAt("C", [insideLeft[0] - 50, insideLeft[1]], [insideLeft[0] + 50, insideLeft[1]]);
    expect(digestLeft([a, b, c])).toBe(digestLeft([c, a, b]));
    expect(digestLeft([a, b, c])).toBe(digestLeft([b, c, a]));
  });

  it("a river is in EVERY tile's digest (global — carve reach not soundly bounded)", () => {
    // River sits under LEFT; it must still appear in RIGHT's digest.
    const river = riverAt("W", [insideLeft[0] - 50, insideLeft[1]], [insideLeft[0] + 50, insideLeft[1]]);
    const withRiver = digestRight([river]);
    const without = digestRight([]);
    expect(withRiver).not.toBe(without);
    // And editing that river changes a far tile's digest (rivers are never scoped out).
    const edited = riverAt("W", [insideLeft[0] - 50, insideLeft[1] + 1], [insideLeft[0] + 50, insideLeft[1]]);
    expect(digestRight([edited])).not.toBe(withRiver);
  });

  it("NO false-miss: a relief whose reach ENTERS a tile is in that tile's digest even though its bbox is outside", () => {
    // Place a relief spine just OUTSIDE the LEFT tile's left edge, but with a
    // halfWidth large enough that its cross-profile reaches into the tile.
    const edgeX = LEFT.west * SCALE;
    const gap = 500; // meters outside the tile edge
    const spineCenter: [number, number] = [edgeX - gap, insideLeft[1]];
    const tooShort = reliefAt("S", spineCenter, gap - 50); // reach falls short ⇒ excluded
    const longEnough = reliefAt("S", spineCenter, gap + 200); // reach crosses in ⇒ included
    const empty = digestLeft([]);
    expect(digestLeft([tooShort])).toBe(empty); // outside reach ⇒ omitted (a true no-op)
    expect(digestLeft([longEnough])).not.toBe(empty); // reaches in ⇒ must be present
  });

  it("blockless / non-terrain features never enter the digest", () => {
    const empty = digestLeft([]);
    const sketch = { type: "Feature", id: "x", geometry: { type: "LineString", coordinates: [insideLeft, [insideLeft[0] + 10, insideLeft[1]]] }, properties: { kind: "river" } } as unknown as FabricFeature;
    expect(digestLeft([sketch])).toBe(empty);
  });
});
