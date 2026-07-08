import type { App } from "obsidian";
import type { RequestTransformFunction } from "maplibre-gl";

/**
 * MapLibre's `glyphs` style field must be a URL template containing the literal
 * substrings "{fontstack}"/"{range}" — no local/system-font path exists for non-CJK
 * text in this MapLibre version (see DECISIONS.md, "Pulled Inter glyph-PBF generation
 * forward"). We can't hand MapLibre a real vault resource path directly (it needs to
 * substitute per-request), so we give it an opaque scheme + intercept via
 * transformRequest, resolving each request to the real `getResourcePath()` URL.
 */
const GLYPHS_SCHEME = "campaignmap-glyphs";

export function glyphsUrlTemplate(): string {
  return `${GLYPHS_SCHEME}://glyphs/{fontstack}/{range}.pbf`;
}

export function createTransformRequest(app: App): RequestTransformFunction {
  return (url: string, resourceType?: string) => {
    if (resourceType === "Glyphs" && url.startsWith(`${GLYPHS_SCHEME}://`)) {
      const parsed = new URL(url.replace(`${GLYPHS_SCHEME}:`, "https:"));
      const [, fontstackRaw, rangeFile] = parsed.pathname.split("/");
      const fontstack = decodeURIComponent(fontstackRaw);
      const vaultPath = `${app.vault.configDir}/plugins/campaign-map/assets/fonts/glyphs/${fontstack}/${rangeFile}`;
      return { url: app.vault.adapter.getResourcePath(vaultPath) };
    }
    return { url };
  };
}
