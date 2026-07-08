import { describe, it, expect } from "vitest";
import { generateName, generateNameSuggestions } from "./culture";
import { fantasyBrackish } from "./cultures/fantasyBrackish";
import { hashSeed } from "../rng";

describe("generateName", () => {
  it("is deterministic for a given seed", () => {
    const a = generateName(hashSeed(4181, "test"), fantasyBrackish);
    const b = generateName(hashSeed(4181, "test"), fantasyBrackish);
    expect(a).toBe(b);
  });

  it("differs across seeds (not a constant)", () => {
    const names = new Set(
      Array.from({ length: 10 }, (_, i) => generateName(hashSeed(4181, i), fantasyBrackish))
    );
    expect(names.size).toBeGreaterThan(1);
  });

  it("capitalizes the first letter", () => {
    const name = generateName(hashSeed(1, 2, 3), fantasyBrackish);
    expect(name[0]).toBe(name[0].toUpperCase());
  });
});

describe("generateNameSuggestions", () => {
  it("returns the requested count of unique names, deterministically", () => {
    const a = generateNameSuggestions(4181, fantasyBrackish, 3, "quickadd");
    const b = generateNameSuggestions(4181, fantasyBrackish, 3, "quickadd");
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(3);
  });

  it("a different salt yields a different batch", () => {
    const a = generateNameSuggestions(4181, fantasyBrackish, 3, "batch-1");
    const b = generateNameSuggestions(4181, fantasyBrackish, 3, "batch-2");
    expect(a).not.toEqual(b);
  });
});
