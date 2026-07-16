/**
 * Pointer-grammar resolver for the map surface (Jonah 2026-07-15 — "if i left
 * click on a location and don't have any tool selected, it pops up a little
 * menu — that shouldn't happen. i can just access that via right click. it's
 * annoying as hell.").
 *
 * This AMENDS the locked Google-Maps grammar: a LEFT-click on a location pin no
 * longer opens the place card. The place card is retired from left-click; every
 * action it offered (Open note / Center / Connect to… / Visibility) moves to the
 * RIGHT-click native Menu, which is the one place location UI opens now. A bare
 * left-click on a pin is a deliberate no-op (the hover tooltip already surfaces
 * the name). Click-empty (dropped pin + "Add location here") and connection-line
 * cards are unchanged.
 *
 * Pure so it has a headless test twin — MapView needs a real MapLibre map + DOM,
 * so the routing decision lives here where Vitest can exercise it (same pattern
 * as fabricSelect).
 */

/** What a left-click resolves to, once features under the pointer are known. */
export type MapClickAction =
  /** Sketch mode owns the click pipeline (vertex/select). */
  | "sketch"
  /** A location pin: no popup (Jonah 2026-07-15) — right-click is the menu. */
  | "canon-noop"
  /** A point-crawl connection line: show its (removable) card. */
  | "connection"
  /** Empty map: dropped pin + "Add location here". */
  | "dropped-pin";

/** Features found under a left-click, resolved by the host before routing. */
export interface MapClickHits {
  sketchMode: boolean;
  canonHit: boolean;
  connectionHit: boolean;
}

/**
 * Route a left-click. Order mirrors the old grammar EXCEPT a pin no longer opens
 * the place card — it stops the pipeline (`canon-noop`) so no popup shows and no
 * dropped pin is planted underneath it.
 */
export function resolveMapClickAction(hits: MapClickHits): MapClickAction {
  if (hits.sketchMode) return "sketch";
  if (hits.canonHit) return "canon-noop";
  if (hits.connectionHit) return "connection";
  return "dropped-pin";
}

/** Which sections the right-click native Menu includes, given what's under it. */
export interface ContextMenuSections {
  /** Location actions (Open note / Center / Connect to… / Visibility) — present
   * only over a pin. This is where the retired place card's actions now live. */
  location: boolean;
  /** Sketch-feature actions (Edit shape / City settings…). */
  fabric: boolean;
  /** Explicit procgen actions — fictional campaigns only. */
  generation: boolean;
}

/** Decide the right-click menu composition. The base section (Add location here
 * / Copy coordinates) is always present, so it isn't modeled here. */
export function resolveContextMenuSections(hits: {
  canonHit: boolean;
  fabricHit: boolean;
  fictional: boolean;
}): ContextMenuSections {
  return {
    location: hits.canonHit,
    fabric: hits.fabricHit,
    generation: hits.fictional,
  };
}
