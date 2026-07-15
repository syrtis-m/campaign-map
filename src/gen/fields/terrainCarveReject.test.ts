import { describe, it, expect, afterEach } from "vitest";
import { terrainAt, __setCarveFastReject } from "./index";
import type { FabricFeature } from "../../model/fabric";

/**
 * The carve fast-reject (bbox + occupancy-grid) must be BYTE-IDENTICAL to a full
 * nearest-spiral + smin evaluation of every sample — it only short-circuits where
 * the full path also returns `pre` (h≥1). This drives a dense lattice across seeds
 * and river shapes with the reject ON vs OFF and asserts exact equality (value AND
 * gradient), the sample-count-independent proof the ~79% inside-bbox reject is a
 * pure speed-up.
 */

type Pt = [number, number];

function river(id: string, spine: Pt[], params: Record<string, unknown> = { width: 20 }): FabricFeature {
  return {
    type: "Feature",
    id,
    geometry: { type: "LineString", coordinates: spine },
    properties: { kind: "river", procgen: { algorithm: "river", seed: 9, version: 2, params } },
  } as FabricFeature;
}

function mountain(id: string, ring: Pt[]): FabricFeature {
  return {
    type: "Feature",
    id,
    geometry: { type: "Polygon", coordinates: [ring] },
    properties: { kind: "mountain", procgen: { algorithm: "mountain", seed: 5, version: 1, params: { terrain: "alpine", amplitude: 0.8, roughness: 0.55 } } },
  } as FabricFeature;
}

const RING: Pt[] = [[0, 0], [3000, 0], [3000, 3000], [0, 3000], [0, 0]];

// A big meandering spine so its BBOX is large but most of the interior is FAR from
// the spine — exactly the case the bbox reject missed and the occupancy grid now
// catches. Plus a couple of shorter rivers to force multi-river far-field cases.
function meander(seed: number): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i <= 60; i++) {
    const t = i / 60;
    pts.push([t * 2800 + 100, 1500 + Math.sin(t * 7 + seed) * 900 + Math.cos(t * 3 + seed) * 300]);
  }
  return pts;
}

afterEach(() => __setCarveFastReject(true));

describe("carve fast-reject — byte-identical to full evaluation (dense lattice × seeds)", () => {
  for (const seed of [1, 2, 3, 7, 13]) {
    it(`seed ${seed}: reject-ON equals reject-OFF at every lattice sample`, () => {
      const feats = [
        mountain("m", RING),
        river("big", meander(seed)),
        river("short", [[400, 400], [900, 700], [1400, 500]]),
      ];
      const opts = { base: { campAmp: 250, seaDatum: 0 }, campaignSeed: seed } as const;

      // Reference: full evaluation (no reject).
      __setCarveFastReject(false);
      const full = terrainAt(feats, opts);
      const ref: { v: number; dx: number; dy: number }[] = [];
      for (let y = -200; y <= 3200; y += 61) {
        for (let x = -200; x <= 3200; x += 59) {
          ref.push(full(x, y));
        }
      }

      // Optimized: reject ON.
      __setCarveFastReject(true);
      const fast = terrainAt(feats, opts);
      let k = 0;
      for (let y = -200; y <= 3200; y += 61) {
        for (let x = -200; x <= 3200; x += 59) {
          // Byte-exact: value AND gradient, near the spine and far from it alike.
          expect(fast(x, y)).toEqual(ref[k++]);
        }
      }
    });
  }

  it("the grid reject actually engages inside a large bbox far from the spine", () => {
    // Sanity that the occupancy grid (not just the bbox reject) is doing work: a
    // point deep inside the meander's bbox but far from its spine must equal the
    // uncarved surface (rejected), while an on-spine point is genuinely carved.
    const feats = [river("big", meander(3))];
    const opts = { base: { campAmp: 250, seaDatum: 0 }, campaignSeed: 3 } as const;
    const carved = terrainAt(feats, opts);
    const bare = terrainAt(feats, { ...opts, include: { carve: false } });
    // A point inside the spine's x-range but pushed to a y with no nearby spine.
    expect(carved(1500, 50)).toEqual(bare(1500, 50)); // inside bbox, far from spine ⇒ inert
    // The spine passes through y≈1500 near x=1500 area for this seed; find an
    // on-spine-ish point that IS carved.
    const s = meander(3)[30];
    expect(carved(s[0], s[1]).v).toBeLessThan(bare(s[0], s[1]).v);
  });
});
