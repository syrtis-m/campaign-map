import { z } from "zod";

export const THEME_IDS = [
  "obsidian-native",
  "parchment",
  "ink-soot",
  "modern-clean",
  "neon-sprawl",
] as const;

export const CampaignConfigSchema = z.object({
  "map-campaign": z.literal(true),
  crs: z.enum(["fictional", "real"]),
  theme: z.enum(THEME_IDS).default("obsidian-native"),
  seed: z.number().int().default(1),
  scaleMetersPerUnit: z.number().positive().default(1),
  // fictional CRS: bounded box in fake [lng, lat] space, [minX, minY, maxX, maxY]
  bounds: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  // real CRS: vault-relative path to a .pmtiles basemap file
  basemap: z.string().optional(),
});

export type CampaignConfig = z.infer<typeof CampaignConfigSchema>;

export interface ParsedCampaign {
  id: string; // slug, derived from note basename
  name: string; // note basename, human-facing
  path: string; // vault path to the *.map.md note
  config: CampaignConfig;
}

export interface CampaignParseError {
  path: string;
  name: string;
  issues: string[];
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/** Parses raw frontmatter (already extracted by Obsidian's metadata cache) into a campaign config. */
export function parseCampaignConfig(
  path: string,
  name: string,
  frontmatter: unknown
): { ok: true; campaign: ParsedCampaign } | { ok: false; error: CampaignParseError } {
  const result = CampaignConfigSchema.safeParse(frontmatter);
  if (!result.success) {
    return {
      ok: false,
      error: {
        path,
        name,
        issues: result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
      },
    };
  }
  return {
    ok: true,
    campaign: { id: slugify(name), name, path, config: result.data },
  };
}
