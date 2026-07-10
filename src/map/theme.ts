import type { StyleSpecification } from "maplibre-gl";
import { canonLayers } from "./themes/canonLayers";
import { basemapLayers } from "./themes/basemapLayers";
import { generatedLayers } from "./themes/generatedLayers";
import { connectionLayers } from "./themes/connectionLayers";
import type { ThemeTokens } from "./themes/tokens";

/**
 * Default theme (architecture §4): derived at runtime from the active Obsidian
 * theme's CSS variables, so the map always matches the user's look. Handcrafted
 * genre themes (parchment, ink-soot, modern-clean, neon-sprawl — src/map/themes/)
 * are per-campaign overrides with their own craft budget (quality-bar F6).
 *
 * Font caveat: "inherit theme font" is aspirational — generating glyph PBFs for an
 * arbitrary live Obsidian font is a real asset pipeline (see DECISIONS.md, the Phase 1
 * glyph-PBF entry), so obsidian-native always renders labels in Inter regardless of the
 * user's actual body font. Colors/layout genuinely follow the live theme; typeface does not.
 */
export interface ObsidianCssTokens {
  backgroundPrimary: string;
  backgroundSecondary: string;
  backgroundModifierBorder: string;
  textMuted: string;
  textNormal: string;
  interactiveAccent: string;
  fontText: string;
}

export function readObsidianCssTokens(root: HTMLElement = document.body): ObsidianCssTokens {
  const style = getComputedStyle(root);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    backgroundPrimary: read("--background-primary", "#ffffff"),
    backgroundSecondary: read("--background-secondary", "#f2f3f5"),
    backgroundModifierBorder: read("--background-modifier-border", "#bbbbbb"),
    textMuted: read("--text-muted", "#888888"),
    textNormal: read("--text-normal", "#222222"),
    interactiveAccent: read("--interactive-accent", "#7c3aed"),
    fontText: read("--font-text", "sans-serif").replace(/^["']|["']$/g, ""),
  };
}

function obsidianTokensAsThemeTokens(tokens: ObsidianCssTokens): ThemeTokens {
  return {
    id: "obsidian-native",
    land: tokens.backgroundPrimary,
    water: tokens.backgroundSecondary,
    // Not `backgroundSecondary` (review/001): that's the same token `water`
    // uses, so roads and water bodies rendered as literally the same color
    // — near-invisible against `backgroundPrimary` on the stock dark theme.
    // `--background-modifier-border` is Obsidian's own "visible divider
    // against either background" variable, which is exactly the contrast
    // roads need.
    roadMajor: tokens.textMuted,
    roadMinor: tokens.backgroundModifierBorder,
    labelMajor: tokens.textNormal,
    labelMinor: tokens.textMuted,
    accent: tokens.interactiveAccent,
    poi: tokens.textMuted,
    fontRegular: "Inter Regular",
    fontRegion: "Inter Bold",
  };
}

export function obsidianNativeStyle(
  tokens: ObsidianCssTokens,
  glyphsUrl: string,
  basemap?: { sourceId: string; url: string }
): StyleSpecification {
  const t = obsidianTokensAsThemeTokens(tokens);
  return {
    version: 8,
    name: "obsidian-native",
    glyphs: glyphsUrl,
    sources: {
      canon: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
      generated: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
      connections: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
      ...(basemap ? { [basemap.sourceId]: { type: "vector" as const, url: basemap.url } } : {}),
    },
    layers: [
      { id: "background", type: "background", paint: { "background-color": t.land } },
      ...(basemap ? basemapLayers(basemap.sourceId, t) : []),
      ...generatedLayers(t),
      ...connectionLayers({ lineColor: t.accent }),
      ...canonLayers({
        pointColor: t.accent,
        pointHaloColor: t.land,
        textColor: t.labelMajor,
        textHaloColor: t.land,
        fontStack: t.fontRegular,
      }),
    ],
  };
}
