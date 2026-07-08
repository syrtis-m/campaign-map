import { describe, expect, it } from "vitest";
import { culturesForGenre } from "./index";

describe("culturesForGenre", () => {
  it("returns the full genre set when restrictTo is omitted", () => {
    expect(culturesForGenre("fantasy").length).toBeGreaterThan(1);
  });

  it("narrows to restrictTo when it intersects the genre", () => {
    const result = culturesForGenre("fantasy", ["fantasy-brackish"]);
    expect(result.map((c) => c.id)).toEqual(["fantasy-brackish"]);
  });

  it("falls back to the full set when restrictTo doesn't intersect the genre", () => {
    const full = culturesForGenre("fantasy");
    const result = culturesForGenre("fantasy", ["neon-corpo"]);
    expect(result.map((c) => c.id)).toEqual(full.map((c) => c.id));
  });

  it("falls back to the full set when restrictTo is empty", () => {
    const full = culturesForGenre("modern");
    expect(culturesForGenre("modern", [])).toEqual(full);
  });
});
