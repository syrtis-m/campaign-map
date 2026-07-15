import { describe, expect, it } from "vitest";
import {
  domainAtPoint,
  domainById,
  emptyManifest,
  entriesForDomain,
  entriesForTile,
  manifestEntryId,
  parseManifest,
  withDomain,
  withEntry,
  withoutDomain,
  withoutEntry,
  type ManifestCityDomain,
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

// Domains are additive — old vaults must open clean.
describe("city domains", () => {
  const dom: ManifestCityDomain = {
    id: "dom:10:20",
    cx: 300,
    cy: 600,
    radius: 900,
    profile: "euro-medieval",
    createdAt: 1720000000000,
  };

  it("Generated.json without a domains key parses unchanged with domains defaulted []", () => {
    const raw = JSON.stringify({ entries: [entry("city", 3, -2)] });
    const { manifest, invalidCount } = parseManifest(raw);
    expect(invalidCount).toBe(0);
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.domains).toEqual([]);
  });

  it("round-trips domains and domainId entries", () => {
    let m = withDomain(emptyManifest(), dom);
    m = withEntry(m, { ...entry("city", 0, 0), domainId: dom.id });
    const { manifest, invalidCount } = parseManifest(JSON.stringify(m));
    expect(invalidCount).toBe(0);
    expect(manifest).toEqual(m);
  });

  it("salvages per-domain: a malformed domain is counted, the rest survive", () => {
    const raw = JSON.stringify({ entries: [], domains: [dom, { id: "bad", profile: "klingon" }] });
    const { manifest, invalidCount } = parseManifest(raw);
    expect(invalidCount).toBe(1);
    expect(manifest.domains).toEqual([dom]);
  });

  it("withDomain upserts, withoutDomain removes, lookups resolve", () => {
    let m = withDomain(emptyManifest(), dom);
    m = withDomain(m, { ...dom, radius: 1200 });
    expect(m.domains).toHaveLength(1);
    expect(domainById(m, dom.id)?.radius).toBe(1200);
    expect(withoutDomain(m, dom.id).domains).toHaveLength(0);
  });

  it("domainAtPoint hits inside the disc, misses outside", () => {
    const m = withDomain(emptyManifest(), dom);
    expect(domainAtPoint(m, 300, 600)?.id).toBe(dom.id);
    expect(domainAtPoint(m, 300 + 899, 600)?.id).toBe(dom.id);
    expect(domainAtPoint(m, 300 + 1201, 600)).toBeUndefined();
  });

  it("entriesForDomain filters by domainId", () => {
    let m = withDomain(emptyManifest(), dom);
    m = withEntry(m, { ...entry("city", 0, 0), domainId: dom.id });
    m = withEntry(m, entry("city", 5, 5));
    expect(entriesForDomain(m, dom.id)).toHaveLength(1);
  });
});
