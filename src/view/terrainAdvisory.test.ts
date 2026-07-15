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

function mountain(id: string, ring: Pt[]): FabricFeature {
  return {
    type: "Feature",
    id,
    geometry: { type: "Polygon", coordinates: [ring] },
    properties: {
      kind: "mountain",
      procgen: { algorithm: "mountain", seed: 7, version: 1, params: { terrain: "alpine", amplitude: 0.8, roughness: 0.5 } },
    },
  } as FabricFeature;
}

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
const FAR_MTN: Pt[] = [
  [5000, 5000],
  [6000, 5000],
  [6000, 6000],
  [5000, 6000],
  [5000, 5000],
];

describe("terrainAdvisory — the headless twin fires only on a real overlap", () => {
  it("returns a message when a named landform overlaps an add-stamp", () => {
    const lf = landform("lf", BOX, { mode: "plateau", target: 400, band: 100 }, "Watchtower Plateau");
    const msg = landformReplaceAdvisoryMessage(lf, [lf, mountain("m", OVERLAP_MTN)]);
    expect(msg).toBe(
      "landform 'Watchtower Plateau' overlaps 1 terrain stamp — replace stamps flatten add-stamps inside them"
    );
  });

  it("pluralises the stamp count and uses (unnamed) for an unnamed landform", () => {
    const lf = landform("lf", BOX, { mode: "plateau", target: 400, band: 100 });
    const msg = landformReplaceAdvisoryMessage(lf, [
      lf,
      mountain("m1", OVERLAP_MTN),
      mountain("m2", [[100, 100], [300, 100], [300, 300], [100, 300], [100, 100]]),
    ]);
    expect(msg).toBe(
      "landform '(unnamed)' overlaps 2 terrain stamps — replace stamps flatten add-stamps inside them"
    );
  });

  it("returns null (silent) when the landform overlaps nothing", () => {
    const lf = landform("lf", BOX, { mode: "plateau", target: 400, band: 100 });
    expect(landformReplaceAdvisoryMessage(lf, [lf, mountain("m", FAR_MTN)])).toBeNull();
  });

  it("warnLandformReplaceOverlap NOTIFIES on the overlap fixture", () => {
    const lf = landform("lf", BOX, { mode: "plateau", target: 400, band: 100 }, "Ridge Cap");
    const notify = vi.fn();
    const fired = warnLandformReplaceOverlap(lf, [lf, mountain("m", OVERLAP_MTN)], notify);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(fired);
    expect(fired).toContain("Ridge Cap");
  });

  it("warnLandformReplaceOverlap is SILENT (no notify) when there is no overlap", () => {
    const lf = landform("lf", BOX, { mode: "plateau", target: 400, band: 100 });
    const notify = vi.fn();
    const fired = warnLandformReplaceOverlap(lf, [lf, mountain("m", FAR_MTN)], notify);
    expect(notify).not.toHaveBeenCalled();
    expect(fired).toBeNull();
  });

  it("is silent for an inverted sea (replaces the exterior, not the peaks inside)", () => {
    const inv = landform("inv", BOX, { mode: "sea", target: -500, band: 100, invert: true }, "Isle");
    const notify = vi.fn();
    warnLandformReplaceOverlap(inv, [inv, mountain("m", OVERLAP_MTN)], notify);
    expect(notify).not.toHaveBeenCalled();
  });
});
