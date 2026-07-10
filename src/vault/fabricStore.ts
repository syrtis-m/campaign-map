import type { App, TFile } from "obsidian";
import type { ParsedCampaign } from "../model/campaignConfig";
import { campaignFolderFromConfigPath } from "../model/mutationLog";
import { createLocationNoteWithSidecar } from "./locationOps";
import {
  emptyFabric,
  parseFabric,
  withFeature,
  withoutFeature,
  type FabricCollection,
  type FabricFeature,
  type FabricKind,
} from "../model/fabric";

/**
 * Sketched-fabric store (plan 013): ONE per-campaign `<campaign>/Fabric.geojson`
 * — canon (durable, synced, NOT under `.mapcache/`), read/written via the
 * Vault adapter only (CLAUDE.md: never Node fs).
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

/** Fabric kinds → the location-type taxonomy (locationNote.ts) a promoted
 * note gets, so importance/zoom-range defaults keep doing the cartographic
 * discipline for promoted fabric too. */
export const FABRIC_KIND_NOTE_TYPE: Record<FabricKind, string> = {
  road: "street(named)",
  wall: "landmark",
  river: "water-feature",
  water: "water-feature",
  district: "district",
  park: "landmark",
};

/**
 * "Promote to location note" (plan 013): creates a real location note whose
 * geometry sidecar is the fabric feature's geometry — mirroring canonize's
 * non-point path (`createLocationNoteWithSidecar`). The fabric feature is
 * intentionally KEPT in Fabric.geojson: unlike canonize (cache → note), fabric
 * is already canon, and the fabric layer is what renders the line/polygon —
 * the note adds lore + a searchable identity, it doesn't replace the drawing.
 */
export async function promoteFabricToNote(
  app: App,
  campaign: ParsedCampaign,
  id: string
): Promise<TFile | null> {
  const { fabric } = await loadFabric(app, campaign);
  const feature = fabric.features.find((f) => f.id === id);
  if (!feature) return null;
  const kind = feature.properties.kind;
  const name = feature.properties.name?.trim() || `Sketched ${kind}`;
  return createLocationNoteWithSidecar(
    app,
    campaign,
    feature.geometry as GeoJSON.Geometry,
    name,
    FABRIC_KIND_NOTE_TYPE[kind]
  );
}
