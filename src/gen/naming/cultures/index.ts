import type { NamingCulture, NamingGenre } from "../culture";
import { fantasyBrackish } from "./fantasyBrackish";
import { fantasySunlit } from "./fantasySunlit";
import { modernAnglo } from "./modernAnglo";
import { modernMediterranean } from "./modernMediterranean";
import { neonCorpo } from "./neonCorpo";
import { neonStreet } from "./neonStreet";

export const NAMING_CULTURES: Record<string, NamingCulture> = {
  "fantasy-brackish": fantasyBrackish,
  "fantasy-sunlit": fantasySunlit,
  "modern-anglo": modernAnglo,
  "modern-mediterranean": modernMediterranean,
  "neon-corpo": neonCorpo,
  "neon-street": neonStreet,
};

export function culturesForGenre(genre: NamingGenre): NamingCulture[] {
  return Object.values(NAMING_CULTURES).filter((c) => c.genre === genre);
}

export function genreForCampaign(crs: "fictional" | "real", theme: string): NamingGenre {
  if (crs === "real") return "modern";
  if (theme === "neon-sprawl") return "neon";
  return "fantasy";
}

/**
 * Phase 1 stub mapping: one culture per campaign, inferred from crs/theme.
 * Phase 3a gives each campaign region-level naming cultures instead — see
 * src/gen/naming/regions.ts and docs/03 roadmap 3a.
 */
export function cultureForCampaign(crs: "fictional" | "real", theme: string): NamingCulture {
  const genre = genreForCampaign(crs, theme);
  return culturesForGenre(genre)[0] ?? fantasyBrackish;
}
