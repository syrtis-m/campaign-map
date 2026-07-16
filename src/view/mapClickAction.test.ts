import { describe, it, expect } from "vitest";
import { resolveMapClickAction, resolveContextMenuSections } from "./mapClickAction";

describe("resolveMapClickAction — left-click grammar (Jonah 2026-07-15)", () => {
  it("left-click on a location pin with no tool active is a no-op — NO place card, NO menu", () => {
    // The regression the ruling targets: clicking a pin used to open the place
    // card popup. It must not open any popup now.
    expect(resolveMapClickAction({ sketchMode: false, canonHit: true, connectionHit: false })).toBe(
      "canon-noop"
    );
  });

  it("a pin hit does NOT fall through to plant a dropped pin underneath it", () => {
    // Even if the connection layer would also report a hit, a pin short-circuits
    // to the no-op — never a dropped pin.
    expect(resolveMapClickAction({ sketchMode: false, canonHit: true, connectionHit: true })).toBe(
      "canon-noop"
    );
  });

  it("click on empty map keeps the 'dropped pin + Add location here' grammar", () => {
    expect(resolveMapClickAction({ sketchMode: false, canonHit: false, connectionHit: false })).toBe(
      "dropped-pin"
    );
  });

  it("click on a connection line still shows its card", () => {
    expect(resolveMapClickAction({ sketchMode: false, canonHit: false, connectionHit: true })).toBe(
      "connection"
    );
  });

  it("sketch mode owns the pipeline regardless of what's under the click", () => {
    expect(resolveMapClickAction({ sketchMode: true, canonHit: true, connectionHit: false })).toBe(
      "sketch"
    );
    expect(resolveMapClickAction({ sketchMode: true, canonHit: false, connectionHit: false })).toBe(
      "sketch"
    );
  });
});

describe("resolveContextMenuSections — right-click keeps every capability reachable", () => {
  it("right-click on a location pin surfaces the location section (the retired place card's actions)", () => {
    const sections = resolveContextMenuSections({
      canonHit: true,
      fabricHit: false,
      fictional: true,
    });
    expect(sections.location).toBe(true);
  });

  it("right-click off any pin has no location section", () => {
    const sections = resolveContextMenuSections({
      canonHit: false,
      fabricHit: false,
      fictional: true,
    });
    expect(sections.location).toBe(false);
  });

  it("fabric and generation sections track their own predicates independently", () => {
    expect(resolveContextMenuSections({ canonHit: false, fabricHit: true, fictional: false })).toEqual(
      { location: false, fabric: true, generation: false }
    );
    expect(resolveContextMenuSections({ canonHit: true, fabricHit: false, fictional: true })).toEqual(
      { location: true, fabric: false, generation: true }
    );
  });
});
