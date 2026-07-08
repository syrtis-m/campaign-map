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

/**
 * `restrictTo` narrows to a campaign's chosen culture ids (map-naming-cultures
 * frontmatter, see campaignConfig.ts). Falls back to the full genre set if
 * unset/empty, or if it doesn't intersect the genre at all (e.g. a stale id
 * left over from a theme change) — a restriction can never zero out naming.
 */
export function culturesForGenre(genre: NamingGenre, restrictTo?: string[]): NamingCulture[] {
  const all = Object.values(NAMING_CULTURES).filter((c) => c.genre === genre);
  if (!restrictTo || restrictTo.length === 0) return all;
  const restricted = all.filter((c) => restrictTo.includes(c.id));
  return restricted.length > 0 ? restricted : all;
}

export function genreForCampaign(crs: "fictional" | "real", theme: string): NamingGenre {
  if (crs === "real") return "modern";
  if (theme === "neon-sprawl") return "neon";
  return "fantasy";
}
