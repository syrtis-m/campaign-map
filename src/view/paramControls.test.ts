import { describe, it, expect } from "vitest";
import { allAlgorithms, algorithmById, algorithmSupportsCenter } from "../gen/procgen/registry";
import { paramFieldSpecs, schemaParamKeys, humanizeKey, presentedParamSpecs, presentedParams, presentedParamPatch } from "./paramControls";

/**
 * The standing net that makes "a procgen param without a GUI control" a failing
 * test forever. For EVERY registered algorithm, the schema-driven control specs
 * must (1) cover exactly the schema's param keys and (2) all be renderable
 * (never `unsupported`). Adding a new param to any algorithm's zod schema —
 * without this module learning to render its type — fails here, before it can
 * ship engine-first with no GUI.
 */
describe("procgen param GUI contract", () => {
  for (const algorithm of allAlgorithms()) {
    describe(`${algorithm.id}`, () => {
      const schema = algorithm.paramsSchema;
      const specs = paramFieldSpecs(schema);
      const schemaKeys = schemaParamKeys(schema);

      it("exposes a control spec for every schema param (⊇ and ⊆)", () => {
        expect(schemaKeys.length).toBeGreaterThan(0); // schema is a ZodObject we could walk
        const specKeys = new Set(specs.map((s) => s.key));
        // Every schema key has a spec, and no spec invents a key.
        expect([...specKeys].sort()).toEqual([...new Set(schemaKeys)].sort());
      });

      it("renders every param (no unsupported zod types)", () => {
        const unsupported = specs.filter((s) => s.kind === "unsupported");
        expect(unsupported).toEqual([]);
      });

      it("numeric specs carry finite bounds/step where the schema declares them", () => {
        for (const s of specs) {
          if (s.kind !== "number") continue;
          if (s.min !== undefined) expect(Number.isFinite(s.min)).toBe(true);
          if (s.max !== undefined) expect(Number.isFinite(s.max)).toBe(true);
        }
      });
    });
  }
});

describe("humanizeKey", () => {
  it("splits camelCase into a sentence-case label", () => {
    expect(humanizeKey("slopeSensitivity")).toBe("Slope sensitivity");
    expect(humanizeKey("halfWidth")).toBe("Half width");
    expect(humanizeKey("width")).toBe("Width");
  });
});

describe("presented params — relief width unification (2026-07-16)", () => {
  const relief = algorithmById("relief")!;
  it("relief specs collapse halfWidth+apron into ONE width control (schema order preserved)", () => {
    const keys = presentedParamSpecs("relief", relief.paramsSchema).map((s) => s.key);
    expect(keys).toContain("width");
    expect(keys).not.toContain("halfWidth");
    expect(keys).not.toContain("apron");
    // Everything else passes through (polarity, height).
    expect(keys).toContain("polarity");
    expect(keys).toContain("height");
  });
  it("non-relief kinds pass through untouched", () => {
    const city = algorithmById("city")!;
    expect(presentedParamSpecs("district", city.paramsSchema)).toEqual(paramFieldSpecs(city.paramsSchema));
  });
  it("presented value mirrors the live sum; a width edit writes halfWidth + zero apron", () => {
    expect(presentedParams("relief", { halfWidth: 180, apron: 220 }).width).toBe(400);
    expect(presentedParams("relief", { halfWidth: 180 }).width).toBe(180);
    expect(presentedParamPatch("relief", "width", 400)).toEqual({ halfWidth: 400, apron: 0 });
    expect(presentedParamPatch("relief", "height", 300)).toEqual({ height: 300 });
    expect(presentedParamPatch("district", "width", 5)).toEqual({ width: 5 });
  });
  it("round trip: patch → presented shows the same width (byte-identical field for equal sums)", () => {
    const patched = { polarity: "ridge", height: 300, ...presentedParamPatch("relief", "width", 400) };
    expect(presentedParams("relief", patched).width).toBe(400);
    // And the patch parses under the untouched schema (no version bump needed).
    expect(() => relief.paramsSchema.parse(patched)).not.toThrow();
  });
});

describe("algorithmSupportsCenter — schema-derived center capability", () => {
  it("city has a center; terrain stamps and vegetation do not", () => {
    expect(algorithmSupportsCenter(algorithmById("city")!)).toBe(true);
    for (const id of ["relief", "landform", "mountain", "forest", "river"]) {
      const a = algorithmById(id);
      if (a) expect(algorithmSupportsCenter(a), `${id} must not offer a center`).toBe(false);
    }
  });
});
