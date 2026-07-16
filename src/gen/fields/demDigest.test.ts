import { describe, it, expect } from "vitest";
import { perTileTerrainDigest, tileLngLatBounds, riverCarveReach, carveReachEnvelope } from "./index";
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

  it("editing a river does NOT change a far tile's digest (scoped carve reach, 2026-07-16)", () => {
    // River sits under LEFT; a tile several tile-widths away is provably beyond
    // its carve reach, so the river never enters that tile's digest — and a
    // spine edit leaves it byte-identical (cache hit).
    const river = riverAt("W", [insideLeft[0] - 50, insideLeft[1]], [insideLeft[0] + 50, insideLeft[1]]);
    const digestFar = (feats: FabricFeature[]) => perTileTerrainDigest(feats, BASE, SEED, false, TZ, TX + 3, TY, SCALE, K);
    // Sanity: the far tile really is beyond the provable reach for this setup.
    const reach = riverCarveReach(river, carveReachEnvelope([river], BASE));
    const farWest = tileLngLatBounds(TZ, TX + 3, TY).west * SCALE;
    expect(farWest - (insideLeft[0] + 50)).toBeGreaterThan(reach);
    expect(digestFar([river])).toBe(digestFar([]));
    const edited = riverAt("W", [insideLeft[0] - 50, insideLeft[1] + 1], [insideLeft[0] + 50, insideLeft[1]]);
    expect(digestFar([edited])).toBe(digestFar([]));
  });

  it("a river IS in the digest of a tile within its provable reach, and editing it re-derives that tile", () => {
    const river = riverAt("W", [insideLeft[0] - 50, insideLeft[1]], [insideLeft[0] + 50, insideLeft[1]]);
    const withRiver = digestLeft([river]);
    expect(withRiver).not.toBe(digestLeft([]));
    const edited = riverAt("W", [insideLeft[0] - 50, insideLeft[1] + 1], [insideLeft[0] + 50, insideLeft[1]]);
    expect(digestLeft([edited])).not.toBe(withRiver);
  });

  it("NO false-miss at the river reach boundary: a spine just inside reach of a tile is in its digest", () => {
    const edgeX = LEFT.west * SCALE;
    const mk = (gap: number) => riverAt("W", [edgeX - gap - 100, insideLeft[1]], [edgeX - gap, insideLeft[1]]);
    const probe = mk(0);
    const reach = riverCarveReach(probe, carveReachEnvelope([probe], BASE));
    const empty = digestLeft([]);
    // Just INSIDE reach ⇒ must be present (its carve can provably move this tile).
    expect(digestLeft([mk(Math.max(0, reach - 50))])).not.toBe(empty);
    // Well OUTSIDE reach ⇒ omitted (a true no-op for this tile).
    expect(digestLeft([mk(reach + 50)])).toBe(empty);
  });

  it("BED INPUTS: a stamp near the SPINE re-derives a far tile the river reaches (through the bed), and only then", () => {
    // A river crossing from LEFT into RIGHT; a small relief near its LEFT end.
    // The relief's own support never reaches the RIGHT tile — but the carve's
    // bed samples the surface along the spine, so editing the relief changes
    // the RIGHT tile's bytes wherever the carve is active there.
    const river = riverAt("W", [insideLeft[0], insideLeft[1]], [insideRight[0], insideRight[1]]);
    const reliefNearSpine = reliefAt("R", [insideLeft[0], insideLeft[1] + 20], 100);
    const before = digestRight([river, reliefNearSpine]);
    const editedRelief = reliefAt("R", [insideLeft[0], insideLeft[1] + 20], 100, 900);
    expect(digestRight([river, editedRelief])).not.toBe(before); // bed input ⇒ re-derive
    // Control: WITHOUT the river, the same far relief edit leaves RIGHT untouched.
    expect(digestRight([editedRelief])).toBe(digestRight([reliefNearSpine]));
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

// ─── Soundness of the carve reach bound itself ───────────────────────────────
// The digest tests above prove the STRING mechanics; this proves the CLAIM the
// bound rests on: the composed field with the river is BYTE-IDENTICAL to the
// field without it everywhere beyond `riverCarveReach` of the sketched spine —
// under deliberately worst-case terrain (max-height relief ON the spine raising
// `pre`, a deep per-vertex depth override lowering the bed, wind+braid pushing
// the meandered centerline as far off-spine as the params allow).
import { terrainAt } from "./index";

describe("riverCarveReach — provable inertness beyond the bound", () => {
  it("field with river === field without river at every sample beyond reach (worst-case stamps)", () => {
    const y0 = 0;
    const spine: [number, number][] = [[-400, y0], [0, y0], [400, y0]];
    const river: FabricFeature = {
      type: "Feature",
      id: "W",
      geometry: { type: "LineString", coordinates: spine },
      properties: {
        kind: "river",
        procgen: {
          algorithm: "river",
          seed: 11,
          version: 2,
          params: { width: 30, windiness: 1, braiding: 1, widthGrowth: 0.5, depths: [400, 400, 400] },
        },
      },
    } as FabricFeature;
    // Max-height ridge right along the spine: raises `pre` near the channel so
    // the gorge wall must climb as far as the params ever allow.
    const ridge: FabricFeature = {
      type: "Feature",
      id: "R",
      geometry: { type: "LineString", coordinates: [[-400, y0 + 10], [400, y0 + 10]] },
      properties: {
        kind: "relief",
        procgen: { algorithm: "relief", seed: 2, version: 1, params: { polarity: "ridge", height: 4000, halfWidth: 300, apron: 100 } },
      },
    } as FabricFeature;
    const base = { campAmp: 200, seaDatum: 50 };
    const seed = 123;
    const env = carveReachEnvelope([river, ridge], base);
    const reach = riverCarveReach(river, env);

    const withRiver = terrainAt([river, ridge], { base, campaignSeed: seed });
    const without = terrainAt([ridge], { base, campaignSeed: seed });

    // Sample a dense ring of points just past the reach from the spine BBOX
    // (minX -400, maxX 400, y = y0): the bound is measured from the sketched
    // bbox, so any point at bbox-distance > reach must be untouched.
    let checked = 0;
    for (let i = 0; i < 72; i++) {
      const ang = (i / 72) * 2 * Math.PI;
      for (const extra of [1, 50, 500]) {
        const d = reach + extra;
        // Project outward from the bbox: start at the bbox edge nearest the
        // direction, then step `d` along it.
        const cx = Math.cos(ang) >= 0 ? 400 : -400;
        const px = cx + Math.cos(ang) * d;
        const py = y0 + Math.sin(ang) * d;
        // Only keep samples whose true bbox distance exceeds the reach (interior
        // projections along ±x can land closer than d to the other edge).
        const dx = px < -400 ? -400 - px : px > 400 ? px - 400 : 0;
        const dy = Math.abs(py - y0);
        if (Math.hypot(dx, dy) <= reach) continue;
        const a = withRiver(px, py);
        const b = without(px, py);
        expect(a.v).toBe(b.v);
        expect(a.dx).toBe(b.dx);
        expect(a.dy).toBe(b.dy);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100); // the ring actually sampled

    // Sanity that the test bites: ON the spine the carve must move the field.
    const on = withRiver(0, y0);
    const off = without(0, y0);
    expect(on.v).not.toBe(off.v);
  });
});
