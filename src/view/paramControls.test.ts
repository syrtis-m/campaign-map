import { describe, it, expect } from "vitest";
import { allAlgorithms } from "../gen/procgen/registry";
import { paramFieldSpecs, schemaParamKeys, humanizeKey } from "./paramControls";

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
