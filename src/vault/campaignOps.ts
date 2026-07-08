import type { App } from "obsidian";
import { slugify } from "../model/campaignConfig";
import type { CampaignConfig } from "../model/campaignConfig";

export interface NewCampaignInput {
  name: string;
  crs: CampaignConfig["crs"];
  theme: CampaignConfig["theme"];
  seed: number;
  scaleMetersPerUnit: number;
  // fictional only — real campaigns get bounds from their basemap instead
  bounds?: [number, number, number, number];
}

export interface NewCampaignResult {
  path: string;
  campaignFolder: string;
}

/** Vault layout matches docs/02 §3 exactly: <folder>/<Name>.map.md, Locations/,
 * Sessions/ (organizational only, never read by code — see docs/02). */
export async function createCampaignNote(app: App, input: NewCampaignInput): Promise<NewCampaignResult> {
  const name = input.name.trim();
  if (!name) throw new Error("Campaign name is required");

  const campaignFolder = `Campaigns/${name}`;
  if (await app.vault.adapter.exists(campaignFolder)) {
    throw new Error(`"${campaignFolder}" already exists`);
  }

  await app.vault.createFolder(campaignFolder);
  await app.vault.createFolder(`${campaignFolder}/Locations`);
  await app.vault.createFolder(`${campaignFolder}/Sessions`);

  const lines = [
    "---",
    "map-campaign: true",
    `crs: ${input.crs}`,
    `theme: ${input.theme}`,
    `seed: ${input.seed}`,
    `scaleMetersPerUnit: ${input.scaleMetersPerUnit}`,
  ];
  if (input.crs === "fictional" && input.bounds) {
    lines.push("bounds:");
    for (const n of input.bounds) lines.push(`  - ${n}`);
  }
  lines.push("---", "", `${name} — campaign map.`, "");

  const path = `${campaignFolder}/${name}.map.md`;
  await app.vault.create(path, lines.join("\n"));

  return { path, campaignFolder };
}

export { slugify };
