export type Biome = "ocean" | "coast" | "plains" | "forest" | "hills" | "mountains" | "desert" | "tundra";

/** Pure function of (height, moisture) — Azgaar-style classification bands. */
export function classifyBiome(height: number, moisture: number): Biome {
  if (height < 0.35) return "ocean";
  if (height < 0.4) return "coast";
  if (height > 0.85) return "mountains";
  if (height > 0.7) return "hills";
  if (moisture < 0.25) return "desert";
  if (moisture > 0.6) return "forest";
  if (height > 0.6 && moisture < 0.4) return "tundra";
  return "plains";
}

export function isLand(biome: Biome): boolean {
  return biome !== "ocean";
}
