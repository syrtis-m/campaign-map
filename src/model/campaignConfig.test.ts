import { describe, it, expect } from "vitest";
import { parseCampaignConfig, slugify } from "./campaignConfig";

describe("parseCampaignConfig", () => {
  it("accepts a minimal valid fictional campaign and fills defaults", () => {
    const result = parseCampaignConfig("Ashfall.map.md", "Ashfall", {
      "map-campaign": true,
      crs: "fictional",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.campaign.id).toBe("ashfall");
      expect(result.campaign.config.theme).toBe("obsidian-native");
      expect(result.campaign.config.scaleMetersPerUnit).toBe(1);
    }
  });

  it("round-trips an explicit real-city config", () => {
    const fm = {
      "map-campaign": true,
      crs: "real",
      theme: "modern-clean",
      seed: 42,
      scaleMetersPerUnit: 1,
      basemap: "basemap.pmtiles",
    };
    const result = parseCampaignConfig("London.map.md", "London", fm);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.campaign.config).toMatchObject(fm);
  });

  it("accepts an optional namingCultures restriction", () => {
    const result = parseCampaignConfig("Ashfall.map.md", "Ashfall", {
      "map-campaign": true,
      crs: "fictional",
      namingCultures: ["fantasy-brackish"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.campaign.config.namingCultures).toEqual(["fantasy-brackish"]);
  });

  it("rejects missing crs", () => {
    const result = parseCampaignConfig("Bad.map.md", "Bad", { "map-campaign": true });
    expect(result.ok).toBe(false);
  });

  it("rejects a config missing the map-campaign marker (never silently drops — caller must warn)", () => {
    const result = parseCampaignConfig("NotAMap.map.md", "NotAMap", { crs: "fictional" });
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown theme id", () => {
    const result = parseCampaignConfig("Bad.map.md", "Bad", {
      "map-campaign": true,
      crs: "fictional",
      theme: "not-a-real-theme",
    });
    expect(result.ok).toBe(false);
  });
});

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("The Brine Cathedral")).toBe("the-brine-cathedral");
  });

  it("strips punctuation", () => {
    expect(slugify("Wrenhaven's Docks!")).toBe("wrenhaven-s-docks");
  });

  it("trims leading/trailing hyphens", () => {
    expect(slugify("  --Ashfall--  ")).toBe("ashfall");
  });
});
