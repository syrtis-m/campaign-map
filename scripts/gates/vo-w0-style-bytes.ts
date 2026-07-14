#!/usr/bin/env tsx
// VO-W0 byte-identical gate — the phase gate for splitting generatedLayers.ts
// into per-kind modules with ZERO behavior change.
//
// Builds the FULL style JSON for every theme via the same code paths the plugin
// uses (buildThemeStyle for the 4 handcrafted themes; obsidianNativeStyle for
// obsidian-native light + dark token sets), and dumps canonical JSON to files.
// Run once BEFORE the split (--out baseline) and once AFTER (--out after), then
// `diff -r`/`cmp` the two dirs. Any byte difference = the refactor changed
// behavior = red.
//
// Usage: tsx scripts/gates/vo-w0-style-bytes.ts --out <dir>
import { mkdirSync, writeFileSync } from "node:fs";
import { buildThemeStyle } from "../../src/map/themes/index.js";
import { HANDCRAFTED_THEMES } from "../../src/map/themes/tokens.js";
import { obsidianNativeStyle, type ObsidianCssTokens } from "../../src/map/theme.js";

const GLYPHS = "http://localhost/glyphs/{fontstack}/{range}.pbf";

// Two representative Obsidian CSS token sets — a dark and a light vault — so the
// runtime-derived obsidian-native style path is exercised both ways.
const OBSIDIAN_DARK: ObsidianCssTokens = {
  backgroundPrimary: "#1e1e1e",
  backgroundSecondary: "#262626",
  backgroundModifierBorder: "#4d4d4d",
  textMuted: "#999999",
  textNormal: "#dcddde",
  interactiveAccent: "#7c3aed",
  fontText: "sans-serif",
};
const OBSIDIAN_LIGHT: ObsidianCssTokens = {
  backgroundPrimary: "#ffffff",
  backgroundSecondary: "#f2f2f2",
  backgroundModifierBorder: "#dddddd",
  textMuted: "#666666",
  textNormal: "#222222",
  interactiveAccent: "#5b3fd6",
  fontText: "serif",
};

function outDir(): string {
  const i = process.argv.indexOf("--out");
  if (i < 0 || !process.argv[i + 1]) {
    console.error("usage: tsx scripts/gates/vo-w0-style-bytes.ts --out <dir>");
    process.exit(2);
  }
  return process.argv[i + 1];
}

function dump(dir: string, name: string, obj: unknown): void {
  // Canonical: pretty 2-space JSON, trailing newline; identical serialization
  // before/after so any real style difference shows as a byte diff.
  writeFileSync(`${dir}/${name}.json`, JSON.stringify(obj, null, 2) + "\n");
}

const dir = outDir();
mkdirSync(dir, { recursive: true });

let count = 0;
for (const [id, tokens] of Object.entries(HANDCRAFTED_THEMES)) {
  dump(dir, id, buildThemeStyle(tokens, GLYPHS));
  count++;
}
dump(dir, "obsidian-native-dark", obsidianNativeStyle(OBSIDIAN_DARK, GLYPHS));
dump(dir, "obsidian-native-light", obsidianNativeStyle(OBSIDIAN_LIGHT, GLYPHS));
count += 2;

console.log(`wrote ${count} style JSON files to ${dir}`);
