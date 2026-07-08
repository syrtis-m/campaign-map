/**
 * Pinned theme tokens (docs/06 §3) — exact values; agent may tune ±10% L/C in OKLCH,
 * logged in DECISIONS.md, never hue. ≤8 semantic colors per theme (quality-bar F6).
 */
export interface ThemeTokens {
  id: string;
  land: string;
  water: string;
  roadMajor: string;
  roadMajorCasing?: string; // modern-clean's gold casing, neon-sprawl's glow casing
  roadMinor: string;
  labelMajor: string;
  labelMinor: string;
  accent: string;
  poi: string;
  fontRegular: string; // glyph stack name (fontstack)
  fontRegion: string; // glyph stack name for region/accent labels
}

export const MODERN_CLEAN: ThemeTokens = {
  id: "modern-clean",
  // land tuned darker than the original #f8f7f2 pin (~6L in OKLCH, within the
  // ±10% L/C budget above, logged in DECISIONS.md): white roads/buildings need
  // real separation from the land fill to read at all — #f8f7f2 was close
  // enough to #ffffff that minor roads all but vanished into the background,
  // which was also dragging down how legible labelMajor text looked even
  // though its own contrast ratio was technically fine. Real Google Maps'
  // land tone is a soft gray for the same reason, not near-white.
  land: "#eae7de",
  water: "#a8d0e8",
  roadMajor: "#ffffff",
  roadMajorCasing: "#f0c948",
  roadMinor: "#ffffff",
  labelMajor: "#33322e",
  labelMinor: "#7a786f",
  accent: "#1a73e8",
  poi: "#5f6368",
  fontRegular: "Inter Regular",
  fontRegion: "Inter Bold",
};

export const PARCHMENT: ThemeTokens = {
  id: "parchment",
  land: "#f2e8cf",
  water: "#c9d6c5",
  roadMajor: "#8a6f4d",
  roadMinor: "#b09a76",
  labelMajor: "#4a3b28",
  labelMinor: "#7d6a4f",
  accent: "#7d1f1f",
  poi: "#5c4a2e",
  fontRegular: "Alegreya Regular",
  fontRegion: "Cormorant SC SemiBold",
};

export const INK_SOOT: ThemeTokens = {
  id: "ink-soot",
  land: "#22211f",
  water: "#14181c",
  roadMajor: "#4a4642",
  roadMinor: "#35322e",
  labelMajor: "#c9c4bb",
  labelMinor: "#7d7871",
  accent: "#b8860b",
  poi: "#948b7f",
  fontRegular: "IBM Plex Serif Regular",
  fontRegion: "Oswald Regular",
};

export const NEON_SPRAWL: ThemeTokens = {
  id: "neon-sprawl",
  land: "#0d0d11",
  water: "#101820",
  roadMajor: "#00e5ff",
  roadMajorCasing: "#00e5ff",
  roadMinor: "#cc3ecf",
  labelMajor: "#eaeaea",
  labelMinor: "#8a93a6",
  accent: "#fcee0a",
  poi: "#00e5ff",
  fontRegular: "Saira Condensed Regular",
  fontRegion: "Rajdhani Bold",
};

export const HANDCRAFTED_THEMES: Record<string, ThemeTokens> = {
  "modern-clean": MODERN_CLEAN,
  parchment: PARCHMENT,
  "ink-soot": INK_SOOT,
  "neon-sprawl": NEON_SPRAWL,
};
