import { describe, it, expect } from "vitest";
import { buildConnectionFeatures } from "./connections";
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

describe("buildConnectionFeatures", () => {
  it("produces one LineString for a resolvable pair", () => {
    const a = loc({ path: "Locations/A.md", name: "A", point: [0, 0], connections: [{ to: "B", type: null, label: null }] });
    const b = loc({ path: "Locations/B.md", name: "B", point: [1, 1] });
    const features = buildConnectionFeatures([a, b]);
    expect(features).toHaveLength(1);
    expect(features[0].geometry).toEqual({ type: "LineString", coordinates: [[0, 0], [1, 1]] });
    expect(features[0].properties).toMatchObject({ from: "Locations/A.md", to: "Locations/B.md" });
  });

  it("dedupes A→B and B→A to a single feature", () => {
    const a = loc({ path: "Locations/A.md", name: "A", point: [0, 0], connections: [{ to: "B", type: null, label: null }] });
    const b = loc({ path: "Locations/B.md", name: "B", point: [1, 1], connections: [{ to: "A", type: null, label: null }] });
    const features = buildConnectionFeatures([a, b]);
    expect(features).toHaveLength(1);
  });

  it("skips a connection to a name that doesn't exist, without throwing", () => {
    const a = loc({ path: "Locations/A.md", name: "A", point: [0, 0], connections: [{ to: "Nonexistent", type: null, label: null }] });
    expect(() => buildConnectionFeatures([a])).not.toThrow();
    expect(buildConnectionFeatures([a])).toHaveLength(0);
  });

  it("skips a connection to a sidecar-only location (point: null)", () => {
    const a = loc({ path: "Locations/A.md", name: "A", point: [0, 0], connections: [{ to: "B", type: null, label: null }] });
    const b = loc({ path: "Locations/B.md", name: "B", point: null, geometryRef: "B.geojson" });
    const features = buildConnectionFeatures([a, b]);
    expect(features).toHaveLength(0);
  });

  it("resolves wikilink form [[Name]]", () => {
    const a = loc({ path: "Locations/A.md", name: "A", point: [0, 0], connections: [{ to: "[[B]]", type: null, label: null }] });
    const b = loc({ path: "Locations/B.md", name: "B", point: [1, 1] });
    const features = buildConnectionFeatures([a, b]);
    expect(features).toHaveLength(1);
  });

  it("resolves via alias", () => {
    const a = loc({ path: "Locations/A.md", name: "A", point: [0, 0], connections: [{ to: "Bee", type: null, label: null }] });
    const b = loc({ path: "Locations/B.md", name: "B", point: [1, 1], aliases: ["Bee"] });
    const features = buildConnectionFeatures([a, b]);
    expect(features).toHaveLength(1);
  });

  it("skips self-connections", () => {
    const a = loc({ path: "Locations/A.md", name: "A", point: [0, 0], connections: [{ to: "A", type: null, label: null }] });
    expect(buildConnectionFeatures([a])).toHaveLength(0);
  });
});
