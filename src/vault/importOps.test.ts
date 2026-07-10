import { describe, expect, it } from "vitest";
import type { App, TFile } from "obsidian";
import type { ParsedCampaign } from "../model/campaignConfig";
import type { ImportedNote } from "../model/importGeojson";
import { importNotes } from "./importOps";

/**
 * `createLocationNote`/`createLocationNoteWithSidecar` (reused by
 * `importNotes`) only touch `app.vault.adapter.{exists,mkdir,write,append}`
 * and `app.vault.{createFolder,create}` — no other Obsidian API surface —
 * so an in-memory fake vault is enough to exercise the real regression
 * surface (point vs. sidecar routing, idempotency) without the `obsidian`
 * package at runtime. Modeled on `locationOps.test.ts`'s `fakeApp`.
 */
function fakeApp(): { app: App; files: Map<string, string> } {
  const files = new Map<string, string>();
  const app = {
    vault: {
      adapter: {
        exists: async (path: string) => files.has(path),
        mkdir: async (path: string) => {
          files.set(path, files.get(path) ?? "");
        },
        write: async (path: string, data: string) => {
          files.set(path, data);
        },
        append: async (path: string, data: string) => {
          files.set(path, (files.get(path) ?? "") + data);
        },
      },
      createFolder: async (path: string) => {
        files.set(path, files.get(path) ?? "");
      },
      create: async (path: string, data: string) => {
        if (files.has(path)) throw new Error(`already exists: ${path}`);
        files.set(path, data);
        return { path } as TFile;
      },
    },
  } as unknown as App;
  return { app, files };
}

const campaign: ParsedCampaign = {
  id: "ashfall",
  name: "Ashfall",
  path: "Ashfall/Ashfall.map.md",
  config: {} as ParsedCampaign["config"],
};

describe("importNotes", () => {
  it("writes a point note via the plain create path (no sidecar)", async () => {
    const { app, files } = fakeApp();
    const notes: ImportedNote[] = [{ name: "Barleyanbrook", type: "town", point: [12, 34], geojson: null }];
    const created = await importNotes(app, campaign, notes);
    expect(created).toBe(1);
    const body = files.get("Ashfall/Locations/Barleyanbrook.md");
    expect(body).toContain("geometry: [12, 34]");
    expect(body).toContain("type: town");
    expect(files.has("Ashfall/Locations/Barleyanbrook.geojson")).toBe(false);
  });

  it("writes a polygon note + sidecar .geojson via the sidecar create path", async () => {
    const { app, files } = fakeApp();
    const feature: GeoJSON.Feature = {
      type: "Feature",
      properties: {},
      geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
    };
    const notes: ImportedNote[] = [{ name: "The Sump", type: "district", point: null, geojson: feature }];
    const created = await importNotes(app, campaign, notes);
    expect(created).toBe(1);
    const notePath = "Ashfall/Locations/The Sump.md";
    const sidecarPath = "Ashfall/Locations/The Sump.geojson";
    expect(files.has(sidecarPath)).toBe(true);
    expect(JSON.parse(files.get(sidecarPath)!)).toMatchObject({ geometry: { type: "Polygon" } });
    const body = files.get(notePath)!;
    expect(body).toContain(`geometry: "${sidecarPath}"`);
    expect(body).toContain("type: district");
  });

  it("is idempotent — re-importing a note whose target .md already exists is skipped", async () => {
    const { app, files } = fakeApp();
    const notes: ImportedNote[] = [{ name: "Barleyanbrook", type: "town", point: [12, 34], geojson: null }];
    const first = await importNotes(app, campaign, notes);
    const before = files.get("Ashfall/Locations/Barleyanbrook.md");
    const second = await importNotes(app, campaign, notes);
    expect(first).toBe(1);
    expect(second).toBe(0);
    // No "Barleyanbrook 2.md" duplicate, and the original note is untouched.
    expect(files.has("Ashfall/Locations/Barleyanbrook 2.md")).toBe(false);
    expect(files.get("Ashfall/Locations/Barleyanbrook.md")).toBe(before);
  });

  it("returns 0 for an empty note list", async () => {
    const { app } = fakeApp();
    expect(await importNotes(app, campaign, [])).toBe(0);
  });

  it("processes a mixed batch, counting only the notes actually created", async () => {
    const { app, files } = fakeApp();
    const notes: ImportedNote[] = [
      { name: "Barleyanbrook", type: "town", point: [12, 34], geojson: null },
      {
        name: "Old King's Road",
        type: "route",
        point: null,
        geojson: {
          type: "Feature",
          properties: {},
          geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] },
        },
      },
    ];
    const created = await importNotes(app, campaign, notes);
    expect(created).toBe(2);
    expect(files.has("Ashfall/Locations/Barleyanbrook.md")).toBe(true);
    expect(files.has("Ashfall/Locations/Old King's Road.md")).toBe(true);
    expect(files.has("Ashfall/Locations/Old King's Road.geojson")).toBe(true);
  });
});
