/**
 * Style-token goldens: pin every handcrafted theme's BUILT style JSON, so a
 * changed token value (a color, a width ramp, a layer recipe) shows up as a
 * reviewable diff — schema validity alone (styleValidation.test.ts) accepts
 * any valid hex. A deliberate theme retune re-accepts these via
 * `npx vitest run src/map/themes/styleGolden.test.ts -u` with the diff
 * eyeballed at acceptance.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildThemeStyle, HANDCRAFTED_THEMES } from "./index";

const GLYPHS = "http://localhost/glyphs/{fontstack}/{range}.pbf";
const BASEMAP = { sourceId: "basemap", url: "pmtiles://basemap.pmtiles" };
const DEM = { sourceId: "dem-test", url: "campaigndem://test/{z}/{x}/{y}" };

function digest(style: unknown): string {
  return createHash("sha256").update(JSON.stringify(style)).digest("hex").slice(0, 16);
}

describe("handcrafted theme styles are byte-pinned (token-value golden)", () => {
  for (const [id, tokens] of Object.entries(HANDCRAFTED_THEMES)) {
    it(`${id}: fictional / basemap / dem style digests match the committed golden`, () => {
      expect({
        fictional: digest(buildThemeStyle(tokens, GLYPHS)),
        basemap: digest(buildThemeStyle(tokens, GLYPHS, BASEMAP)),
        dem: digest(buildThemeStyle(tokens, GLYPHS, undefined, DEM)),
      }).toMatchSnapshot();
    });
  }
});
