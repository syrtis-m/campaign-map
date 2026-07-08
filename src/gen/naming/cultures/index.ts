import type { NamingCulture } from "../culture";
import { fantasyBrackish } from "./fantasyBrackish";
import { modernAnglo } from "./modernAnglo";
import { neonCorpo } from "./neonCorpo";

export const NAMING_CULTURES: Record<string, NamingCulture> = {
  "fantasy-brackish": fantasyBrackish,
  "modern-anglo": modernAnglo,
  "neon-corpo": neonCorpo,
};

/**
 * Phase 1 stub mapping: one culture per campaign, inferred from crs/theme.
 * Phase 3a gives each campaign region-level naming cultures instead of one
 * global pick — see docs/03 roadmap 3a.
 */
export function cultureForCampaign(crs: "fictional" | "real", theme: string): NamingCulture {
  if (crs === "real") return modernAnglo;
  if (theme === "neon-sprawl") return neonCorpo;
  return fantasyBrackish;
}
