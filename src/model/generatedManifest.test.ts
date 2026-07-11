import { describe, expect, it } from "vitest";
import {
  emptyManifest,
  entriesForTile,
  manifestEntryId,
  parseManifest,
  withEntry,
  withoutEntry,
  type ManifestEntry,
} from "./generatedManifest";

function entry(tier: "world" | "city", tileX: number, tileY: number): ManifestEntry {
  return { id: manifestEntryId(tier, tileX, tileY), tier, tileX, tileY, createdAt: 1720000000000 };
}

describe("withEntry / withoutEntry", () => {
  it("upserts by id — regenerating an area never duplicates its entry", () => {
    const a = entry("city", 0, 0);
    const m1 = withEntry(emptyManifest(), a);
    const m2 = withEntry(m1, { ...a, createdAt: 1720000009999 });
    expect(m2.entries).toHaveLength(1);
    expect(m2.entries[0].createdAt).toBe(1720000009999);
  });

  it("removes by id and is a no-op for unknown ids", () => {
    const m = withEntry(emptyManifest(), entry("world", 1, 2));
    expect(withoutEntry(m, manifestEntryId("world", 1, 2)).entries).toHaveLength(0);
    expect(withoutEntry(m, "city:9:9").entries).toHaveLength(1);
  });
});

describe("entriesForTile", () => {
  it("returns every tier's entry covering a tile", () => {
    let m = emptyManifest();
    m = withEntry(m, entry("world", 0, 0));
    m = withEntry(m, entry("city", 0, 0));
    m = withEntry(m, entry("city", 1, 0));
    expect(entriesForTile(m, 0, 0).map((e) => e.tier).sort()).toEqual(["city", "world"]);
    expect(entriesForTile(m, 1, 0)).toHaveLength(1);
    expect(entriesForTile(m, 5, 5)).toHaveLength(0);
  });
});

describe("parseManifest", () => {
  it("round-trips a valid manifest", () => {
    const m = withEntry(emptyManifest(), entry("city", 3, -2));
    const { manifest, invalidCount } = parseManifest(JSON.stringify(m));
    expect(invalidCount).toBe(0);
    expect(manifest).toEqual(m);
  });

  it("salvages per-entry: one malformed entry is skipped and counted, the rest survive", () => {
    const good = entry("world", 0, 0);
    const raw = JSON.stringify({ entries: [good, { id: "bad", tier: "nope", tileX: 0, tileY: 0 }] });
    const { manifest, invalidCount } = parseManifest(raw);
    expect(invalidCount).toBe(1);
    expect(manifest.entries).toEqual([good]);
  });

  it("unparseable JSON or a non-manifest shape → empty manifest, counted once", () => {
    expect(parseManifest("{not json").invalidCount).toBe(1);
    expect(parseManifest("{not json").manifest.entries).toHaveLength(0);
    expect(parseManifest('{"entries": 42}').invalidCount).toBe(1);
  });
});
