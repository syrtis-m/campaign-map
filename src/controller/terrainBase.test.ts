import { describe, it, expect } from "vitest";
import { FakeHost } from "./FakeHost";

/**
 * Behavioral contract for the base-terrain Apply (plan 036-D UI): editing the
 * campaign `terrain` block MUST change the campaign elevation digest, because
 * the DEM cache treats a changed digest as a stale miss and re-derives every
 * tile. This is the headless proof that the settings Apply actually refreshes
 * the surface — no live Obsidian, no screenshot.
 */
describe("base-terrain Apply → DEM digest", () => {
  it("each of campAmp / seaDatum / grade moves the digest", () => {
    const host = new FakeHost({ zoom: 6 });
    host.begin();
    const controller = host.controller;

    const digest = (): string => {
      const snap = controller.campaignElevationSnapshot();
      expect(snap).not.toBeNull();
      return snap!.digest;
    };

    const base = digest();

    host.campaign.config.terrain = { campAmp: 800, seaDatum: 0, grade: false };
    const withAmp = digest();
    expect(withAmp).not.toBe(base);

    host.campaign.config.terrain = { campAmp: 800, seaDatum: 25, grade: false };
    const withDatum = digest();
    expect(withDatum).not.toBe(withAmp);

    host.campaign.config.terrain = { campAmp: 800, seaDatum: 25, grade: true };
    const withGrade = digest();
    expect(withGrade).not.toBe(withDatum);

    // Clearing back to the absent block returns to the original digest
    // (byte-identical inert base — deleting the frontmatter key is harmless).
    host.campaign.config.terrain = undefined;
    expect(digest()).toBe(base);
  });
});
