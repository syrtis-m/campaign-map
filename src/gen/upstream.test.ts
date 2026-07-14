import { describe, it, expect } from "vitest";
import { buildUpstreamConstraints, buildUpstreamWaterField } from "./upstream";
import type { UpstreamArtifacts } from "./types";
import type { GenerationConstraints } from "./types";

/** A square channel polygon (a stand-in for a `river-channel` feature). */
function channel(cx: number, cy: number, r: number): GeoJSON.Feature {
  return {
    type: "Feature",
    properties: { generatorId: "river-channel" },
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [cx - r, cy - r],
          [cx + r, cy - r],
          [cx + r, cy + r],
          [cx - r, cy + r],
          [cx - r, cy - r],
        ],
      ],
    },
  };
}

describe("upstream — buildUpstreamConstraints (worker-side rebuild)", () => {
  it("extracts outer rings of water + vegetation polygons", () => {
    const upstream: UpstreamArtifacts = {
      water: [channel(0, 0, 10), channel(50, 0, 5)],
      vegetation: [channel(100, 100, 20)],
    };
    const rebuilt = buildUpstreamConstraints(upstream);
    expect(rebuilt.waterRings).toHaveLength(2);
    expect(rebuilt.vegetationRings).toHaveLength(1);
    expect(rebuilt.waterRings[0][0]).toEqual([-10, -10]);
  });

  it("handles MultiPolygon (a unioned canopy) — one ring per polygon", () => {
    const multi: GeoJSON.Feature = {
      type: "Feature",
      properties: {},
      geometry: {
        type: "MultiPolygon",
        coordinates: [
          channel(0, 0, 5).geometry.type === "Polygon" ? (channel(0, 0, 5).geometry as GeoJSON.Polygon).coordinates : [],
          (channel(30, 0, 5).geometry as GeoJSON.Polygon).coordinates,
        ],
      },
    };
    const rebuilt = buildUpstreamConstraints({ vegetation: [multi] });
    expect(rebuilt.vegetationRings).toHaveLength(2);
  });

  it("empty / undefined upstream ⇒ empty (back-compat: no coupling)", () => {
    expect(buildUpstreamConstraints(undefined)).toEqual({ waterRings: [], vegetationRings: [] });
    expect(buildUpstreamConstraints({})).toEqual({ waterRings: [], vegetationRings: [] });
  });
});

describe("upstream — worker-safe serialization (plain JSON survives structuredClone)", () => {
  it("upstream artifacts survive a structuredClone round-trip and rebuild identically", () => {
    const upstream: UpstreamArtifacts = { water: [channel(0, 0, 10)], vegetation: [channel(5, 5, 3)] };
    // The worker boundary is a structuredClone (postMessage). No closures, no
    // functions — plain GeoJSON only.
    const cloned = structuredClone(upstream);
    expect(cloned).toEqual(upstream);
    // And the rebuilt field is identical on both sides (the "worker rebuilds the
    // SDF from data" contract — no Field closure ever crosses).
    const here = buildUpstreamConstraints(upstream);
    const there = buildUpstreamConstraints(cloned);
    expect(there).toEqual(here);
  });

  it("upstream rides on GenerationConstraints and survives the clone whole", () => {
    const constraints: GenerationConstraints = {
      worldBounds: { minX: -1000, minY: -1000, maxX: 1000, maxY: 1000 },
      upstream: { water: [channel(0, 0, 10)] },
    };
    const cloned = structuredClone(constraints);
    expect(cloned.upstream?.water).toHaveLength(1);
    expect(cloned).toEqual(constraints);
  });
});

describe("upstream — buildUpstreamWaterField (rebuilt SDF closure)", () => {
  it("is positive inside the channel, negative outside; null when empty", () => {
    const field = buildUpstreamWaterField({ water: [channel(0, 0, 10)] });
    expect(field).not.toBeNull();
    expect(field!(0, 0)).toBeGreaterThan(0); // deep inside
    expect(field!(100, 100)).toBeLessThan(0); // far outside
    expect(buildUpstreamWaterField(undefined)).toBeNull();
    expect(buildUpstreamWaterField({ water: [] })).toBeNull();
  });

  it("unions by max over multiple channels (inside iff inside any)", () => {
    const field = buildUpstreamWaterField({ water: [channel(0, 0, 10), channel(100, 0, 10)] })!;
    expect(field(100, 0)).toBeGreaterThan(0); // inside the SECOND channel too
  });
});
