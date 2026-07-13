import { describe, it, expect } from "vitest";
import {
  FABRIC_KINDS,
  FabricFeatureSchema,
  FabricCollectionSchema,
  emptyFabric,
  isPolygonKind,
  isProcgenRegion,
  makeFabricId,
  parseFabric,
  sketchUndoTarget,
  withFeature,
  withoutFeature,
  withProcgen,
  withoutProcgen,
  canDeleteVertex,
  editableVertices,
  edgeMidpoints,
  minVerticesFor,
  withVertexMoved,
  withVertexInserted,
  withVertexDeleted,
  type FabricFeature,
  type FabricGeometry,
  type ProcgenBlock,
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

describe("procgen block (plan 020 §3.1)", () => {
  const block: ProcgenBlock = {
    algorithm: "city",
    seed: 123456,
    version: 1,
    params: { profile: "euro-medieval" },
  };

  it("accepts a district with a procgen block; pre-020 features parse unchanged", () => {
    const region = withProcgen(districtFeature(), block);
    expect(FabricFeatureSchema.safeParse(region).success).toBe(true);
    // A pre-020 feature (no procgen field) still parses.
    expect(FabricFeatureSchema.safeParse(districtFeature()).success).toBe(true);
  });

  it("legacy block (no presetId, plan 022 §1 additive) validates unchanged; presetId is optional", () => {
    // A pre-022 block — exactly the shape Jonah's migrated Vespergate districts
    // carry — has NO presetId. It must parse, and parsing must not inject one.
    const legacy = withProcgen(districtFeature(), block);
    const parsed = FabricFeatureSchema.safeParse(legacy);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.properties.procgen?.presetId).toBeUndefined();
      // Round-trips byte-identically (no field materialised on parse).
      expect(JSON.stringify(parsed.data.properties.procgen)).toBe(JSON.stringify(block));
    }
    // A block that DOES carry presetId (a future 022 template pick) also parses.
    const withPreset: ProcgenBlock = { ...block, presetId: "euro-medieval" };
    const parsedPreset = FabricFeatureSchema.safeParse(withProcgen(districtFeature(), withPreset));
    expect(parsedPreset.success).toBe(true);
    if (parsedPreset.success) expect(parsedPreset.data.properties.procgen?.presetId).toBe("euro-medieval");
  });

  it("defaults version to 1 and rejects malformed blocks", () => {
    const noVersion = {
      ...districtFeature(),
      properties: {
        kind: "district",
        procgen: { algorithm: "city", seed: 7, params: {} },
      },
    };
    const parsed = FabricFeatureSchema.safeParse(noVersion);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.properties.procgen?.version).toBe(1);

    const badSeed = {
      ...districtFeature(),
      properties: {
        kind: "district",
        procgen: { algorithm: "city", seed: 1.5, params: {} },
      },
    };
    expect(FabricFeatureSchema.safeParse(badSeed).success).toBe(false);
    const emptyAlgorithm = {
      ...districtFeature(),
      properties: {
        kind: "district",
        procgen: { algorithm: "", seed: 7, params: {} },
      },
    };
    expect(FabricFeatureSchema.safeParse(emptyAlgorithm).success).toBe(false);
  });

  it("withProcgen / withoutProcgen are pure and invertible; isProcgenRegion tracks the block", () => {
    const inert = districtFeature();
    expect(isProcgenRegion(inert)).toBe(false);
    const region = withProcgen(inert, block);
    expect(isProcgenRegion(region)).toBe(true);
    expect(region.properties.procgen).toEqual(block);
    expect(inert.properties.procgen).toBeUndefined(); // input not mutated
    const cleared = withoutProcgen(region);
    expect(isProcgenRegion(cleared)).toBe(false);
    expect(cleared.properties.procgen).toBeUndefined();
    expect(region.properties.procgen).toEqual(block); // input not mutated
    expect(cleared.properties.name).toBe("Old Town"); // rest of properties intact
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

describe("vertex-edit geometry ops (plan 020 §9)", () => {
  const line: FabricGeometry = { type: "LineString", coordinates: [[0, 0], [10, 0], [20, 0]] };
  // Square, closed (first === last).
  const poly: FabricGeometry = {
    type: "Polygon",
    coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]],
  };

  it("editableVertices strips a polygon's closing duplicate; passes a line through", () => {
    expect(editableVertices(poly)).toEqual([[0, 0], [10, 0], [10, 10], [0, 10]]);
    expect(editableVertices(line)).toEqual([[0, 0], [10, 0], [20, 0]]);
  });

  it("minVerticesFor: 2 line / 3 polygon", () => {
    expect(minVerticesFor(line)).toBe(2);
    expect(minVerticesFor(poly)).toBe(3);
  });

  it("withVertexMoved moves one vertex and keeps the polygon closed", () => {
    const moved = withVertexMoved(poly, 1, [15, -5]);
    expect(moved.type).toBe("Polygon");
    const ring = (moved as { coordinates: [number, number][][] }).coordinates[0];
    expect(ring[1]).toEqual([15, -5]);
    expect(ring[0]).toEqual(ring[ring.length - 1]); // still closed
    expect(ring[0]).toEqual([0, 0]); // moving index 1 doesn't disturb the closure
    // Out-of-range → unchanged.
    expect(withVertexMoved(line, 9, [1, 1])).toEqual(line);
  });

  it("withVertexMoved on line vertex 0 updates just that coordinate", () => {
    const moved = withVertexMoved(line, 0, [-5, -5]);
    expect((moved as { coordinates: [number, number][] }).coordinates).toEqual([[-5, -5], [10, 0], [20, 0]]);
  });

  it("withVertexInserted places the new vertex after the edge index; polygon closing edge is edgeIndex n-1", () => {
    const ins = withVertexInserted(line, 1, [15, 0]);
    expect((ins as { coordinates: [number, number][] }).coordinates).toEqual([[0, 0], [10, 0], [15, 0], [20, 0]]);
    // Polygon closing edge (index 3: [0,10]→[0,0]) inserts before the closure.
    const insP = withVertexInserted(poly, 3, [-5, 5]);
    const ringP = (insP as { coordinates: [number, number][][] }).coordinates[0];
    expect(ringP).toEqual([[0, 0], [10, 0], [10, 10], [0, 10], [-5, 5], [0, 0]]);
  });

  it("edgeMidpoints: a polygon has n edges (incl. closing), a line n-1", () => {
    expect(edgeMidpoints(poly).map((m) => m.edgeIndex)).toEqual([0, 1, 2, 3]);
    expect(edgeMidpoints(poly)[3].point).toEqual([0, 5]); // closing edge [0,10]→[0,0]
    expect(edgeMidpoints(line).map((m) => m.edgeIndex)).toEqual([0, 1]);
  });

  it("canDeleteVertex / withVertexDeleted enforce the min-vertex floor", () => {
    expect(canDeleteVertex(poly)).toBe(true); // 4 > 3
    const deleted = withVertexDeleted(poly, 2);
    const ring = (deleted as { coordinates: [number, number][][] }).coordinates[0];
    expect(ring).toEqual([[0, 0], [10, 0], [0, 10], [0, 0]]); // triangle, still closed
    // A triangle is at the floor — deleting refuses (returns unchanged).
    expect(canDeleteVertex(deleted)).toBe(false);
    expect(withVertexDeleted(deleted, 0)).toEqual(deleted);
    // A 2-point line is at its floor.
    const seg: FabricGeometry = { type: "LineString", coordinates: [[0, 0], [1, 1]] };
    expect(canDeleteVertex(seg)).toBe(false);
    expect(withVertexDeleted(seg, 0)).toEqual(seg);
  });
});
