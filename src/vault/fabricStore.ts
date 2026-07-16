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

