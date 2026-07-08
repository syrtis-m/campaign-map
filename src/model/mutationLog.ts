import { z } from "zod";
import type { App } from "obsidian";

/**
 * Append-only mutation log (architecture §3, "Mutation log"): powers undo/redo and
 * the Phase 5 campaign-replay keepsake. Only *map-originated* writes are logged
 * (quick-add creation, drag-to-move) — canon truth is the notes themselves; editing
 * a note directly in the editor is not a "map mutation" and isn't logged here.
 */
export const LogEntrySchema = z.object({
  ts: z.number(),
  type: z.enum(["create", "move"]),
  campaignId: z.string(),
  path: z.string(),
  // create: the full frontmatter written. move: {from:[x,y], to:[x,y]}.
  data: z.record(z.string(), z.unknown()),
});
export type LogEntry = z.infer<typeof LogEntrySchema>;

function logPath(campaignFolder: string): string {
  return `${campaignFolder}/.mapcache/log.jsonl`;
}

export async function appendLogEntry(
  app: App,
  campaignFolder: string,
  entry: LogEntry
): Promise<void> {
  const path = logPath(campaignFolder);
  const dir = `${campaignFolder}/.mapcache`;
  if (!(await app.vault.adapter.exists(dir))) {
    await app.vault.adapter.mkdir(dir);
  }
  const line = JSON.stringify(entry) + "\n";
  if (await app.vault.adapter.exists(path)) {
    await app.vault.adapter.append(path, line);
  } else {
    await app.vault.adapter.write(path, line);
  }
}

export async function readLog(app: App, campaignFolder: string): Promise<LogEntry[]> {
  const path = logPath(campaignFolder);
  if (!(await app.vault.adapter.exists(path))) return [];
  const raw = await app.vault.adapter.read(path);
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => LogEntrySchema.parse(JSON.parse(l)));
}

export function campaignFolderFromConfigPath(configPath: string): string {
  const idx = configPath.lastIndexOf("/");
  return idx >= 0 ? configPath.slice(0, idx) : "";
}
