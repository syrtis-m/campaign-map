import { describe, it, expect } from "vitest";
import { fabricLayers, FABRIC_LAYER_IDS, FABRIC_SOURCE_SPEC } from "./fabricLayers";
import { PARCHMENT } from "./tokens";
import { FABRIC_KINDS, defaultMinZoomFor, isPolygonKind, type FabricKind } from "../../model/fabric";

describe("fabricLayers (LOD discipline — plan 013 non-negotiable)", () => {
  const layers = fabricLayers(PARCHMENT);

  it("emits exactly one layer per fabric kind, on the fabric source", () => {
    expect(layers).toHaveLength(FABRIC_KINDS.length);
    const ids = layers.map((l) => l.id);
    for (const id of FABRIC_LAYER_IDS) expect(ids).toContain(id);
    for (const l of layers) expect((l as { source?: string }).source).toBe("fabric");
  });

  it("every layer carries its kind's minzoom", () => {
    for (const kind of FABRIC_KINDS) {
      const layer = layers.find((l) => l.id === `fabric-${kind}`) as { minzoom?: number };
      expect(layer?.minzoom).toBe(defaultMinZoomFor(kind));
    }
  });

  it("line kinds are line layers, polygon kinds are fill layers", () => {
    for (const kind of FABRIC_KINDS) {
      const layer = layers.find((l) => l.id === `fabric-${kind}`)!;
      expect(layer.type).toBe(isPolygonKind(kind as FabricKind) ? "fill" : "line");
    }
  });

  it("polygon fills render before (under) line kinds", () => {
    const ids = layers.map((l) => l.id);
    const lastFill = Math.max(...FABRIC_KINDS.filter(isPolygonKind).map((k) => ids.indexOf(`fabric-${k}`)));
    const firstLine = Math.min(...FABRIC_KINDS.filter((k) => !isPolygonKind(k)).map((k) => ids.indexOf(`fabric-${k}`)));
    expect(lastFill).toBeLessThan(firstLine);
  });

  it("filters honor a per-feature minZoom override via coalesce", () => {
    for (const layer of layers) {
      const filter = JSON.stringify((layer as { filter?: unknown }).filter);
      expect(filter).toContain('"zoom"');
      expect(filter).toContain('"coalesce"');
      expect(filter).toContain('"minZoom"');
    }
  });

  it("source spec carries simplification tolerance", () => {
    expect(FABRIC_SOURCE_SPEC.type).toBe("geojson");
    expect(FABRIC_SOURCE_SPEC.tolerance).toBeGreaterThan(0);
  });
});
