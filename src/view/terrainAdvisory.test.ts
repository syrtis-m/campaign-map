import { describe, it, expect, vi } from "vitest";
import { landformReplaceAdvisoryMessage, warnLandformReplaceOverlap } from "./terrainAdvisory";
import type { FabricFeature } from "../model/fabric";

type Pt = [number, number];

function landform(id: string, ring: Pt[], params: Record<string, unknown>, name?: string): FabricFeature {
  return {
    type: "Feature",
    id,
    geometry: { type: "Polygon", coordinates: [ring] },
    properties: { kind: "landform", name, procgen: { algorithm: "landform", seed: 3, version: 1, params } },
  } as FabricFeature;
}

function mountain(id: string, ring: Pt[], name?: string): FabricFeature {
  return {
    type: "Feature",
    id,
    geometry: { type: "Polygon", coordinates: [ring] },
    properties: {
      kind: "mountain",
      name,
      procgen: { algorithm: "mountain", seed: 7, version: 1, params: { terrain: "alpine", amplitude: 0.8, roughness: 0.5 } },
    },
  } as FabricFeature;
}

// Fixtures are authored in meters at a 1:1 scale.
const SCALE = 1;
const BOX: Pt[] = [
  [0, 0],
  [1000, 0],
  [1000, 1000],
  [0, 1000],
  [0, 0],
];
const OVERLAP_MTN: Pt[] = [
  [400, 400],
  [900, 400],
  [900, 900],
  [400, 900],
  [400, 400],
];
const MTN2: Pt[] = [[100, 100], [300, 100], [300, 300], [100, 300], [100, 100]];
const FAR_MTN: Pt[] = [
  [5000, 5000],
  [6000, 5000],
  [6000, 6000],
  [5000, 6000],
  [5000, 5000],
];

describe("terrainAdvisory — the headless twin fires only on a real overlap", () => {
  it("names the overlapping stamp and is actionable when ≤3 stamps", () => {
    const lf = landform("lf", BOX, { mode: "plateau", target: 400, band: 100 }, "Watchtower Plateau");
    const msg = landformReplaceAdvisoryMessage(lf, [lf, mountain("m", OVERLAP_MTN, "Marchspine")], SCALE);
    expect(msg).toBe(
      "⚠ This plateau overlaps 'Marchspine' and will flatten them where they intersect. " +
        "If unintended: reshape or shrink this plateau, or delete it and raise the terrain " +
        "with ridges instead. (Advisory — nothing is blocked.)"
    );
  });

  it("joins two named stamps with 'and'", () => {
    const lf = landform("lf", BOX, { mode: "plateau", target: 400, band: 100 });
    const msg = landformReplaceAdvisoryMessage(
      lf,
      [lf, mountain("m1", OVERLAP_MTN, "Marchspine"), mountain("m2", MTN2, "Cairn Arm")],
      SCALE
    );
    // id-sorted: m1 (Marchspine) then m2 (Cairn Arm).
    expect(msg).toContain("overlaps 'Marchspine' and 'Cairn Arm' and will flatten them");
    expect(msg?.startsWith("⚠ This plateau ")).toBe(true);
  });

  it("falls back to 'an unnamed mountain' for a nameless stamp", () => {
    const lf = landform("lf", BOX, { mode: "basin", target: 50, band: 100 });
    const msg = landformReplaceAdvisoryMessage(lf, [lf, mountain("m", OVERLAP_MTN)], SCALE);
    expect(msg).toContain("This basin overlaps an unnamed mountain and will flatten");
  });

  it("uses a bare count past 3 stamps", () => {
    const lf = landform("lf", BOX, { mode: "plateau", target: 400, band: 100 });
    const mtns = [0, 1, 2, 3].map((i) =>
      mountain(`m${i}`, [
        [100 + i * 10, 100],
        [300 + i * 10, 100],
        [300 + i * 10, 300],
        [100 + i * 10, 300],
        [100 + i * 10, 100],
      ])
    );
    const msg = landformReplaceAdvisoryMessage(lf, [lf, ...mtns], SCALE);
    expect(msg).toContain("overlaps 4 ridge/mountain stamps and will flatten them");
  });

  it("returns null (silent) when the landform overlaps nothing", () => {
    const lf = landform("lf", BOX, { mode: "plateau", target: 400, band: 100 });
    expect(landformReplaceAdvisoryMessage(lf, [lf, mountain("m", FAR_MTN)], SCALE)).toBeNull();
  });

  it("warnLandformReplaceOverlap NOTIFIES on the overlap fixture", () => {
    const lf = landform("lf", BOX, { mode: "plateau", target: 400, band: 100 }, "Ridge Cap");
    const notify = vi.fn();
    const fired = warnLandformReplaceOverlap(lf, [lf, mountain("m", OVERLAP_MTN, "Marchspine")], SCALE, notify);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(fired);
    expect(fired).toContain("Marchspine");
  });

  it("warnLandformReplaceOverlap is SILENT (no notify) when there is no overlap", () => {
    const lf = landform("lf", BOX, { mode: "plateau", target: 400, band: 100 });
    const notify = vi.fn();
    const fired = warnLandformReplaceOverlap(lf, [lf, mountain("m", FAR_MTN)], SCALE, notify);
    expect(notify).not.toHaveBeenCalled();
    expect(fired).toBeNull();
  });

  it("is silent for an inverted sea (replaces the exterior, not the peaks inside)", () => {
    const inv = landform("inv", BOX, { mode: "sea", target: -500, band: 100, invert: true }, "Isle");
    const notify = vi.fn();
    warnLandformReplaceOverlap(inv, [inv, mountain("m", OVERLAP_MTN)], SCALE, notify);
    expect(notify).not.toHaveBeenCalled();
  });
});
