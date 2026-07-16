import { describe, expect, it } from "vitest";
import { pluralize, countOf } from "./pluralize";

describe("pluralize", () => {
  it("consonant+y ⇒ ies", () => {
    expect(pluralize("city", 2)).toBe("cities");
  });

  it("regular consonant ⇒ +s", () => {
    expect(pluralize("forest", 2)).toBe("forests");
  });

  it("count of 1 stays singular", () => {
    expect(pluralize("city", 1)).toBe("city");
    expect(pluralize("forest", 1)).toBe("forest");
  });

  it("vowel+y ⇒ +s (not ies)", () => {
    expect(pluralize("day", 3)).toBe("days");
  });

  it("all fabric algorithm labels pluralize correctly", () => {
    expect(pluralize("city", 3)).toBe("cities");
    expect(pluralize("river", 3)).toBe("rivers");
    expect(pluralize("forest", 3)).toBe("forests");
    expect(pluralize("park", 3)).toBe("parks");
    expect(pluralize("wall", 3)).toBe("walls");
    expect(pluralize("farmland", 3)).toBe("farmlands");
  });

  it("countOf prefixes the count", () => {
    expect(countOf("city", 2)).toBe("2 cities");
    expect(countOf("city", 1)).toBe("1 city");
  });
});
