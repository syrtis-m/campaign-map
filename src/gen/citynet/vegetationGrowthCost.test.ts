// Plan 037-B — vegetation → city growth cost.
//
// The generated canopy (`constraints.upstream.vegetation`, stage-2 forest/park
// output) attenuates the city's cityness — streets thin and blocks coarsen in
// the woods (a growth-cost multiplier) — and parcels/footprints whose centroid
// sits in DENSE canopy are rejected. The canopy is NEVER clipped (the town reads
// as a clearing via paint order). Pinned seeds; within-file relative asserts:
//   (1) coupling is wired (with-canopy ≠ without),
//   (2) NO upstream ⇒ byte-identical to the uncoupled city (23-E),
//   (3) street density INSIDE the canopy < density outside (metric band),
//   (4) the forest output handed to the city is not mutated by the city run.
import { describe, expect, it } from "vitest";
import { generateCityNetwork } from "./index";
import { WORLD_BOUNDS, fixtureAt } from "./citynet.fixtures";
import { generateForest } from "../forest";
import { makeRegion } from "../region";
import { buildUpstreamVegetationField } from "../upstream";
import type { GenerationConstraints } from "../types";

type Pt = [number, number];

const CX = 600;
const CY = 600;

// A forest canopy covering the WEST half of the district's footprint (the
// district for fixtureAt(600,600) spans roughly x ∈ [-300, 1500]). The canopy is
// the city's upstream vegetation.
function forestCanopy(): GeoJSON.Feature[] {
  const ring: Pt[] = [
    [-200, -100],
    [560, -100],
    [560, 1300],
    [-200, 1300],
    [-200, -100],
  ];
  const region = makeRegion("veg-forest", ring);
  return generateForest(4242, region, { variety: "broadleaf", density: 0.85, clearings: 0.05, edgeRaggedness: 0.4 }, { worldBounds: WORLD_BOUNDS }).filter(
    (f) => (f.properties as { generatorId?: string } | null)?.generatorId === "forest-canopy"
  );
}

function city(constraints: Partial<GenerationConstraints>): GeoJSON.Feature[] {
  const { seed, region } = fixtureAt(CX, CY, "euro-medieval");
  return generateCityNetwork(seed, region, "euro-medieval", { worldBounds: WORLD_BOUNDS, ...constraints });
}

const CANOPY = forestCanopy();
const CHAN = buildUpstreamVegetationField({ vegetation: CANOPY })!;

describe("vegetation → city growth cost (plan 037-B)", () => {
  it("the canopy fixture is non-degenerate", () => {
    expect(CANOPY.length).toBeGreaterThan(0);
  });

  it("(1) coupling is wired: the canopy changes the city", () => {
    const withVeg = city({ upstream: { vegetation: CANOPY } });
    const without = city({});
    expect(JSON.stringify(withVeg)).not.toBe(JSON.stringify(without));
  });

  it("(2) no upstream ⇒ byte-identical to the uncoupled city", () => {
    const base = JSON.stringify(city({}));
    expect(JSON.stringify(city({ upstream: undefined }))).toBe(base);
    expect(JSON.stringify(city({ upstream: { vegetation: [] } }))).toBe(base);
  });

  it("(3) street density is lower inside the canopy than outside (metric band)", () => {
    const net = city({ upstream: { vegetation: CANOPY } });
    const streets = net.filter((f) => (f.properties as { generatorId?: string } | null)?.generatorId === "city-street");
    let lenIn = 0;
    let lenOut = 0;
    for (const f of streets) {
      if (f.geometry.type !== "LineString") continue;
      const c = f.geometry.coordinates as Pt[];
      for (let i = 0; i + 1 < c.length; i++) {
        const [ax, ay] = c[i];
        const [bx, by] = c[i + 1];
        const mx = (ax + bx) / 2;
        const my = (ay + by) / 2;
        const seg = Math.hypot(bx - ax, by - ay);
        if (CHAN(mx, my) >= 0) lenIn += seg;
        else lenOut += seg;
      }
    }
    // Normalize by the sampled area of each region (a coarse grid over the
    // district-ish bbox), so the comparison is DENSITY, not raw length.
    let areaIn = 0;
    let areaOut = 0;
    for (let x = -300; x <= 1500; x += 20) {
      for (let y = -300; y <= 1500; y += 20) {
        if (CHAN(x, y) >= 0) areaIn++;
        else areaOut++;
      }
    }
    expect(areaIn).toBeGreaterThan(0);
    const densIn = lenIn / areaIn;
    const densOut = lenOut / areaOut;
    // Streets thin in the woods — materially sparser inside the canopy.
    expect(densIn).toBeLessThan(densOut);
  });

  it("(4) the forest output handed to the city is not mutated by the city run", () => {
    const snapshot = JSON.stringify(CANOPY);
    city({ upstream: { vegetation: CANOPY } });
    expect(JSON.stringify(CANOPY)).toBe(snapshot);
  });
});
