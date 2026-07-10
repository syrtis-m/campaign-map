import { describe, it, expect } from "vitest";
import { parseSessionPath, sessionPathFeature } from "./sessionPath";
import type { ParsedLocation } from "./locationNote";

function loc(overrides: Partial<ParsedLocation> & { path: string; name: string }): ParsedLocation {
  return {
    id: overrides.path,
    campaignId: "ashfall",
    point: [0, 0],
    geometryRef: null,
    type: "custom",
    importance: 5,
    zoomMin: 12,
    zoomMax: 24,
    aliases: [],
    icon: null,
    connections: [],
    ...overrides,
  };
}

describe("parseSessionPath", () => {
  it("resolves two wikilinks to a 2-point path in appearance order", () => {
    const a = loc({ path: "Locations/A.md", name: "A", point: [0, 0] });
    const b = loc({ path: "Locations/B.md", name: "B", point: [1, 1] });
    const body = "The party went to [[A]], then travelled on to [[B]] by nightfall.";
    const path = parseSessionPath(body, [a, b]);
    expect(path).toEqual([
      { name: "A", point: [0, 0] },
      { name: "B", point: [1, 1] },
    ]);
  });

  it("dedupes a repeated consecutive link", () => {
    const a = loc({ path: "Locations/A.md", name: "A", point: [0, 0] });
    const b = loc({ path: "Locations/B.md", name: "B", point: [1, 1] });
    const body = "[[A]] ... they lingered, still at [[A]], before finally reaching [[B]].";
    const path = parseSessionPath(body, [a, b]);
    expect(path).toEqual([
      { name: "A", point: [0, 0] },
      { name: "B", point: [1, 1] },
    ]);
  });

  it("does not dedupe a non-consecutive repeat (A, B, A is a real round trip)", () => {
    const a = loc({ path: "Locations/A.md", name: "A", point: [0, 0] });
    const b = loc({ path: "Locations/B.md", name: "B", point: [1, 1] });
    const body = "[[A]] to [[B]] and back to [[A]] again.";
    const path = parseSessionPath(body, [a, b]);
    expect(path).toEqual([
      { name: "A", point: [0, 0] },
      { name: "B", point: [1, 1] },
      { name: "A", point: [0, 0] },
    ]);
  });

  it("skips a link to a name that doesn't resolve, without throwing", () => {
    const a = loc({ path: "Locations/A.md", name: "A", point: [0, 0] });
    const b = loc({ path: "Locations/B.md", name: "B", point: [1, 1] });
    const body = "[[A]] then [[Nowhere]] then [[B]].";
    expect(() => parseSessionPath(body, [a, b])).not.toThrow();
    expect(parseSessionPath(body, [a, b])).toEqual([
      { name: "A", point: [0, 0] },
      { name: "B", point: [1, 1] },
    ]);
  });

  it("skips a link to a sidecar-only location (point: null)", () => {
    const a = loc({ path: "Locations/A.md", name: "A", point: [0, 0] });
    const b = loc({ path: "Locations/B.md", name: "B", point: null, geometryRef: "B.geojson" });
    const body = "[[A]] then [[B]].";
    expect(parseSessionPath(body, [a, b])).toEqual([]);
  });

  it("resolves via alias", () => {
    const a = loc({ path: "Locations/A.md", name: "A", point: [0, 0] });
    const b = loc({ path: "Locations/B.md", name: "B", point: [1, 1], aliases: ["Bee"] });
    const body = "[[A]] then [[Bee]].";
    expect(parseSessionPath(body, [a, b])).toEqual([
      { name: "A", point: [0, 0] },
      { name: "B", point: [1, 1] },
    ]);
  });

  it("returns [] when fewer than 2 links resolve", () => {
    const a = loc({ path: "Locations/A.md", name: "A", point: [0, 0] });
    expect(parseSessionPath("only [[A]] here", [a])).toEqual([]);
    expect(parseSessionPath("no links at all", [a])).toEqual([]);
  });
});

describe("sessionPathFeature", () => {
  it("builds a LineString through the points in order", () => {
    const feature = sessionPathFeature([{ point: [0, 0] }, { point: [1, 1] }, { point: [2, 0] }]);
    expect(feature).toEqual({
      type: "Feature",
      geometry: { type: "LineString", coordinates: [[0, 0], [1, 1], [2, 0]] },
      properties: { kind: "session-path" },
    });
  });

  it("returns null for fewer than 2 points", () => {
    expect(sessionPathFeature([])).toBeNull();
    expect(sessionPathFeature([{ point: [0, 0] }])).toBeNull();
  });
});
