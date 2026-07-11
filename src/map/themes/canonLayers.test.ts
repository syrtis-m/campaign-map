import { describe, it, expect } from "vitest";
import { canonLayers, focusLabelLayers, focusLabelLayerId, FOCUS_REVEAL_ZOOM_DEFAULT } from "./canonLayers";
import { FOCUS_DEPTHS } from "../../model/locationNote";

const OPTS = {
  pointColor: "#fff",
  pointHaloColor: "#000",
  textColor: "#fff",
  textHaloColor: "#000",
  fontStack: "Inter Regular",
};

describe("depth-of-field label layers (the whole zoom-legibility model)", () => {
  it("emits one always-on dot layer plus one label layer per focus bucket", () => {
    const layers = canonLayers(OPTS);
    expect(layers.find((l) => l.id === "canon-point")?.type).toBe("circle");
    for (const depth of FOCUS_DEPTHS) {
      expect(layers.find((l) => l.id === `canon-label-${depth}`)?.type).toBe("symbol");
    }
  });

  it("NEVER puts zoom in a label filter — it invalidates the whole style (blank map)", () => {
    // The load-bearing constraint. A `["zoom"]` expression in a layer `filter`
    // silently fails the entire style with no console error and green unit
    // tests. Reveal floors live on `minzoom` instead (asserted below). This has
    // shipped twice; this test is the tripwire.
    for (const layer of focusLabelLayers({ source: "canon", prefix: "canon", ...OPTS })) {
      const filter = JSON.stringify((layer as { filter?: unknown }).filter);
      expect(filter).not.toContain('"zoom"');
      expect(filter).toContain('"focus"');
    }
  });

  it("gates each bucket by a numeric minzoom reveal floor, deep always-on", () => {
    for (const depth of FOCUS_DEPTHS) {
      const layer = focusLabelLayers({ source: "canon", prefix: "canon", ...OPTS }).find(
        (l) => l.id === focusLabelLayerId("canon", depth)
      ) as { minzoom?: number };
      expect(typeof layer.minzoom).toBe("number");
      expect(layer.minzoom).toBe(FOCUS_REVEAL_ZOOM_DEFAULT[depth]);
    }
    expect(FOCUS_REVEAL_ZOOM_DEFAULT.deep).toBe(0); // deep = labeled at all focus levels
  });

  it("canon and generated build byte-identical label recipes (provenance invisibility, F2)", () => {
    const canon = focusLabelLayers({ source: "canon", prefix: "canon", ...OPTS });
    const gen = focusLabelLayers({ source: "generated", prefix: "generated", ...OPTS });
    for (let i = 0; i < canon.length; i++) {
      const strip = (l: unknown) => {
        const c = structuredClone(l) as { id?: string; source?: string };
        delete c.id;
        delete c.source;
        return c;
      };
      expect(strip(gen[i])).toEqual(strip(canon[i]));
    }
  });
});
