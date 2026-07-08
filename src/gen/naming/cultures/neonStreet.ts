import type { NamingCulture } from "../culture";

/** Street-level grit — contrast to neon-corpo's corporate polish per docs/04 F5 (corporate zone vs street zone). */
export const neonStreet: NamingCulture = {
  id: "neon-street",
  genre: "neon",
  pre: ["Rust", "Glitch", "Ash", "Skid", "Wire", "Grid", "Null", "Static", "Chrome", "Junk"],
  mid: ["row", "hollow", "drift", "burn", "fringe", "gutter"],
  suf: ["Row", "Sprawl", "Drift", "Junction", "Undercity", "Fringe", "Yards", "Hollow"],
  epithetChance: 0,
};
