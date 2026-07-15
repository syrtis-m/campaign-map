import type { App } from "obsidian";
import type { ParsedCampaign } from "../model/campaignConfig";
import { campaignFolderFromConfigPath } from "../model/mutationLog";
import {
  emptyFabric,
  parseFabric,
  withFeature,
  withoutFeature,
  type FabricCollection,
  type FabricFeature,
} from "../model/fabric";

/**
 * Sketched-fabric store: ONE per-campaign `<campaign>/Fabric.geojson` —
 * durable, synced, NOT under `.mapcache/` — read/written via the Vault adapter
 * only (CLAUDE.md: never Node fs). Fabric is background geometry ("things on
 * the map"); it never becomes a location note.
 */
export function fabricPath(campaign: ParsedCampaign): string {
  return `${campaignFolderFromConfigPath(campaign.path)}/Fabric.geojson`;
}

/** Missing file → empty collection (a campaign starts with no sketches).
 * Malformed features are skipped per-feature and counted, never silently
 * dropped wholesale (CLAUDE.md IO-boundary rule). */
export async function loadFabric(
  app: App,
  campaign: ParsedCampaign
): Promise<{ fabric: FabricCollection; invalidCount: number }> {
  const path = fabricPath(campaign);
  if (!(await app.vault.adapter.exists(path))) {
    return { fabric: emptyFabric(), invalidCount: 0 };
  }
  return parseFabric(await app.vault.adapter.read(path));
}

export async function saveFabric(
  app: App,
  campaign: ParsedCampaign,
  fabric: FabricCollection
): Promise<void> {
  await app.vault.adapter.write(fabricPath(campaign), JSON.stringify(fabric, null, 2));
}

/** Load → append (replace-by-id) → save. Returns the saved collection. */
export async function addFabricFeature(
  app: App,
  campaign: ParsedCampaign,
  feature: FabricFeature
): Promise<FabricCollection> {
  const { fabric } = await loadFabric(app, campaign);
  const next = withFeature(fabric, feature);
  await saveFabric(app, campaign, next);
  return next;
}

/** Load → remove-by-id → save. Returns the removed feature (for undo's
 * `sketch-remove` log entry) or null if the id wasn't present. */
export async function removeFabricFeature(
  app: App,
  campaign: ParsedCampaign,
  id: string
): Promise<{ fabric: FabricCollection; removed: FabricFeature | null }> {
  const { fabric } = await loadFabric(app, campaign);
  const removed = fabric.features.find((f) => f.id === id) ?? null;
  if (!removed) return { fabric, removed: null };
  const next = withoutFeature(fabric, id);
  await saveFabric(app, campaign, next);
  return { fabric: next, removed };
}
