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
  /**
   * Sketched-fabric per-kind colors (plan 017). Every fabric kind must render
   * visibly distinct from the other five in every theme — river ≠ water, park
   * reads green, wall reads stony, road reads as road, district is a subtle
   * wash. Shades of existing theme hues where that reads fine (fabricWater is
   * usually the water hue; fabricRoad usually roadMajor); new hues only where
   * the palette genuinely lacked one (park green, wall stone) — palette
   * discipline per quality-bar F6.
   */
  fabricWater: string; // water-body fill
  fabricRiver: string; // river line — same family as water but clearly distinct in shade
  fabricRoad: string; // sketched road line
  /** Darker under-line for a CASED path (plan 027-A): drawn below + wider than
   * `fabricRoad` so a park path reads with a rim on both banks. Optional so the
   * addition stays additive against older theme literals; paint falls back to
   * `fabricWall`. */
  fabricPathCasing?: string;
  /** Shore-casing rim on a water body (plan 027-A): a thin line on the pond
   * boundary, distinct from `fabricWater`. Optional (additive); paint falls back
   * to `fabricRiver`. */
  fabricWaterShore?: string;
  fabricWall: string; // masonry/boundary line (dashed) — stony, never a label gray
  fabricPark: string; // greenspace fill — the per-theme green (manicured/lawn)
  fabricForest: string; // woodland canopy fill — a DEEPER, less-manicured green than fabricPark (plan 022 §3.2)
  fabricFarmland: string; // tilled-field fill — a warm cultivated ochre/khaki, distinct from both greens (plan 022 §3.5)
  fabricMountain: string; // rocky-relief massif fill — a stony grey-brown, distinct from the wall stone + the greens (plan 023 §3)
  fabricDistrict: string; // neighborhood wash — rendered at low opacity, must not slab the base
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
  // Fabric (plan 017), Google-genre: water blue reused; river a deeper road-map
  // blue; sketched roads get the arterial gold (distinct from white generated
  // streets); wall a warm concrete gray; park the classic pale-park green;
  // district the "area of interest" peach wash.
  fabricWater: "#a8d0e8",
  fabricRiver: "#5a9bd4",
  fabricRoad: "#f0c948",
  fabricPathCasing: "#b8901f", // darker goldenrod under the gold path fill
  fabricWaterShore: "#5f8fb0", // deeper blue rim on the pale pond
  fabricWall: "#857a68",
  fabricPark: "#a8d5a2",
  fabricForest: "#6fae72", // deeper than the pale park green — reads as woodland
  fabricFarmland: "#d9c48a", // warm cultivated wheat-tan, distinct from both greens
  fabricMountain: "#b3a596", // warm rocky taupe, greyer/browner than the wall concrete
  fabricDistrict: "#e07f4f",
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
  // Fabric (plan 017), atlas-genre: water keeps the sage wash; rivers are the
  // blue-gray ink line of hand-drawn atlases (clearly not the sage); roads stay
  // the theme's brown ink; walls a darker, grayer stone ink (plus the existing
  // dash) so masonry ≠ road; parks an olive-leaf green distinct from the sage
  // water; districts a dusty-rose hand-tint wash (accent family).
  fabricWater: "#c9d6c5",
  fabricRiver: "#6f8fa0",
  fabricRoad: "#8a6f4d",
  fabricPathCasing: "#5f4a30", // darker brown ink under the path fill
  fabricWaterShore: "#8ba086", // deeper sage rim on the sage pond
  fabricWall: "#5e564a",
  fabricPark: "#9db87a",
  fabricForest: "#6d8f4e", // muted olive-green woodland, sits on parchment
  fabricFarmland: "#c9b070", // aged wheat-ochre, the hand-tinted field wash on parchment
  fabricMountain: "#a89272", // dun rock-brown, the hand-drawn massif tint on parchment
  fabricDistrict: "#8f4a3d",
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
  // Fabric (plan 017), ink-noir: water lifted a touch bluer than the pinned
  // basemap water so a sketched harbor doesn't vanish into the soot land;
  // rivers a steel-blue line readable on near-black; roads keep the theme's
  // ink gray; walls a dark-khaki sandstone (visibly lighter + warmer than
  // roads); parks a moss green; districts a smoky-violet gaslight wash.
  fabricWater: "#1a2530",
  fabricRiver: "#4a6478",
  fabricRoad: "#4a4642",
  fabricPathCasing: "#2b2825", // near-black rim under the ink-gray path fill
  fabricWaterShore: "#38546b", // lighter steel rim, reads on near-black water
  fabricWall: "#8a7a5f",
  fabricPark: "#5f7a4d",
  fabricForest: "#43613a", // dark ink-soot canopy, deeper than the park green
  fabricFarmland: "#6e6144", // dark tilled-earth khaki, warmer than the moss greens
  fabricMountain: "#5a5348", // dark slate-brown rock on the soot land, distinct from the sandstone wall
  fabricDistrict: "#584a6b",
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
  // Fabric (plan 017), neon-noir: water a deep teal clearly bluer than the
  // near-black land (the pinned #101820 was indistinguishable from #0d0d11);
  // rivers an electric blue distinct from the cyan roads; roads keep the cyan
  // glow; walls a warning-stripe orange (security perimeter, plus dash);
  // parks a synthetic green; districts the classic low-opacity neon-purple
  // wash (kept subtle — see the purple-slab note in generatedLayers.ts).
  fabricWater: "#10344a",
  fabricRiver: "#3a7bd5",
  fabricRoad: "#00e5ff",
  fabricPathCasing: "#087a8c", // darker cyan glow-base under the neon path
  fabricWaterShore: "#1f6a8f", // lighter teal rim, reads on the deep-teal water
  fabricWall: "#ff6a3d",
  fabricPark: "#30c85e",
  fabricForest: "#1f9e6d", // neon teal-green canopy, distinct from the bright park green
  fabricFarmland: "#b89b3a", // synthetic amber cropland, distinct from the neon greens
  fabricMountain: "#4a4a5e", // cold gunmetal rock, a desaturated slate against the neon palette
  fabricDistrict: "#8034a8",
  fontRegular: "Saira Condensed Regular",
  fontRegion: "Rajdhani Bold",
};

export const HANDCRAFTED_THEMES: Record<string, ThemeTokens> = {
  "modern-clean": MODERN_CLEAN,
  parchment: PARCHMENT,
  "ink-soot": INK_SOOT,
  "neon-sprawl": NEON_SPRAWL,
};
