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

  it("accepts an optional reference underlay block and fills its defaults (plan 041)", () => {
    const result = parseCampaignConfig("Cradle.map.md", "Cradle", {
      "map-campaign": true,
      crs: "fictional",
      underlay: {
        image: "Campaigns/Cradle/reference.png",
        sw: [-10, 20],
        ne: [30, 60],
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const u = result.campaign.config.underlay;
      expect(u?.image).toBe("Campaigns/Cradle/reference.png");
      expect(u?.sw).toEqual([-10, 20]);
      expect(u?.ne).toEqual([30, 60]);
      // Defaults: fully opaque + visible.
      expect(u?.opacity).toBe(1);
      expect(u?.visible).toBe(true);
    }
  });

  it("rejects an underlay with an out-of-range opacity", () => {
    const result = parseCampaignConfig("Cradle.map.md", "Cradle", {
      "map-campaign": true,
      crs: "fictional",
      underlay: { image: "ref.png", sw: [0, 0], ne: [1, 1], opacity: 5 },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects an underlay missing the image path", () => {
    const result = parseCampaignConfig("Cradle.map.md", "Cradle", {
      "map-campaign": true,
      crs: "fictional",
      underlay: { sw: [0, 0], ne: [1, 1] },
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
