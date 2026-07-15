import { describe, expect, it } from "vitest";
import type { App, TFile } from "obsidian";
import { CampaignConfigSchema } from "../model/campaignConfig";
import { schemaParamKeys } from "../view/paramControls";
import { createCampaignForTest, createCampaignNote } from "./campaignOps";

/**
 * `createCampaignNote` touches only `app.vault.adapter.exists`,
 * `app.vault.createFolder`, and `app.vault.create` — so an in-memory fake vault
 * exercises the real regression surface (scaffold layout + zod-validated
 * frontmatter) without the `obsidian` package. Modeled on importOps.test.ts.
 */
function fakeApp(): { app: App; files: Map<string, string>; folders: Set<string> } {
  const files = new Map<string, string>();
  const folders = new Set<string>();
  const app = {
    vault: {
      adapter: {
        exists: async (path: string) => files.has(path) || folders.has(path),
      },
      createFolder: async (path: string) => {
        folders.add(path);
      },
      create: async (path: string, data: string) => {
        if (files.has(path)) throw new Error(`already exists: ${path}`);
        files.set(path, data);
        return { path } as TFile;
      },
    },
  } as unknown as App;
  return { app, files, folders };
}

/** Parse the YAML-ish frontmatter block a created note carries. Handles the
 * scalar lines + the inline `bounds: [...]` + the nested `terrain:` block this
 * writer emits — enough to assert the persisted shape, no YAML dep. */
function frontmatterOf(note: string): Record<string, unknown> {
  const m = note.match(/^---\n([\s\S]*?)\n---/);
  if (!m) throw new Error("no frontmatter");
  const fm: Record<string, unknown> = {};
  let inTerrain = false;
  const terrain: Record<string, unknown> = {};
  for (const line of m[1].split("\n")) {
    if (line === "terrain:") {
      inTerrain = true;
      fm.terrain = terrain;
      continue;
    }
    if (inTerrain && line.startsWith("  ")) {
      const [k, v] = line.trim().split(": ");
      terrain[k] = coerce(v);
      continue;
    }
    inTerrain = false;
    const idx = line.indexOf(": ");
    if (idx === -1) continue;
    const k = line.slice(0, idx);
    const v = line.slice(idx + 2);
    if (k === "bounds") {
      fm.bounds = JSON.parse(v);
    } else {
      fm[k] = coerce(v);
    }
  }
  return fm;
}

function coerce(v: string): unknown {
  if (v === "true") return true;
  if (v === "false") return false;
  const n = Number(v);
  return Number.isFinite(n) && v.trim() !== "" ? n : v;
}

describe("createCampaignNote", () => {
  it("scaffolds folder + Locations + Sessions + a valid .map.md", async () => {
    const { app, files, folders } = fakeApp();
    const res = await createCampaignNote(app, {
      name: "Ashfall",
      crs: "fictional",
      theme: "parchment",
      seed: 42,
      scaleMetersPerUnit: 500,
      bounds: [-8, -6, 8, 6],
    });
    expect(res.path).toBe("Campaigns/Ashfall/Ashfall.map.md");
    expect(folders.has("Campaigns/Ashfall")).toBe(true);
    expect(folders.has("Campaigns/Ashfall/Locations")).toBe(true);
    expect(folders.has("Campaigns/Ashfall/Sessions")).toBe(true);

    const fm = frontmatterOf(files.get(res.path)!);
    expect(fm).toMatchObject({
      "map-campaign": true,
      crs: "fictional",
      theme: "parchment",
      seed: 42,
      scaleMetersPerUnit: 500,
      bounds: [-8, -6, 8, 6],
    });
    // The persisted frontmatter round-trips through the loader's own schema.
    expect(CampaignConfigSchema.safeParse(fm).success).toBe(true);
  });

  it("persists a terrain block when provided (and omits absent grade)", async () => {
    const { app, files } = fakeApp();
    const res = await createCampaignNote(app, {
      name: "Vale",
      crs: "fictional",
      theme: "obsidian-native",
      seed: 1,
      scaleMetersPerUnit: 1,
      bounds: [-8, -6, 8, 6],
      terrain: { campAmp: 150, seaDatum: 0, grade: false },
    });
    const fm = frontmatterOf(files.get(res.path)!);
    expect(fm.terrain).toEqual({ campAmp: 150, seaDatum: 0 });
    expect(CampaignConfigSchema.safeParse(fm).success).toBe(true);
  });

  it("omits bounds for a real-CRS campaign", async () => {
    const { app, files } = fakeApp();
    const res = await createCampaignNote(app, {
      name: "London",
      crs: "real",
      theme: "modern-clean",
      seed: 7,
      scaleMetersPerUnit: 1,
    });
    const fm = frontmatterOf(files.get(res.path)!);
    expect("bounds" in fm).toBe(false);
    expect(CampaignConfigSchema.safeParse(fm).success).toBe(true);
  });

  it("rejects a non-positive scale before writing (zod gate)", async () => {
    const { app, files, folders } = fakeApp();
    await expect(
      createCampaignNote(app, {
        name: "Bad",
        crs: "fictional",
        theme: "obsidian-native",
        seed: 1,
        scaleMetersPerUnit: 0,
      })
    ).rejects.toThrow(/Invalid campaign config/);
    // Nothing reached disk.
    expect(files.size).toBe(0);
    expect(folders.size).toBe(0);
  });

  it("refuses to clobber an existing campaign folder", async () => {
    const { app } = fakeApp();
    const input = {
      name: "Dup",
      crs: "fictional" as const,
      theme: "obsidian-native" as const,
      seed: 1,
      scaleMetersPerUnit: 1,
      bounds: [-8, -6, 8, 6] as [number, number, number, number],
    };
    await createCampaignNote(app, input);
    await expect(createCampaignNote(app, input)).rejects.toThrow(/already exists/);
  });
});

describe("createCampaignForTest (headless twin)", () => {
  it("creates a valid campaign from just a name (defaults applied)", async () => {
    const { app, files } = fakeApp();
    const res = await createCampaignForTest(app, { name: "Solo" });
    const fm = frontmatterOf(files.get(res.path)!);
    expect(fm).toMatchObject({
      "map-campaign": true,
      crs: "fictional",
      theme: "obsidian-native",
      scaleMetersPerUnit: 1,
      bounds: [-8, -6, 8, 6],
    });
    expect(typeof fm.seed).toBe("number");
    expect(CampaignConfigSchema.safeParse(fm).success).toBe(true);
  });

  it("forwards overrides including a terrain block", async () => {
    const { app, files } = fakeApp();
    const res = await createCampaignForTest(app, {
      name: "Marches",
      theme: "parchment",
      seed: 99,
      scaleMetersPerUnit: 500,
      terrain: { campAmp: 220, seaDatum: 0, grade: true },
    });
    const fm = frontmatterOf(files.get(res.path)!);
    expect(fm).toMatchObject({ theme: "parchment", seed: 99, scaleMetersPerUnit: 500 });
    expect(fm.terrain).toEqual({ campAmp: 220, seaDatum: 0, grade: true });
  });
});

/**
 * The standing net: every key in CampaignConfigSchema must be classified as
 * settable-at-creation, settable-later, or derived/internal. A new schema field
 * added without a home fails HERE — before it can ship with no way for a GM to
 * ever reach it. When you add a config field, add it to exactly one bucket
 * below (and wire the corresponding UI/twin path).
 */
describe("campaign config coverage contract", () => {
  // Settable in CreateCampaignModal / createCampaignForTest.
  const CREATION_SETTABLE = new Set(["crs", "theme", "seed", "scaleMetersPerUnit", "bounds", "terrain"]);
  // Settable later in CampaignControlModal.
  const LATER_SETTABLE = new Set(["theme", "namingCultures", "basemap", "terrain", "underlay"]);
  // Derived / internal — written by the system, never a GM knob.
  const DERIVED_INTERNAL = new Set(["map-campaign"]);

  const homed = new Set([...CREATION_SETTABLE, ...LATER_SETTABLE, ...DERIVED_INTERNAL]);

  it("classifies every schema key", () => {
    const keys = schemaParamKeys(CampaignConfigSchema);
    expect(keys.length).toBeGreaterThan(0);
    const unclassified = keys.filter((k) => !homed.has(k));
    expect(unclassified).toEqual([]);
  });

  it("does not reference keys the schema no longer has (no stale classifications)", () => {
    const keys = new Set(schemaParamKeys(CampaignConfigSchema));
    const stale = [...homed].filter((k) => !keys.has(k));
    expect(stale).toEqual([]);
  });
});
