import type { App } from "obsidian";
import type { ParsedCampaign } from "../model/campaignConfig";
import { campaignFolderFromConfigPath } from "../model/mutationLog";
import {
  emptyManifest,
  parseManifest,
  withEntry,
  withoutEntry,
  type GeneratedManifest,
  type ManifestEntry,
} from "../model/generatedManifest";

/**
 * Generation-manifest store (plan 019, D1): ONE per-campaign
 * `<campaign>/Generated.json` — durable + synced (it's the GM's *requests*,
 * not regenerable output, which stays in `.mapcache/`). Vault adapter only
 * (CLAUDE.md: never Node fs). Mirrors fabricStore's load/save/add/remove
 * shape, including per-entry salvage on parse.
 */
export function generatedManifestPath(campaign: ParsedCampaign): string {
  return `${campaignFolderFromConfigPath(campaign.path)}/Generated.json`;
}

/** Missing file → empty manifest (a campaign starts with nothing generated).
 * Malformed entries are skipped per-entry and counted, never silently
 * dropped wholesale (CLAUDE.md IO-boundary rule). */
export async function loadGeneratedManifest(
  app: App,
  campaign: ParsedCampaign
): Promise<{ manifest: GeneratedManifest; invalidCount: number }> {
  const path = generatedManifestPath(campaign);
  if (!(await app.vault.adapter.exists(path))) {
    return { manifest: emptyManifest(), invalidCount: 0 };
  }
  return parseManifest(await app.vault.adapter.read(path));
}

export async function saveGeneratedManifest(
  app: App,
  campaign: ParsedCampaign,
  manifest: GeneratedManifest
): Promise<void> {
  await app.vault.adapter.write(generatedManifestPath(campaign), JSON.stringify(manifest, null, 2));
}

/** Load → upsert-by-id → save. Returns the saved manifest. */
export async function addGeneratedManifestEntry(
  app: App,
  campaign: ParsedCampaign,
  entry: ManifestEntry
): Promise<GeneratedManifest> {
  const { manifest } = await loadGeneratedManifest(app, campaign);
  const next = withEntry(manifest, entry);
  await saveGeneratedManifest(app, campaign, next);
  return next;
}

/** Load → remove-by-id (many) → save. Returns removed entries (for the
 * `clear-area` log record) and the saved manifest. */
export async function removeGeneratedManifestEntries(
  app: App,
  campaign: ParsedCampaign,
  ids: string[]
): Promise<{ manifest: GeneratedManifest; removed: ManifestEntry[] }> {
  const { manifest } = await loadGeneratedManifest(app, campaign);
  const idSet = new Set(ids);
  const removed = manifest.entries.filter((e) => idSet.has(e.id));
  let next = manifest;
  for (const id of ids) next = withoutEntry(next, id);
  await saveGeneratedManifest(app, campaign, next);
  return { manifest: next, removed };
}
