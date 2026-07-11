import { z } from "zod";
import { GENERATION_TIERS } from "../gen/cache/tileGrid";

/**
 * Durable generation manifest (plan 019, D1): the record of "areas the GM
 * explicitly asked to generate." What persists is the REQUEST, not the
 * output — feature output stays regenerable JSONL in `.mapcache/`, so
 * deleting the cache remains harmless (the manifest replays on map open:
 * cache hit or deterministic regenerate). Lives at `<campaign>/Generated.json`
 * (synced, tiny, merge-friendly) — see generatedManifestStore.ts for IO.
 * Pure (zod only — no DOM/map/Obsidian imports).
 */
export const ManifestEntrySchema = z.object({
  id: z.string().min(1),
  tier: z.enum(GENERATION_TIERS),
  tileX: z.number().int(),
  tileY: z.number().int(),
  createdAt: z.number(),
});
export type ManifestEntry = z.infer<typeof ManifestEntrySchema>;

export const GeneratedManifestSchema = z.object({
  entries: z.array(ManifestEntrySchema),
});
export type GeneratedManifest = z.infer<typeof GeneratedManifestSchema>;

export function emptyManifest(): GeneratedManifest {
  return { entries: [] };
}

/** Natural key: one entry per (tier, tile) — regenerating an area updates the
 * existing entry rather than duplicating it. */
export function manifestEntryId(tier: string, tileX: number, tileY: number): string {
  return `${tier}:${tileX}:${tileY}`;
}

/** Pure upsert (replace-by-id, same contract as fabric's withFeature). */
export function withEntry(manifest: GeneratedManifest, entry: ManifestEntry): GeneratedManifest {
  return { entries: [...manifest.entries.filter((e) => e.id !== entry.id), entry] };
}

/** Pure remove-by-id; a no-op copy if the id isn't present. */
export function withoutEntry(manifest: GeneratedManifest, id: string): GeneratedManifest {
  return { entries: manifest.entries.filter((e) => e.id !== id) };
}

/** Every entry (any tier) covering the given generation-space tile. */
export function entriesForTile(manifest: GeneratedManifest, tileX: number, tileY: number): ManifestEntry[] {
  return manifest.entries.filter((e) => e.tileX === tileX && e.tileY === tileY);
}

/**
 * IO-boundary parse with per-entry salvage (same contract as parseFabric):
 * one malformed entry is skipped and counted, never discards the rest —
 * bad data → warning, never silent drop (CLAUDE.md).
 */
export function parseManifest(raw: string): { manifest: GeneratedManifest; invalidCount: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { manifest: emptyManifest(), invalidCount: 1 };
  }
  const whole = GeneratedManifestSchema.safeParse(parsed);
  if (whole.success) return { manifest: whole.data, invalidCount: 0 };

  const maybe = parsed as { entries?: unknown };
  if (!Array.isArray(maybe?.entries)) {
    return { manifest: emptyManifest(), invalidCount: 1 };
  }
  const entries: ManifestEntry[] = [];
  let invalidCount = 0;
  for (const e of maybe.entries) {
    const one = ManifestEntrySchema.safeParse(e);
    if (one.success) entries.push(one.data);
    else invalidCount++;
  }
  return { manifest: { entries }, invalidCount };
}
