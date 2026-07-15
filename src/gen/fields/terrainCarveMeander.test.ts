/**
 * Plan 040 item 1 + 2: the river CARVE follows the generator's MEANDERED
 * centerline (not the straight sketched spine), and its depth is GM-editable
 * per vertex.
 *
 *  - Centerline unification: the trench low-point tracks a MEANDER BEND, not the
 *    straight spine. The carve and the generator share ONE centerline function
 *    (`buildRiverCenterline`), so "carve centerline == generator centerline" is
 *    trivially true — these tests exercise the WIRING (that the shared path is
 *    actually what the carve incises).
 *  - Per-vertex `depths`: interpolated along arc length; absent (or all equal to
 *    the uniform depth) ⇒ byte-identical to the pre-depths carve; monotone
 *    downhill is still guaranteed by the cumulative-min regardless of GM input.
 */
import { describe, it, expect } from "vitest";
import { terrainAt } from "./terrain";
import { riverCarveDepth } from "./terrain";
import { buildRiverCenterline } from "../river";
import { makeSpine } from "../region";
import type { RiverParams } from "../river";
import type { FabricFeature } from "../../model/fabric";

type Pt = [number, number];

function river(id: string, spine: Pt[], params: Record<string, unknown>, seed = 9): FabricFeature {
  return {
    type: "Feature",
    id,
    geometry: { type: "LineString", coordinates: spine },
    properties: { kind: "river", procgen: { algorithm: "river", seed, version: 3, params } },
  } as FabricFeature;
}

// A dead-straight sketched spine (y = 0). windiness > 0 makes the GENERATED
// channel meander laterally off it — the whole point: the trench must follow
// that meander, not the straight line the GM drew.
const STRAIGHT: Pt[] = [[0, 0], [3000, 0]];
const WINDY: RiverParams = {
  windiness: 0.85,
  braiding: 0,
  width: 26,
  widthGrowth: 0,
  braidBias: 0,
  slopeSensitivity: 0,
};

describe("carve follows the MEANDERED centerline, not the straight spine", () => {
  it("the meander genuinely leaves the straight spine (fixture precondition)", () => {
    const cl = buildRiverCenterline(9, makeSpine("r", STRAIGHT), WINDY, null).center;
    const maxOff = Math.max(...cl.map((c) => Math.abs(c.y)));
    expect(maxOff).toBeGreaterThan(12); // the channel wanders well off y = 0
  });

  it("the trench low-point at a bend apex sits at the MEANDER, not on the sketched line", () => {
    // Flat base ⇒ uncarved surface is 0 everywhere, so the deepest point of a
    // cross-section is purely the carve geometry — it must land on the meandered
    // channel, not on the straight spine.
    const cl = buildRiverCenterline(9, makeSpine("r", STRAIGHT), WINDY, null).center;
    // Pick the strongest bend apex (largest |y|) in the interior.
    let apex = cl[0];
    for (const c of cl) if (Math.abs(c.y) > Math.abs(apex.y)) apex = c;
    const carved = terrainAt([river("r", STRAIGHT, { ...WINDY })]);
    // Scan a perpendicular cross-section at the apex's x. The trench has a wide
    // FLAT floor (all at the same min), so the argmin ties across its whole
    // width — take the CENTROID of the floor, which sits at the channel center.
    let minV = Infinity;
    for (let y = -80; y <= 80; y += 0.5) minV = Math.min(minV, carved(apex.x, y).v);
    let sumY = 0;
    let n = 0;
    for (let y = -80; y <= 80; y += 0.5) {
      if (carved(apex.x, y).v <= minV + 0.5) {
        sumY += y;
        n++;
      }
    }
    const floorCenter = sumY / n;
    // The trench center tracks the MEANDER (apex.y), not the drawn line (y = 0):
    // had the carve followed the straight sketched spine, the floor would be
    // centered on y = 0.
    expect(Math.abs(floorCenter - apex.y)).toBeLessThan(6);
    expect(Math.abs(floorCenter)).toBeGreaterThan(12);
  });
});

describe("per-vertex depths (plan 040 item 2)", () => {
  const SPINE: Pt[] = [[0, 0], [1000, 0], [2000, 0], [3000, 0]];
  const CANAL: Record<string, unknown> = { width: 20, windiness: 0 };

  it("absent depths ⇒ uniform incision (baseline)", () => {
    const carved = terrainAt([river("r", SPINE, CANAL)]);
    // On the spine, well inside: incised by ~riverCarveDepth(20).
    const drop = terrainAt([])(1500, 0).v - carved(1500, 0).v;
    expect(drop).toBeGreaterThan(riverCarveDepth(20) - 5);
  });

  it("a depths array of all-uniform values is BYTE-IDENTICAL to no depths", () => {
    const u = riverCarveDepth(20);
    const bare = terrainAt([river("r", SPINE, CANAL)]);
    const uniform = terrainAt([river("r", SPINE, { ...CANAL, depths: [u, u, u, u] })]);
    for (const [x, y] of [[500, 0], [1500, 0], [2500, 3], [1500, 40]] as Pt[]) {
      expect(uniform(x, y)).toEqual(bare(x, y)); // absent-param-reproduces-old-bytes
    }
  });

  it("a mismatched-length depths array is ignored (falls back to uniform)", () => {
    const bare = terrainAt([river("r", SPINE, CANAL)]);
    const bad = terrainAt([river("r", SPINE, { ...CANAL, depths: [80, 80] })]); // 2 ≠ 4 vertices
    for (const [x, y] of [[500, 0], [1500, 0], [2500, 0]] as Pt[]) {
      expect(bad(x, y)).toEqual(bare(x, y));
    }
  });

  it("a deeper downstream depth cuts the mouth further below than the uniform bed", () => {
    const u = riverCarveDepth(20);
    const uniform = terrainAt([river("r", SPINE, CANAL)]);
    const deepMouth = terrainAt([river("r", SPINE, { ...CANAL, depths: [u, u, u, u + 200] })]);
    // At the mouth the extra 200 m of incision shows.
    expect(deepMouth(3000, 0).v).toBeLessThan(uniform(3000, 0).v - 100);
    // …and upstream (before the deepening) the two agree.
    expect(deepMouth(500, 0).v).toBeCloseTo(uniform(500, 0).v, 6);
  });

  it("water still cannot flow uphill even when the GM sets a shallow downstream depth", () => {
    // depths DECREASE downstream (source deep, mouth shallow) — a naive bed would
    // RISE toward the mouth. The cumulative-min must keep the channel core
    // monotone non-increasing regardless.
    const shallowMouth = terrainAt([river("r", SPINE, { ...CANAL, depths: [300, 200, 100, 40] })]);
    let prev = Infinity;
    for (let x = 0; x <= 3000; x += 100) {
      const v = shallowMouth(x, 0).v;
      expect(v, `x=${x} climbs`).toBeLessThanOrEqual(prev + 1e-6);
      prev = v;
    }
  });
});
