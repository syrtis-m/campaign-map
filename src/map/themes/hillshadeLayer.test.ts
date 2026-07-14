import { describe, it, expect } from "vitest";
import { hillshadeLayer, hillshadeSourceSpec } from "./hillshadeLayer";
import { HANDCRAFTED_THEMES } from "./tokens";
import { buildThemeStyle } from "./index";
import { obsidianNativeStyle, type ObsidianCssTokens } from "../theme";
import { DEM_TILE_RES } from "../campaignDemProtocol";

/**
 * Hillshade paint coverage (plan 023 §4.2) — the per-family checklist every
 * generated layer family gets: present in every theme's built style when the
 * campaign has a DEM, absent when not, colors theme-derived, default-hidden
 * (terrain is a toggle), and NO zoom LOD (Jonah's standing ruling).
 */

const GLYPHS = "http://localhost/glyphs/{fontstack}/{range}.pbf";
const DEM = { sourceId: "dem-x", url: "campaigndem://x/{z}/{x}/{y}" };
const OBSIDIAN_TOKENS: ObsidianCssTokens = {
  backgroundPrimary: "#1e1e1e",
  backgroundSecondary: "#262626",
  backgroundModifierBorder: "#4d4d4d",
  textMuted: "#999999",
  textNormal: "#dcddde",
  interactiveAccent: "#7c3aed",
  fontText: "sans-serif",
};

describe("hillshadeSourceSpec", () => {
  it("is a terrarium raster-dem source whose tileSize matches the served image", () => {
    const spec = hillshadeSourceSpec("campaigndem://x/{z}/{x}/{y}") as Record<string, unknown>;
    expect(spec.type).toBe("raster-dem");
    expect(spec.encoding).toBe("terrarium");
    expect(spec.tileSize).toBe(DEM_TILE_RES);
    expect(spec.tiles).toEqual(["campaigndem://x/{z}/{x}/{y}"]);
  });
});

describe("hillshadeLayer across every theme", () => {
  for (const [id, tokens] of Object.entries(HANDCRAFTED_THEMES)) {
    it(`${id}: hillshade paints theme-derived colors, default-hidden, no zoom LOD`, () => {
      const layer = hillshadeLayer(tokens, "dem-x") as unknown as {
        id: string;
        type: string;
        source: string;
        minzoom?: number;
        maxzoom?: number;
        layout?: { visibility?: string };
        paint?: Record<string, unknown>;
      };
      expect(layer.id).toBe("hillshade");
      expect(layer.type).toBe("hillshade");
      expect(layer.source).toBe("dem-x");
      // Terrain is a TOGGLE: relief shading must not surprise-render on open.
      expect(layer.layout?.visibility).toBe("none");
      // Zoom LOD is location-name-only (Jonah 2026-07-12) — never a zoom gate.
      expect(layer.minzoom).toBeUndefined();
      expect(layer.maxzoom).toBeUndefined();
      // All three shading colors present and rgba-formatted (theme-derived).
      for (const key of ["hillshade-shadow-color", "hillshade-highlight-color", "hillshade-accent-color"]) {
        expect(String(layer.paint?.[key]), `${id} ${key}`).toMatch(/^rgba\(\d+, \d+, \d+, /);
      }
    });
  }

  it("shadow is darker than highlight in every theme (the relief read)", () => {
    const lumaOf = (c: string): number => {
      const m = c.match(/rgba\((\d+), (\d+), (\d+)/)!;
      return 0.3 * Number(m[1]) + 0.59 * Number(m[2]) + 0.11 * Number(m[3]);
    };
    for (const [id, tokens] of Object.entries(HANDCRAFTED_THEMES)) {
      const paint = (hillshadeLayer(tokens, "s") as unknown as { paint: Record<string, string> }).paint;
      expect(
        lumaOf(paint["hillshade-shadow-color"]),
        `${id}: shadow must be darker than highlight`
      ).toBeLessThan(lumaOf(paint["hillshade-highlight-color"]));
    }
  });
});

describe("style assembly (fictional = DEM present; real-city = absent)", () => {
  it("buildThemeStyle with dem: source + hillshade layer present, in the hillshade z-slot", () => {
    for (const [id, tokens] of Object.entries(HANDCRAFTED_THEMES)) {
      const style = buildThemeStyle(tokens, GLYPHS, undefined, DEM);
      expect(style.sources[DEM.sourceId], `${id} dem source`).toBeDefined();
      const ids = style.layers.map((l) => l.id);
      const hi = ids.indexOf("hillshade");
      expect(hi, `${id} hillshade layer`).toBeGreaterThan(-1);
      // Below every generated- vector layer (relief shades the ground UNDER fabric).
      const firstGenerated = ids.findIndex((l) => l.startsWith("generated-"));
      expect(hi).toBeLessThan(firstGenerated);
    }
  });

  it("obsidian-native runtime style carries the same hillshade shape", () => {
    const style = obsidianNativeStyle(OBSIDIAN_TOKENS, GLYPHS, undefined, DEM);
    expect(style.sources[DEM.sourceId]).toBeDefined();
    expect(style.layers.some((l) => l.id === "hillshade")).toBe(true);
  });

  it("no dem param → no hillshade source or layer (real-city shape unchanged)", () => {
    const style = buildThemeStyle(HANDCRAFTED_THEMES.parchment, GLYPHS);
    expect(style.sources[DEM.sourceId]).toBeUndefined();
    expect(style.layers.some((l) => l.id === "hillshade")).toBe(false);
  });
});
