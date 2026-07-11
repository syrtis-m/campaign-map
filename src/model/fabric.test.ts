import { describe, it, expect } from "vitest";
import {
  FABRIC_KINDS,
  FabricFeatureSchema,
  FabricCollectionSchema,
  DEFAULT_FABRIC_MINZOOM,
  defaultMinZoomFor,
  emptyFabric,
  isPolygonKind,
  makeFabricId,
  parseFabric,
  sketchUndoTarget,
  withFeature,
  withoutFeature,
  type FabricFeature,
  type SketchLogEntryLike,
} from "./fabric";

function roadFeature(id = "fabric-a"): FabricFeature {
  return {
    type: "Feature",
    id,
    geometry: { type: "LineString", coordinates: [[0, 0], [10, 5]] },
    properties: { kind: "road" },
  };
}

function districtFeature(id = "fabric-b"): FabricFeature {
  return {
    type: "Feature",
    id,
    geometry: { type: "Polygon", coordinates: [[[0, 0], [10, 0], [10, 10], [0, 0]]] },
    properties: { kind: "district", name: "Old Town" },
  };
}

describe("FabricFeatureSchema", () => {
  it("accepts a LineString road and a Polygon district", () => {
    expect(FabricFeatureSchema.safeParse(roadFeature()).success).toBe(true);
    expect(FabricFeatureSchema.safeParse(districtFeature()).success).toBe(true);
  });

  it("rejects an unknown kind", () => {
    const bad = { ...roadFeature(), properties: { kind: "volcano" } };
    expect(FabricFeatureSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a one-point LineString and a three-position ring", () => {
    const shortLine = { ...roadFeature(), geometry: { type: "LineString", coordinates: [[0, 0]] } };
    expect(FabricFeatureSchema.safeParse(shortLine).success).toBe(false);
    const openRing = {
      ...districtFeature(),
      geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [0, 0]]] },
    };
    expect(FabricFeatureSchema.safeParse(openRing).success).toBe(false);
  });

  it("rejects a Point geometry (points are location notes, not fabric)", () => {
    const point = { ...roadFeature(), geometry: { type: "Point", coordinates: [0, 0] } };
    expect(FabricFeatureSchema.safeParse(point).success).toBe(false);
  });

  it("rejects a missing/empty id (needed for select/delete/undo)", () => {
    expect(FabricFeatureSchema.safeParse({ ...roadFeature(), id: "" }).success).toBe(false);
    const { id: _id, ...noId } = roadFeature();
    expect(FabricFeatureSchema.safeParse(noId).success).toBe(false);
  });

  it("accepts optional per-feature minZoom override", () => {
    const f = { ...roadFeature(), properties: { kind: "road", minZoom: 12 } };
    expect(FabricFeatureSchema.safeParse(f).success).toBe(true);
  });
});

describe("defaultMinZoomFor", () => {
  it("covers every kind", () => {
    for (const kind of FABRIC_KINDS) {
      expect(typeof defaultMinZoomFor(kind)).toBe("number");
      expect(defaultMinZoomFor(kind)).toBe(DEFAULT_FABRIC_MINZOOM[kind]);
    }
  });

  it("orders LOD sensibly: broad kinds appear before detail kinds", () => {
    expect(defaultMinZoomFor("river")).toBeLessThan(defaultMinZoomFor("road"));
    expect(defaultMinZoomFor("water")).toBeLessThan(defaultMinZoomFor("wall"));
    expect(defaultMinZoomFor("district")).toBeLessThan(defaultMinZoomFor("park"));
  });
});

describe("kind partitioning", () => {
  it("splits line vs polygon kinds as designed", () => {
    expect(FABRIC_KINDS.filter(isPolygonKind)).toEqual(["water", "district", "park"]);
    expect(FABRIC_KINDS.filter((k) => !isPolygonKind(k))).toEqual(["road", "wall", "river"]);
  });
});

describe("withFeature / withoutFeature", () => {
  it("appends without mutating the input", () => {
    const base = emptyFabric();
    const next = withFeature(base, roadFeature());
    expect(base.features).toHaveLength(0);
    expect(next.features).toHaveLength(1);
  });

  it("replaces an existing feature with the same id", () => {
    const a = withFeature(emptyFabric(), roadFeature("same"));
    const replacement = { ...districtFeature("same") };
    const next = withFeature(a, replacement);
    expect(next.features).toHaveLength(1);
    expect(next.features[0].properties.kind).toBe("district");
  });

  it("removes by id and no-ops on unknown ids", () => {
    const two = withFeature(withFeature(emptyFabric(), roadFeature("a")), districtFeature("b"));
    expect(withoutFeature(two, "a").features.map((f) => f.id)).toEqual(["b"]);
    expect(withoutFeature(two, "nope").features).toHaveLength(2);
  });
});

describe("parseFabric (IO boundary)", () => {
  it("parses a valid collection with zero invalid", () => {
    const raw = JSON.stringify(withFeature(emptyFabric(), roadFeature()));
    const { fabric, invalidCount } = parseFabric(raw);
    expect(invalidCount).toBe(0);
    expect(fabric.features).toHaveLength(1);
  });

  it("salvages valid features and counts the bad ones (never silent drop of everything)", () => {
    const raw = JSON.stringify({
      type: "FeatureCollection",
      features: [roadFeature(), { type: "Feature", id: "bad", geometry: null, properties: {} }],
    });
    const { fabric, invalidCount } = parseFabric(raw);
    expect(fabric.features).toHaveLength(1);
    expect(invalidCount).toBe(1);
  });

  it("returns empty + invalid on unparseable JSON or a non-FeatureCollection", () => {
    expect(parseFabric("not json").invalidCount).toBe(1);
    expect(parseFabric("not json").fabric.features).toHaveLength(0);
    expect(parseFabric(JSON.stringify({ type: "Feature" })).invalidCount).toBe(1);
  });
});

describe("sketchUndoTarget (plan 016 log-driven undo)", () => {
  const add = (f: FabricFeature): SketchLogEntryLike => ({ type: "sketch-add", data: f as unknown as Record<string, unknown> });
  const remove = (f: FabricFeature): SketchLogEntryLike => ({ type: "sketch-remove", data: f as unknown as Record<string, unknown> });

  it("returns null for an empty log", () => {
    expect(sketchUndoTarget([])).toBeNull();
  });

  it("returns the single added feature", () => {
    const a = roadFeature("a");
    expect(sketchUndoTarget([add(a)])?.id).toBe("a");
  });

  it("returns the most recently added of several", () => {
    expect(sketchUndoTarget([add(roadFeature("a")), add(districtFeature("b"))])?.id).toBe("b");
  });

  it("nets a later remove against its add (skips undone features)", () => {
    const log = [add(roadFeature("a")), add(districtFeature("b")), remove(districtFeature("b"))];
    // b was removed, so the next undo target is a
    expect(sketchUndoTarget(log)?.id).toBe("a");
  });

  it("returns null once every add has been removed", () => {
    const a = roadFeature("a");
    expect(sketchUndoTarget([add(a), remove(a)])).toBeNull();
  });

  it("treats a re-added id as live again", () => {
    const a = roadFeature("a");
    expect(sketchUndoTarget([add(a), remove(a), add(a)])?.id).toBe("a");
  });

  it("ignores non-sketch and malformed entries", () => {
    const log: SketchLogEntryLike[] = [
      { type: "create", data: { anything: true } },
      { type: "sketch-add", data: { not: "a feature" } },
      add(roadFeature("a")),
    ];
    expect(sketchUndoTarget(log)?.id).toBe("a");
  });
});

describe("makeFabricId", () => {
  it("produces distinct non-empty ids", () => {
    const a = makeFabricId();
    const b = makeFabricId();
    expect(a).not.toBe("");
    expect(a).not.toBe(b);
  });
});
