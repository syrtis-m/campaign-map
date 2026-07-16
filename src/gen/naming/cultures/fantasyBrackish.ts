import type { NamingCulture } from "../culture";

/** Harsh coastal fantasy: consonant clusters, -haven/-wick/-mire (docs/quality-bar.md pinned defaults). */
export const fantasyBrackish: NamingCulture = {
  id: "fantasy-brackish",
  genre: "fantasy",
  pre: ["Ash", "Brine", "Wren", "Grim", "Thorn", "Black", "Salt", "Mire", "Storm", "Drown"],
  mid: ["hol", "fen", "gard", "wyn", "en", "or", "ath", "in"],
  suf: ["haven", "wick", "mire", "hold", "reach", "fall", "gate", "moor"],
  epithets: ["Old", "The Sunken", "The Drowned", "Far", "New"],
  epithetChance: 0.2,
};
