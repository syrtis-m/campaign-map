import type { App, TFile } from "obsidian";
import type { ParsedCampaign } from "../model/campaignConfig";
import {
  type ParsedLocation,
  type Visibility,
  defaultVisibilityForType,
} from "../model/locationNote";
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

/** The ≤5s yes-and flow's write path: quick-add confirm → vault note → mutation log.
 * `visibility` is written EXPLICITLY so label visibility is a visible,
 * editable field and never re-derived from `type`; callers that don't set it get a
 * type-hinted default (a convenience, still written explicitly). */
export async function createLocationNote(
  app: App,
  campaign: ParsedCampaign,
  point: [number, number],
  name: string,
  type: string,
  visibility: Visibility = defaultVisibilityForType(type)
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
    visibility,
  };
  const body = `---\nmap: ${frontmatter.map}\ngeometry: [${point[0]}, ${point[1]}]\ntype: ${type}\nvisibility: ${visibility}\n---\n`;
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
 * Non-point location geometry (e.g. an imported river or district) —
 * "complex geometry → sidecar .geojson" (CLAUDE.md conventions).
 * Frontmatter's `geometry` field holds the vault-relative sidecar path
 * instead of a point tuple; `parseLocationNote` already accepts either shape.
 */
export async function createLocationNoteWithSidecar(
  app: App,
  campaign: ParsedCampaign,
  geometry: GeoJSON.Geometry,
  name: string,
  type: string,
  visibility: Visibility = defaultVisibilityForType(type)
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
  const frontmatter = { map: campaign.id, geometry: geojsonPath, type, visibility };
  const body = `---\nmap: ${frontmatter.map}\ngeometry: "${geojsonPath}"\ntype: ${type}\nvisibility: ${visibility}\n---\n`;
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

/** Place-card edit: retune a note's label visibility mid-session with one
 * control. Writes the explicit `visibility` field and drops any legacy
 * `focus` key so the note never carries two conflicting sources of truth. The
 * metadataCache `changed` event re-reconciles and re-dispatches the map. */
export async function setLocationVisibility(
  app: App,
  location: ParsedLocation,
  visibility: Visibility
): Promise<void> {
  const file = app.vault.getFileByPath(location.path);
  if (!file) return;
  await app.fileManager.processFrontMatter(file, (fm) => {
    fm.visibility = visibility;
    delete fm.focus; // legacy raw-bucket key; `visibility` is now the source of truth
  });
}

/**
 * Point-crawl connections (the `connections:` frontmatter schema — a bare
 * string or `{to,type?,label?}`) — the "Connect to..." place-card gesture
 * writes here. Idempotent: connecting to the same target twice is a no-op.
 * Target is stored by basename (matches how `buildConnectionFeatures`'s
 * resolver looks up `byName`), not by full vault path.
 */
export async function addConnection(
  app: App,
  sourcePath: string,
  targetBasename: string,
  label?: string
): Promise<void> {
  const file = app.vault.getFileByPath(sourcePath);
  if (!file) return;
  await app.fileManager.processFrontMatter(file, (fm) => {
    const list: unknown[] = Array.isArray(fm.connections) ? fm.connections : [];
    const already = list.some((c) =>
      typeof c === "string" ? c === targetBasename : (c as { to?: string })?.to === targetBasename
    );
    if (already) return;
    list.push(label ? { to: targetBasename, label } : targetBasename);
    fm.connections = list;
  });
}

/** Removes a connection to `targetBasename` from `sourcePath`'s frontmatter, if
 * present. A no-op if the source never declared it (e.g. the edge was declared
 * from the other end) — deletes the whole `connections` key once it's empty. */
export async function removeConnection(app: App, sourcePath: string, targetBasename: string): Promise<void> {
  const file = app.vault.getFileByPath(sourcePath);
  if (!file) return;
  await app.fileManager.processFrontMatter(file, (fm) => {
    if (!Array.isArray(fm.connections)) return;
    fm.connections = fm.connections.filter((c: unknown) =>
      typeof c === "string" ? c !== targetBasename : (c as { to?: string })?.to !== targetBasename
    );
    if (fm.connections.length === 0) delete fm.connections;
  });
}
