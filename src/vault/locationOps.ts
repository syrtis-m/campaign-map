import type { App, TFile } from "obsidian";
import type { ParsedCampaign } from "../model/campaignConfig";
import type { ParsedLocation } from "../model/locationNote";
import { appendLogEntry, campaignFolderFromConfigPath } from "../model/mutationLog";

function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "-").trim() || "New location";
}

async function uniquePath(app: App, folder: string, name: string, ext = "md"): Promise<string> {
  const base = sanitizeFilename(name);
  let candidate = `${folder}/${base}.${ext}`;
  let n = 2;
  while (await app.vault.adapter.exists(candidate)) {
    candidate = `${folder}/${base} ${n}.${ext}`;
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

/**
 * Non-point canon geometry (e.g. a canonized generated street) — "complex
 * geometry → sidecar .geojson" (CLAUDE.md conventions). Frontmatter's
 * `geometry` field holds the vault-relative sidecar path instead of a point
 * tuple; `parseLocationNote` already accepts either shape.
 */
export async function createLocationNoteWithSidecar(
  app: App,
  campaign: ParsedCampaign,
  geometry: GeoJSON.Geometry,
  name: string,
  type: string
): Promise<TFile> {
  const campaignFolder = campaignFolderFromConfigPath(campaign.path);
  const locationsFolder = `${campaignFolder}/Locations`;
  if (!(await app.vault.adapter.exists(locationsFolder))) {
    await app.vault.createFolder(locationsFolder);
  }

  const geojsonPath = await uniquePath(app, locationsFolder, name, "geojson");
  const sidecar: GeoJSON.Feature = { type: "Feature", geometry, properties: {} };
  await app.vault.create(geojsonPath, JSON.stringify(sidecar, null, 2));

  const path = await uniquePath(app, locationsFolder, name);
  const frontmatter = { map: campaign.id, geometry: geojsonPath, type };
  const body = `---\nmap: ${frontmatter.map}\ngeometry: "${geojsonPath}"\ntype: ${type}\n---\n`;
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

/** Canonizes any generated feature (Point → a plain location note; other
 * geometry → note + sidecar .geojson). "Canonize = create the note, remove
 * from cache" (docs/02 §5). */
export async function createLocationNoteFromFeature(
  app: App,
  campaign: ParsedCampaign,
  feature: GeoJSON.Feature,
  name: string,
  type: string
): Promise<TFile> {
  if (feature.geometry.type === "Point") {
    return createLocationNote(app, campaign, feature.geometry.coordinates as [number, number], name, type);
  }
  return createLocationNoteWithSidecar(app, campaign, feature.geometry, name, type);
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
