import type { App, TFile } from "obsidian";
import type { ParsedCampaign } from "../model/campaignConfig";
import type { ParsedLocation } from "../model/locationNote";
import { appendLogEntry, campaignFolderFromConfigPath } from "../model/mutationLog";

function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "-").trim() || "New location";
}

async function uniquePath(app: App, folder: string, name: string): Promise<string> {
  const base = sanitizeFilename(name);
  let candidate = `${folder}/${base}.md`;
  let n = 2;
  while (await app.vault.adapter.exists(candidate)) {
    candidate = `${folder}/${base} ${n}.md`;
    n++;
  }
  return candidate;
}

/** The ≤5s yes-and flow's write path: quick-add confirm → vault note → mutation log. */
export async function createLocationNote(
  app: App,
  campaign: ParsedCampaign,
  point: [number, number],
  name: string,
  type: string
): Promise<TFile> {
  const campaignFolder = campaignFolderFromConfigPath(campaign.path);
  const locationsFolder = `${campaignFolder}/Locations`;
  if (!(await app.vault.adapter.exists(locationsFolder))) {
    await app.vault.createFolder(locationsFolder);
  }

  const path = await uniquePath(app, locationsFolder, name);
  const frontmatter = {
    map: campaign.id,
    geometry: point,
    type,
  };
  const body = `---\nmap: ${frontmatter.map}\ngeometry: [${point[0]}, ${point[1]}]\ntype: ${type}\n---\n`;
  const file = await app.vault.create(path, body);

  await appendLogEntry(app, campaignFolder, {
    ts: Date.now(),
    type: "create",
    campaignId: campaign.id,
    path,
    data: frontmatter,
  });

  return file;
}

/** Drag-to-move: writes through Obsidian's frontmatter API (never hand-parse YAML). */
export async function moveLocationNote(
  app: App,
  campaign: ParsedCampaign,
  location: ParsedLocation,
  newPoint: [number, number]
): Promise<void> {
  const file = app.vault.getFileByPath(location.path);
  if (!file) return;
  const from = location.point;

  await app.fileManager.processFrontMatter(file, (fm) => {
    fm.geometry = newPoint;
  });

  const campaignFolder = campaignFolderFromConfigPath(campaign.path);
  await appendLogEntry(app, campaignFolder, {
    ts: Date.now(),
    type: "move",
    campaignId: campaign.id,
    path: location.path,
    data: { from, to: newPoint },
  });
}
