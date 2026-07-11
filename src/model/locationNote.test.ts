import { describe, it, expect } from "vitest";
import {
  parseLocationNote,
  typeDefaults,
  locationToFeature,
  focusForType,
  defaultVisibilityForType,
} from "./locationNote";

describe("explicit visibility field (plan 015 — decoupled from type)", () => {
  it("gates on the explicit `visibility` field, mapped 1:1 to the focus bucket", () => {
    const wide = parseLocationNote("L/A.md", "A", { map: "a", geometry: [0, 0], type: "custom", visibility: "wide" });
    const mid = parseLocationNote("L/B.md", "B", { map: "a", geometry: [0, 0], type: "custom", visibility: "mid" });
    const close = parseLocationNote("L/C.md", "C", { map: "a", geometry: [0, 0], type: "custom", visibility: "close" });
    expect(wide.ok && wide.location.focus).toBe("deep");
    expect(mid.ok && mid.location.focus).toBe("medium");
    expect(close.ok && close.location.focus).toBe("shallow");
    // and the feature carries the runtime `focus` property for the label layers
    if (close.ok) expect(locationToFeature(close.location)?.properties?.focus).toBe("shallow");
  });

  it("does NOT derive visibility from type — a city with no field is the global default (medium), not deep", () => {
    const city = parseLocationNote("L/City.md", "City", { map: "a", geometry: [0, 0], type: "city" });
    expect(city.ok && city.location.focus).toBe("medium");
    expect(city.ok && city.location.visibility).toBe("mid");
    // a shop with no field is ALSO the global default — type is irrelevant to visibility now
    const shop = parseLocationNote("L/Shop.md", "Shop", { map: "a", geometry: [0, 0], type: "shop/tavern/venue" });
    expect(shop.ok && shop.location.focus).toBe("medium");
  });

  it("explicit `visibility` beats a legacy `focus` key when both are present", () => {
    const r = parseLocationNote("L/D.md", "D", {
      map: "a",
      geometry: [0, 0],
      type: "custom",
      visibility: "close",
      focus: "deep",
    });
    expect(r.ok && r.location.focus).toBe("shallow");
  });

  it("still accepts a legacy `focus:` bucket for back-compat (no `visibility`)", () => {
    const r = parseLocationNote("L/E.md", "E", { map: "a", geometry: [0, 0], type: "custom", focus: "deep" });
    expect(r.ok && r.location.focus).toBe("deep");
    expect(r.ok && r.location.visibility).toBe("wide");
  });

  it("rejects an unknown visibility value (warning badge, never a silent coerce-to-default)", () => {
    const r = parseLocationNote("L/F.md", "F", { map: "a", geometry: [0, 0], type: "custom", visibility: "sometimes" });
    expect(r.ok).toBe(false);
  });

  it("exposes type→bucket only as a pre-selection hint (focusForType / defaultVisibilityForType)", () => {
    expect(focusForType("city")).toBe("deep");
    expect(defaultVisibilityForType("city")).toBe("wide");
    expect(defaultVisibilityForType("shop/tavern/venue")).toBe("close");
    expect(defaultVisibilityForType("nonsense")).toBe("mid");
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
