import { describe, it, expect } from "vitest";
import { importGeojson, sanitizeNoteName } from "./importGeojson";
import { LOCATION_TYPES } from "./locationNote";

describe("importGeojson", () => {
  it("maps a Point feature to a point note, using its known type", () => {
    const fc = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { name: "Barleyanbrook", type: "town" },
          geometry: { type: "Point", coordinates: [12, 34] },
        },
      ],
    };
    const notes = importGeojson(fc, LOCATION_TYPES);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ name: "Barleyanbrook", type: "town", point: [12, 34], geojson: null });
  });

  it("defaults a Point feature's type to landmark when properties.type is unknown", () => {
    const fc = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { name: "Odd Rock", type: "not-a-real-type" },
          geometry: { type: "Point", coordinates: [1, 2] },
        },
      ],
    };
    const notes = importGeojson(fc, LOCATION_TYPES);
    expect(notes[0].type).toBe("landmark");
  });

  it("maps a LineString feature to a sidecar note defaulting to type route", () => {
    const fc = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { name: "Old King's Road" },
          geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] },
        },
      ],
    };
    const notes = importGeojson(fc, LOCATION_TYPES);
    expect(notes).toHaveLength(1);
    expect(notes[0].point).toBeNull();
    expect(notes[0].type).toBe("route");
    expect(notes[0].geojson).toMatchObject({ geometry: { type: "LineString" } });
  });

  it("maps a MultiLineString feature the same as LineString", () => {
    const fc = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: { type: "MultiLineString", coordinates: [[[0, 0], [1, 1]]] },
        },
      ],
    };
    const notes = importGeojson(fc, LOCATION_TYPES);
    expect(notes[0].type).toBe("route");
    expect(notes[0].point).toBeNull();
  });

  it("maps a Polygon feature to a sidecar note defaulting to type district", () => {
    const fc = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { name: "The Sump" },
          geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
        },
      ],
    };
    const notes = importGeojson(fc, LOCATION_TYPES);
    expect(notes).toHaveLength(1);
    expect(notes[0].point).toBeNull();
    expect(notes[0].type).toBe("district");
    expect(notes[0].geojson).toMatchObject({ geometry: { type: "Polygon" } });
  });

  it("maps a MultiPolygon feature the same as Polygon", () => {
    const fc = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { type: "district" },
          geometry: { type: "MultiPolygon", coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]] },
        },
      ],
    };
    const notes = importGeojson(fc, LOCATION_TYPES);
    expect(notes[0].type).toBe("district");
    expect(notes[0].point).toBeNull();
  });

  it("falls back to 'Imported N' when a feature has no name/title/id", () => {
    const fc = {
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [0, 0] } },
        { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [1, 1] } },
      ],
    };
    const notes = importGeojson(fc, LOCATION_TYPES);
    expect(notes[0].name).toBe("Imported 1");
    expect(notes[1].name).toBe("Imported 2");
  });

  it("uses properties.title or properties.id when name is absent", () => {
    const fc = {
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: { title: "By Title" }, geometry: { type: "Point", coordinates: [0, 0] } },
        { type: "Feature", properties: { id: "by-id" }, geometry: { type: "Point", coordinates: [0, 0] } },
      ],
    };
    const notes = importGeojson(fc, LOCATION_TYPES);
    expect(notes[0].name).toBe("By Title");
    expect(notes[1].name).toBe("by-id");
  });

  it("skips features with no geometry, without throwing", () => {
    const fc = {
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: { name: "Ghost" }, geometry: null }],
    };
    expect(importGeojson(fc, LOCATION_TYPES)).toEqual([]);
  });

  it("skips geometry types it doesn't understand (e.g. GeometryCollection)", () => {
    const fc = {
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: {}, geometry: { type: "GeometryCollection", geometries: [] } }],
    };
    expect(importGeojson(fc, LOCATION_TYPES)).toEqual([]);
  });

  it("returns [] for a non-FeatureCollection input", () => {
    expect(importGeojson({ type: "Feature" }, LOCATION_TYPES)).toEqual([]);
    expect(importGeojson(null, LOCATION_TYPES)).toEqual([]);
    expect(importGeojson(undefined, LOCATION_TYPES)).toEqual([]);
    expect(importGeojson("not geojson", LOCATION_TYPES)).toEqual([]);
    expect(importGeojson({ type: "FeatureCollection" }, LOCATION_TYPES)).toEqual([]);
  });
});

describe("sanitizeNoteName", () => {
  it("strips illegal filesystem/markdown characters", () => {
    expect(sanitizeNoteName('A/B\\C:D*E?F"G<H>I|J#K^L[M]N')).toBe("A B C D E F G H I J K L M N");
  });

  it("collapses whitespace and trims", () => {
    expect(sanitizeNoteName("  Old   King's   Road  ")).toBe("Old King's Road");
  });

  it("truncates to 80 characters", () => {
    const long = "x".repeat(200);
    expect(sanitizeNoteName(long)).toHaveLength(80);
  });

  it("falls back to 'Imported' when the name is empty after sanitizing", () => {
    expect(sanitizeNoteName("///:::***")).toBe("Imported");
    expect(sanitizeNoteName("")).toBe("Imported");
  });
});
