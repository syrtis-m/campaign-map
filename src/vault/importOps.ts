import type { App } from "obsidian";
import type { ParsedCampaign } from "../model/campaignConfig";
import { campaignFolderFromConfigPath } from "../model/mutationLog";
import type { ImportedNote } from "../model/importGeojson";
import { sanitizeNoteName } from "../model/importGeojson";
import { createLocationNote, createLocationNoteWithSidecar } from "./locationOps";

/**
 * Writes imported notes into the vault. Reuses the same write paths as the
 * rest of the app: point notes go through
 * `createLocationNote` (the quick-add flow's path); Line/Polygon notes go
 * through `createLocationNoteWithSidecar` (the complex-geometry path),
 * which writes a `<name>.geojson` sidecar and a note whose
 * `geometry` frontmatter is the sidecar's vault-relative path — the shape
 * `locationNote.ts`'s validator expects. Both append to the mutation log,
 * same as any other map-originated write.
 *
 * Idempotent: importing the same FeatureCollection twice skips any note
 * whose target `.md` path already exists, rather than creating "Name 2.md"
 * duplicates.
 */
export async function importNotes(app: App, campaign: ParsedCampaign, notes: ImportedNote[]): Promise<number> {
  const campaignFolder = campaignFolderFromConfigPath(campaign.path);
  const locationsFolder = `${campaignFolder}/Locations`;
  let created = 0;

  for (const note of notes) {
    const name = sanitizeNoteName(note.name);
    const targetPath = `${locationsFolder}/${name}.md`;
    if (await app.vault.adapter.exists(targetPath)) continue;

    try {
      if (note.point) {
        await createLocationNote(app, campaign, note.point, name, note.type);
      } else if (note.geojson) {
        await createLocationNoteWithSidecar(app, campaign, note.geojson.geometry, name, note.type);
      } else {
        continue;
      }
      created++;
    } catch {
      // Duplicate name race, malformed geometry, etc — skip this one and
      // keep importing the rest rather than aborting the whole batch.
      continue;
    }
  }

  return created;
}
