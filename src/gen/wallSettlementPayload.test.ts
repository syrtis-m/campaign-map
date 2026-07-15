// Plan 037-C — settlement payload → wall.
//
// The wall now consumes the city's `settlement` payload: gates fall where a
// GENERATED street crosses the wall spine (class precedence, gatehouse axis =
// crossing bearing), and the moat/masonry band gaps over the generated river
// channel (`upstream.water`, the river-is-the-moat case). Pinned seeds; asserts:
//   (1) a generated street crossing mints a gate at the crossing with the
//       street's bearing + roadClass, plus a gatehouse tower,
//   (2) NO settlement AND no upstream water ⇒ byte-identical to today (23-E),
//   (3) higher street class wins a min-spacing merge,
//   (4) the moat/band gaps over the generated channel.
import { describe, expect, it } from "vitest";
import { generateWall, wallMaxOffset } from "./wall";
import { generateRiver, riverMaxOffset } from "./river";
import { makeSpine, makeCorridorRegion } from "./region";
import { buildUpstreamWaterField } from "./upstream";
import type { GenerationConstraints } from "./types";
import type { BBox } from "./spatialHash";

type Pt = [number, number];

const WORLD: BBox = { minX: -5000, minY: -5000, maxX: 5000, maxY: 5000 };

// A horizontal wall spine along y = 0.
const SPINE: Pt[] = [
  [-300, 0],
  [-100, 0],
  [100, 0],
  [300, 0],
];
const PARAMS = { style: "curtain-wall" as const, towerSpacing: 60, moat: false, gatehouseScale: 1 };

function wallRegion(params = PARAMS) {
  return makeCorridorRegion("wsp-wall", makeSpine("wsp-wall", SPINE), wallMaxOffset(params));
}

/** A generated `city-street` feature (as it appears in `upstream.settlement`). */
function street(coords: Pt[], roadClass: string): GeoJSON.Feature {
  return {
    type: "Feature",
    id: `st-${coords[0][0]}-${roadClass}`,
    geometry: { type: "LineString", coordinates: coords },
    properties: { generatorId: "city-street", type: "street", roadClass },
  };
}

const SEED = 12321;

describe("settlement payload → wall (plan 037-C)", () => {
  it("(1) a generated street crossing mints a gate with the street's bearing + a gatehouse", () => {
    // A vertical arterial crossing the spine at x = 0 (bearing = ±π/2).
    const arterial = street([[0, -120], [0, 120]], "arterial");
    const feats = generateWall(SEED, wallRegion(), PARAMS, {
      worldBounds: WORLD,
      upstream: { settlement: [arterial] },
    });
    const gates = feats.filter((f) => (f.properties as { generatorId?: string }).generatorId === "wall-gate");
    const atOrigin = gates.find((g) => {
      const [x, y] = (g.geometry as GeoJSON.Point).coordinates as Pt;
      return Math.hypot(x, y) < 5;
    });
    expect(atOrigin, "gate at the arterial crossing").toBeTruthy();
    const props = atOrigin!.properties as { bearing?: number; roadClass?: string };
    expect(props.roadClass).toBe("arterial");
    // Bearing is ±π/2 (the vertical street); compare |sin| ≈ 1, cos ≈ 0.
    expect(Math.abs(Math.cos(props.bearing!))).toBeLessThan(0.05);
    expect(Math.abs(Math.sin(props.bearing!))).toBeGreaterThan(0.99);
    // A gatehouse tower accompanies the generated gate.
    const gatehouse = feats.find(
      (f) => (f.properties as { gatehouse?: boolean }).gatehouse === true
    );
    expect(gatehouse, "gatehouse tower at the generated gate").toBeTruthy();
  });

  it("(2) no settlement + no water ⇒ byte-identical to the uncoupled wall", () => {
    const base = JSON.stringify(generateWall(SEED, wallRegion(), PARAMS, { worldBounds: WORLD }));
    expect(JSON.stringify(generateWall(SEED, wallRegion(), PARAMS, { worldBounds: WORLD, upstream: undefined }))).toBe(base);
    expect(
      JSON.stringify(generateWall(SEED, wallRegion(), PARAMS, { worldBounds: WORLD, upstream: { settlement: [] } }))
    ).toBe(base);
    // And a sketched-road gate carries NO bearing/roadClass (today's marker).
    const road: GeoJSON.Feature = {
      type: "Feature",
      id: "rd",
      geometry: { type: "LineString", coordinates: [[0, -80], [0, 80]] },
      properties: { kind: "road" },
    };
    const withRoad = generateWall(SEED, wallRegion(), PARAMS, {
      worldBounds: WORLD,
      fabricFeatures: [road as never],
    });
    const rgate = withRoad.find((f) => (f.properties as { generatorId?: string }).generatorId === "wall-gate");
    expect(rgate).toBeTruthy();
    expect((rgate!.properties as { bearing?: number }).bearing).toBeUndefined();
  });

  it("(3) higher street class wins a min-spacing merge", () => {
    // An alley and an arterial cross within a gate width of each other; the gate
    // must read as the arterial (class precedence).
    const alley = street([[-2, -100], [-2, 100]], "alley");
    const arterial = street([[2, -100], [2, 100]], "arterial");
    const feats = generateWall(SEED, wallRegion(), PARAMS, {
      worldBounds: WORLD,
      upstream: { settlement: [alley, arterial] },
    });
    const gates = feats.filter((f) => (f.properties as { generatorId?: string }).generatorId === "wall-gate");
    const near0 = gates.filter((g) => Math.abs(((g.geometry as GeoJSON.Point).coordinates as Pt)[0]) < 10);
    expect(near0.length).toBe(1); // merged to one
    expect((near0[0].properties as { roadClass?: string }).roadClass).toBe("arterial");
  });

  it("(4) the moat/band gaps over the generated river channel", () => {
    const moatParams = { ...PARAMS, moat: true };
    // A river crossing the wall spine vertically near x = 0.
    const rSpine: Pt[] = [[0, -200], [10, -60], [-10, 60], [0, 200]];
    const rp = { windiness: 0.2, braiding: 0, width: 44, widthGrowth: 0, braidBias: 0, slopeSensitivity: 0 };
    const rRegion = makeCorridorRegion("wsp-river", makeSpine("wsp-river", rSpine), riverMaxOffset(rp));
    const water = generateRiver(4242, rRegion, rp, { worldBounds: WORLD }).filter(
      (f) => (f.properties as { generatorId?: string }).generatorId === "river-channel"
    );
    expect(water.length).toBeGreaterThan(0);
    const chan = buildUpstreamWaterField({ water })!;
    const feats = generateWall(SEED, wallRegion(moatParams), moatParams, {
      worldBounds: WORLD,
      upstream: { water },
    });
    // No masonry-band or moat quad vertex sits DEEP inside the channel: the gap
    // is on the segment centerline, so a quad may graze the bank by its own
    // half-width (band ±3 m, moat ±6 m) but never straddles the water.
    for (const f of feats) {
      const gid = (f.properties as { generatorId?: string }).generatorId;
      if (gid !== "wall-quad" && gid !== "wall-moat") continue;
      if (f.geometry.type !== "Polygon") continue;
      const tol = gid === "wall-moat" ? 7 : 4;
      for (const [x, y] of f.geometry.coordinates[0] as Pt[]) {
        expect(chan(x, y) < tol, `${gid} vertex depth ${chan(x, y).toFixed(1)} in channel`).toBe(true);
      }
    }
    // Coupling is wired: the channel changes the wall.
    const dry = generateWall(SEED, wallRegion(moatParams), moatParams, { worldBounds: WORLD });
    expect(JSON.stringify(feats)).not.toBe(JSON.stringify(dry));
  });
});
