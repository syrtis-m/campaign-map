// Plan 038 item 3 — river tributary rank (Strahler-ish width from spine topology).
//
// A river reads OTHER sketched river spines (sketch-only, same-stage legal) to
// derive a Strahler-ish channel-width response:
//   (1) MAIN WIDTH STEP-UP: the half-width steps UP below a tributary junction
//       (discharge adds, W ∝ √Q), capped at maxHalfWidth so the params-only
//       corridor bound holds ⇒ junction width MONOTONICITY (the metric),
//   (2) TRIBUTARY MOUTH ≤ MAIN: a river whose mouth confluences into a narrower
//       main is clamped to the main's width,
//   (3) NO topology ⇒ byte-identical to the uncoupled river (23-E),
//   (4) even with a step-up every bank stays inside the params-only corridor.
import { describe, expect, it } from "vitest";
import { generateRiver, riverMaxOffset, type RiverParams } from "./river";
import { makeSpine, makeCorridorRegion } from "./region";
import { distanceToPolyline } from "./fields/sdf";
import type { GenerationConstraints } from "./types";
import type { FabricFeature } from "../model/fabric";
import type { BBox } from "./spatialHash";

type Pt = [number, number];

const WORLD: BBox = { minX: -5000, minY: -5000, maxX: 5000, maxY: 5000 };

/** A sketched river feature (the raw sketch layer the generator reads). */
function riverSketch(id: string, coords: Pt[], width: number): FabricFeature {
  return {
    type: "Feature",
    id,
    geometry: { type: "LineString", coordinates: coords },
    properties: { kind: "river", procgen: { algorithm: "river", seed: 1, version: 2, params: { width } } },
  } as unknown as FabricFeature;
}

// A straight (windiness 0) main river along y = 0 so |y| of a channel vertex IS
// the local half-width — a clean monotonicity measurement.
const MAIN_SPINE: Pt[] = [
  [0, 0],
  [600, 0],
];
const MAIN_PARAMS: RiverParams = { windiness: 0, braiding: 0, width: 16, widthGrowth: 1.5, braidBias: 0, slopeSensitivity: 0 };

function mainRegion() {
  return makeCorridorRegion("main", makeSpine("main", MAIN_SPINE), riverMaxOffset(MAIN_PARAMS));
}

function channelVerts(feats: GeoJSON.Feature[]): Pt[] {
  const out: Pt[] = [];
  for (const f of feats) {
    if ((f.properties as { generatorId?: string }).generatorId !== "river-channel") continue;
    if (f.geometry.type === "Polygon") out.push(...(f.geometry.coordinates[0] as Pt[]));
  }
  return out;
}

/** Local half-width near x (max |y| of channel vertices within ±hw window). */
function halfWidthNear(verts: Pt[], x: number, win = 20): number {
  let best = 0;
  for (const [vx, vy] of verts) if (Math.abs(vx - x) <= win) best = Math.max(best, Math.abs(vy));
  return best;
}

const SEED = 8080;

describe("river tributary rank (plan 038 item 3)", () => {
  // A big tributary joins the main from below at x = 300 (fraction 0.5).
  const trib = riverSketch("trib", [[300, -120], [300, -6]], 40);
  const coupled = generateRiver(SEED, mainRegion(), MAIN_PARAMS, {
    worldBounds: WORLD,
    fabricFeatures: [trib],
  });
  const verts = channelVerts(coupled);

  it("(1) the main channel steps UP below the tributary junction", () => {
    const upstream = halfWidthNear(verts, 150); // f ≈ 0.25, above the junction
    const downstream = halfWidthNear(verts, 450); // f ≈ 0.75, below the junction
    expect(upstream).toBeGreaterThan(0);
    expect(downstream).toBeGreaterThan(upstream * 1.3); // a real step-up, not noise
  });

  it("(1) junction width monotonicity: half-width is non-decreasing downstream", () => {
    let prev = 0;
    for (let x = 40; x <= 560; x += 40) {
      const hw = halfWidthNear(verts, x);
      expect(hw).toBeGreaterThanOrEqual(prev - 0.6); // straight channel ⇒ monotone (small tol for quantization)
      prev = Math.max(prev, hw);
    }
  });

  it("(2) a tributary mouth is clamped to a narrower main's width", () => {
    // A wide river (width 40) whose mouth (last vertex) lands on a narrow (12)
    // sketched main crossing at its mouth ⇒ the whole tributary clamps to ≤ 6.
    const tp: RiverParams = { windiness: 0, braiding: 0, width: 40, widthGrowth: 0, braidBias: 0, slopeSensitivity: 0 };
    const tribRegion = makeCorridorRegion("t", makeSpine("t", [[0, 0], [300, 0]]), riverMaxOffset(tp));
    const narrowMain = riverSketch("bigmain", [[300, -100], [300, 100]], 12);
    const feats = generateRiver(SEED, tribRegion, tp, { worldBounds: WORLD, fabricFeatures: [narrowMain] });
    const v = channelVerts(feats);
    // Near the mouth (x ≈ 300) the half-width is clamped to the main's 12/2 = 6.
    expect(halfWidthNear(v, 290)).toBeLessThanOrEqual(6.2);
    // Uncoupled, the same river would be half-width 20 there.
    const dry = channelVerts(generateRiver(SEED, tribRegion, tp, { worldBounds: WORLD }));
    expect(halfWidthNear(dry, 290)).toBeGreaterThan(15);
  });

  it("(3) no topology ⇒ byte-identical to the uncoupled river", () => {
    const base = JSON.stringify(generateRiver(SEED, mainRegion(), MAIN_PARAMS, { worldBounds: WORLD }));
    expect(JSON.stringify(generateRiver(SEED, mainRegion(), MAIN_PARAMS, { worldBounds: WORLD, fabricFeatures: [] }))).toBe(base);
    // A river sketch FAR from the spine (> CONFLUENCE_SNAP_M) is byte-inert.
    const farRiver = riverSketch("far", [[300, -400], [300, -300]], 40);
    expect(
      JSON.stringify(generateRiver(SEED, mainRegion(), MAIN_PARAMS, { worldBounds: WORLD, fabricFeatures: [farRiver] }))
    ).toBe(base);
  });

  it("(4) every bank stays inside the params-only corridor even with the step-up", () => {
    const bound = riverMaxOffset(MAIN_PARAMS);
    for (const [x, y] of verts) {
      expect(distanceToPolyline(MAIN_SPINE, x, y)).toBeLessThanOrEqual(bound + 0.01);
    }
  });

  it("is deterministic (double-run byte-identical) with a tributary", () => {
    const c: GenerationConstraints = { worldBounds: WORLD, fabricFeatures: [trib] };
    expect(JSON.stringify(generateRiver(SEED, mainRegion(), MAIN_PARAMS, c))).toBe(
      JSON.stringify(generateRiver(SEED, mainRegion(), MAIN_PARAMS, c))
    );
  });
});
