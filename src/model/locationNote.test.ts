import { describe, it, expect } from "vitest";
import { parseLocationNote, typeDefaults, locationToFeature, focusForType } from "./locationNote";

describe("depth-of-field focus buckets", () => {
  it("maps the big anchors to deep, mid-tier to medium, fine grain to shallow", () => {
    expect(focusForType("nation/region")).toBe("deep");
    expect(focusForType("city")).toBe("deep");
    expect(focusForType("water-feature")).toBe("deep");
    expect(focusForType("town")).toBe("medium");
    expect(focusForType("landmark")).toBe("medium");
    expect(focusForType("street(named)")).toBe("shallow");
    expect(focusForType("shop/tavern/venue")).toBe("shallow");
  });

  it("defaults unknown types to medium", () => {
    expect(focusForType("nonsense")).toBe("medium");
  });

  it("puts the resolved focus bucket on the location and its feature", () => {
    const r = parseLocationNote("Locations/Pub.md", "Pub", { map: "a", geometry: [0, 0], type: "shop/tavern/venue" });
    expect(r.ok && r.location.focus).toBe("shallow");
    if (r.ok) expect(locationToFeature(r.location)?.properties?.focus).toBe("shallow");
  });

  it("lets a note override its bucket via frontmatter `focus`", () => {
    const r = parseLocationNote("Locations/BigPub.md", "BigPub", {
      map: "a",
      geometry: [0, 0],
      type: "shop/tavern/venue",
      focus: "deep",
    });
    expect(r.ok && r.location.focus).toBe("deep");
  });
});

describe("parseLocationNote", () => {
  it("parses a minimal point location and fills type-taxonomy defaults", () => {
    const result = parseLocationNote("Locations/Tavern.md", "Tavern", {
      map: "ashfall",
      geometry: [1.2, -3.4],
      type: "shop/tavern/venue",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.location.point).toEqual([1.2, -3.4]);
      expect(result.location.importance).toBe(6);
      expect(result.location.zoomMin).toBe(14);
    }
  });

  it("lets explicit importance/zoom-range override type defaults", () => {
    const result = parseLocationNote("Locations/Tavern.md", "Tavern", {
      map: "ashfall",
      geometry: [0, 0],
      type: "shop/tavern/venue",
      importance: 2,
      "zoom-range": [1, 20],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.location.importance).toBe(2);
      expect(result.location.zoomMin).toBe(1);
      expect(result.location.zoomMax).toBe(20);
    }
  });

  it("accepts a sidecar geometry path instead of a point", () => {
    const result = parseLocationNote("Locations/District.md", "District", {
      map: "ashfall",
      geometry: "District.geojson",
      type: "district",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.location.point).toBeNull();
      expect(result.location.geometryRef).toBe("District.geojson");
    }
  });

  it("rejects a note missing map/geometry (never silently drops — caller warns)", () => {
    const result = parseLocationNote("Locations/Bad.md", "Bad", { type: "tavern" });
    expect(result.ok).toBe(false);
  });

  it("falls back to custom type defaults for an unknown type", () => {
    const defaults = typeDefaults("not-a-real-type");
    expect(defaults).toEqual(typeDefaults("custom"));
  });

  it("defaults connections to an empty array when the field is absent", () => {
    const result = parseLocationNote("Locations/Tavern.md", "Tavern", {
      map: "ashfall",
      geometry: [0, 0],
      type: "custom",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.location.connections).toEqual([]);
  });
});

describe("locationToFeature", () => {
  it("returns null for locations without a resolved point", () => {
    const result = parseLocationNote("Locations/District.md", "District", {
      map: "ashfall",
      geometry: "District.geojson",
      type: "district",
    });
    if (result.ok) expect(locationToFeature(result.location)).toBeNull();
  });

  it("carries importance/zoom range into feature properties for style filters", () => {
    const result = parseLocationNote("Locations/City.md", "City", {
      map: "ashfall",
      geometry: [0, 0],
      type: "city",
    });
    if (result.ok) {
      const feature = locationToFeature(result.location);
      expect(feature?.properties?.minZoom).toBe(5);
      expect(feature?.properties?.maxZoom).toBe(12);
    }
  });
});
