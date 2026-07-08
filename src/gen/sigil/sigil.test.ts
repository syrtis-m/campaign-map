import { describe, expect, it } from "vitest";
import { generateSigil } from "./sigil";

describe("generateSigil determinism", () => {
  it("same seed twice is byte-identical", () => {
    const a = generateSigil(4181);
    const b = generateSigil(4181);
    expect(a).toBe(b);
  });

  it("different seeds produce different sigils", () => {
    const a = generateSigil(4181);
    const b = generateSigil(4182);
    expect(a).not.toBe(b);
  });

  it("produces well-formed SVG", () => {
    const svg = generateSigil(4181);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  });
});

describe("generateSigil seeded snapshot fixtures", () => {
  it("seed 4181 (Ashfall)", () => {
    expect(generateSigil(4181)).toMatchSnapshot();
  });

  it("seed 1 (Nightreach placeholder)", () => {
    expect(generateSigil(1)).toMatchSnapshot();
  });

  it("seed 999999 (large seed)", () => {
    expect(generateSigil(999999)).toMatchSnapshot();
  });

  it("respects explicit background/foreground overrides", () => {
    expect(generateSigil(4181, { background: "#f2e8cf", foreground: "#7d1f1f", size: 48 })).toMatchSnapshot();
  });
});
