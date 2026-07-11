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
  /** Procgen v3: city-tier entries created inside a city domain carry the
   * domain's id so replay can compute each domain network once and clip all
   * of its tiles from that single artifact. Optional — pre-v3 entries (and
   * world-tier entries) simply have none. */
  domainId: z.string().optional(),
});
export type ManifestEntry = z.infer<typeof ManifestEntrySchema>;

/**
 * A city domain (procgen v3, design §3.1): the GM-requested disc a whole
 * city network is generated for. Persisted as part of the request — the
 * network itself stays regenerable cache. `createdAt` is host-side metadata
 * and is never read by generators (design rule D6).
 */
export const CityDomainSchema = z.object({
  id: z.string().min(1),
  cx: z.number(),
  cy: z.number(),
  radius: z.number().min(100).max(3000),
  profile: z.enum(["euro-medieval", "euro-continental", "na-grid", "na-suburb"]),
  createdAt: z.number(),
});
export type ManifestCityDomain = z.infer<typeof CityDomainSchema>;

export const GeneratedManifestSchema = z.object({
  entries: z.array(ManifestEntrySchema),
  /** `.default([])` keeps every pre-v3 Generated.json parsing unchanged. */
  domains: z.array(CityDomainSchema).default([]),
});
export type GeneratedManifest = z.infer<typeof GeneratedManifestSchema>;

export function emptyManifest(): GeneratedManifest {
  return { entries: [], domains: [] };
}

/** Natural key: one entry per (tier, tile) — regenerating an area updates the
 * existing entry rather than duplicating it. */
export function manifestEntryId(tier: string, tileX: number, tileY: number): string {
  return `${tier}:${tileX}:${tileY}`;
}

/** Pure upsert (replace-by-id, same contract as fabric's withFeature). */
export function withEntry(manifest: GeneratedManifest, entry: ManifestEntry): GeneratedManifest {
  return { ...manifest, entries: [...manifest.entries.filter((e) => e.id !== entry.id), entry] };
}

/** Pure remove-by-id; a no-op copy if the id isn't present. */
export function withoutEntry(manifest: GeneratedManifest, id: string): GeneratedManifest {
  return { ...manifest, entries: manifest.entries.filter((e) => e.id !== id) };
}

/** Pure domain upsert (replace-by-id). */
export function withDomain(manifest: GeneratedManifest, domain: ManifestCityDomain): GeneratedManifest {
  return { ...manifest, domains: [...manifest.domains.filter((d) => d.id !== domain.id), domain] };
}

/** Pure domain remove-by-id; entries referencing it are the caller's job
 * (MapView's clear-domain flow removes both + the cache records). */
export function withoutDomain(manifest: GeneratedManifest, id: string): GeneratedManifest {
  return { ...manifest, domains: manifest.domains.filter((d) => d.id !== id) };
}

export function domainById(manifest: GeneratedManifest, id: string): ManifestCityDomain | undefined {
  return manifest.domains.find((d) => d.id === id);
}

/** Every entry generated as part of the given domain. */
export function entriesForDomain(manifest: GeneratedManifest, domainId: string): ManifestEntry[] {
  return manifest.entries.filter((e) => e.domainId === domainId);
}

/** The domain whose disc contains the generation-space point, if any. */
export function domainAtPoint(manifest: GeneratedManifest, x: number, y: number): ManifestCityDomain | undefined {
  return manifest.domains.find((d) => (x - d.cx) ** 2 + (y - d.cy) ** 2 <= d.radius ** 2);
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

  const maybe = parsed as { entries?: unknown; domains?: unknown };
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
  const domains: ManifestCityDomain[] = [];
  if (Array.isArray(maybe.domains)) {
    for (const d of maybe.domains) {
      const one = CityDomainSchema.safeParse(d);
      if (one.success) domains.push(one.data);
      else invalidCount++;
    }
  }
  return { manifest: { entries, domains }, invalidCount };
}
