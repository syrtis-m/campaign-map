import { describe, it, expect } from "vitest";
import { LogEntrySchema, campaignFolderFromConfigPath, type LogEntry } from "./mutationLog";
import { sketchUndoTarget, type FabricFeature } from "./fabric";

function sketchAddEntry(id: string): LogEntry {
  const feature: FabricFeature = {
    type: "Feature",
    id,
    geometry: { type: "LineString", coordinates: [[0, 0], [10, 5]] },
    properties: { kind: "road", mode: "generate" },
  };
  return {
    ts: 1_700_000_000_000,
    type: "sketch-add",
    campaignId: "camp-1",
    path: "Campaigns/Ashfall/Fabric.geojson",
    data: feature as unknown as Record<string, unknown>,
  };
}

describe("mutation-log round-trip (undo relies on this)", () => {
  it("serializes a sketch-add entry to JSONL and parses it back unchanged", () => {
    const entry = sketchAddEntry("fabric-x");
    // The append format is exactly `JSON.stringify(entry) + "\n"` (mutationLog).
    const line = JSON.stringify(entry) + "\n";
    const parsed = LogEntrySchema.parse(JSON.parse(line.trim()));
    expect(parsed).toEqual(entry);
    expect(parsed.type).toBe("sketch-add");
    // The embedded FabricFeature survives the trip, so undo can reconstruct it.
    expect((parsed.data as { id: string }).id).toBe("fabric-x");
  });

  it("round-trips a whole JSONL file (multiple entries, trailing newline)", () => {
    const entries = [sketchAddEntry("a"), sketchAddEntry("b")];
    const jsonl = entries.map((e) => JSON.stringify(e) + "\n").join("");
    const readBack = jsonl
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => LogEntrySchema.parse(JSON.parse(l)));
    expect(readBack).toHaveLength(2);
    // The undo target derives from the parsed log — most recent live add.
    expect(sketchUndoTarget(readBack)?.id).toBe("b");
  });

  it("rejects an entry with an unknown mutation type", () => {
    const bad = { ...sketchAddEntry("a"), type: "explode" };
    expect(LogEntrySchema.safeParse(bad).success).toBe(false);
  });
});

describe("campaignFolderFromConfigPath", () => {
  it("strips the config filename to the campaign folder", () => {
    expect(campaignFolderFromConfigPath("Campaigns/Ashfall/campaign.md")).toBe("Campaigns/Ashfall");
  });

  it("returns empty string for a bare filename", () => {
    expect(campaignFolderFromConfigPath("campaign.md")).toBe("");
  });
});
