import { describe, it, expect } from "vitest";
import { wrapText, sanitizeForPdf } from "./atlasExport";

describe("wrapText", () => {
  it("returns a single line for a short string", () => {
    expect(wrapText("A quiet village on the coast.", 40)).toEqual(["A quiet village on the coast."]);
  });

  it("wraps a long string at maxChars without splitting mid-word", () => {
    const text =
      "The harbor town of Barleyanbrook has stood at the mouth of the Ash river for three centuries.";
    const lines = wrapText(text, 20);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(20);
      // no line starts or ends with a partial-word artifact like a lone
      // hyphen inserted by a splitter — every line is whole words joined
      // by single spaces.
      expect(line.trim()).toBe(line);
    }
    // re-joining preserves every original word in order
    expect(lines.join(" ").split(" ")).toEqual(text.split(" "));
  });

  it("returns [] for an empty string", () => {
    expect(wrapText("", 40)).toEqual([]);
  });

  it("returns [] for a whitespace-only string", () => {
    expect(wrapText("   \n\t  ", 40)).toEqual([]);
  });

  it("collapses internal newlines/whitespace before wrapping", () => {
    expect(wrapText("line one\nline   two", 40)).toEqual(["line one line two"]);
  });

  it("keeps a single word longer than maxChars on its own line rather than splitting it", () => {
    const longWord = "Supercalifragilisticexpialidocious";
    expect(wrapText(longWord, 10)).toEqual([longWord]);
  });
});

describe("sanitizeForPdf", () => {
  it("maps curly quotes and dashes to ASCII", () => {
    expect(sanitizeForPdf("‘hi’ “there” – — …")).toBe(`'hi' "there" - - ...`);
  });

  it("leaves plain ASCII text untouched", () => {
    expect(sanitizeForPdf("A quiet village, population 200.")).toBe("A quiet village, population 200.");
  });

  it("replaces characters outside the WinAnsi range instead of throwing", () => {
    const result = sanitizeForPdf("Beijing 北京 rolled well 🎲");
    expect(result).not.toMatch(/[北京]/);
    expect(result.startsWith("Beijing ?? rolled well ")).toBe(true);
  });

  it("strips C1 control characters (e.g. U+009F) that WinAnsi can't encode", () => {
    // Regression: pdf-lib's StandardFonts throw "WinAnsi cannot encode ..."
    // on this exact code point even though it falls inside \x00-\xFF, so it
    // slips past a naive "strip non-Latin1" filter.
    const withControlChar = `Gate${String.fromCharCode(0x9f)}way`;
    expect(sanitizeForPdf(withControlChar)).toBe("Gateway");
  });
});
