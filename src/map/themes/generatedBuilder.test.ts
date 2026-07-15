import { describe, it, expect } from "vitest";
import type { LayerSpecification } from "maplibre-gl";
import { buildGeneratedLayers } from "./generatedBuilder";
import { roleColorsForTheme } from "./roleColors";
import { HANDCRAFTED_THEMES, type ThemeTokens } from "./tokens";
import { obsidianTokensAsThemeTokens, type ObsidianCssTokens } from "../theme";
import {
  ALL_STYLE_CONTRACTS,
  MOUNTAIN_STYLE_CONTRACT,
  type BucketStyle,
} from "../../gen/procgen/styleContract";

const OBSIDIAN_CSS: ObsidianCssTokens = {
  backgroundPrimary: "#1e1e1e",
  backgroundSecondary: "#262626",
  backgroundModifierBorder: "#4d4d4d",
  textMuted: "#999999",
  textNormal: "#dcddde",
  interactiveAccent: "#7c3aed",
  fontText: "sans-serif",
};

/** All five shipping themes as ThemeTokens. */
const ALL_THEMES: ThemeTokens[] = [
  ...Object.values(HANDCRAFTED_THEMES),
  obsidianTokensAsThemeTokens(OBSIDIAN_CSS),
];

function paintKey(layer: LayerSpecification, key: string): unknown {
  return (layer as { paint?: Record<string, unknown> }).paint?.[key];
}

describe("generatedBuilder — the one-line-add property", () => {
  // The exit test: dummy buckets added to ONE algorithm's contract (here as a
  // test-only clone — never committed to the real contract) must paint in every
  // theme with no per-theme edit, proving a new bucket needs zero theme work.
  // One per generic mark (fill/line/point) so every branch of the default
  // painter — the actual mechanism behind the property — is exercised, not just
  // fill.
  it("dummy contract buckets paint in all five themes from their contract entry alone (every mark)", () => {
    const added: { bucket: BucketStyle; type: string; colorKey: string }[] = [
      { bucket: { gid: "test-fill", mark: "fill", role: "accent", z: 990 }, type: "fill", colorKey: "fill-color" },
      { bucket: { gid: "test-line", mark: "line", role: "route", z: 991 }, type: "line", colorKey: "line-color" },
      { bucket: { gid: "test-point", mark: "point", role: "water", z: 992 }, type: "circle", colorKey: "circle-color" },
    ];
    const extra = added.map((a) => a.bucket);
    const contracts = ALL_STYLE_CONTRACTS.map((c) =>
      c === MOUNTAIN_STYLE_CONTRACT ? [...c, ...extra] : c
    );
    for (const theme of ALL_THEMES) {
      const layers = buildGeneratedLayers(theme, contracts);
      const roles = roleColorsForTheme(theme);
      for (const { bucket, type, colorKey } of added) {
        const layer = layers.find((l) => l.id === `generated-${bucket.gid}`);
        expect(layer, `${theme.id}: ${bucket.gid} produced no layer`).toBeDefined();
        expect(layer!.type, `${theme.id}: ${bucket.gid} mark`).toBe(type);
        // Painted the bucket's role, resolved from the role→value map — no
        // per-theme code path.
        expect(paintKey(layer!, colorKey), `${theme.id}: ${bucket.gid} wrong color`).toBe(roles[bucket.role]);
      }
    }
  });

  it("removing the dummy buckets is equally one-line (the real contract has no test buckets)", () => {
    for (const theme of ALL_THEMES) {
      const ids = buildGeneratedLayers(theme).map((l) => l.id);
      for (const gid of ["test-fill", "test-line", "test-point"]) {
        expect(ids).not.toContain(`generated-${gid}`);
      }
    }
  });

  it("an unpainted bucket contributes no layer (city-block stays invisible)", () => {
    const ids = buildGeneratedLayers(HANDCRAFTED_THEMES.parchment).map((l) => l.id);
    expect(ids).not.toContain("generated-city-block");
    expect(ids).not.toContain("generated-block");
  });
});
