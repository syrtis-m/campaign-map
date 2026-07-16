import type { NamingCulture } from "../culture";

/** Bright agrarian-plains fantasy — softer than fantasy-brackish's harsh coast; regional contrast per docs/quality-bar.md F5. */
export const fantasySunlit: NamingCulture = {
  id: "fantasy-sunlit",
  genre: "fantasy",
  pre: ["Gold", "Sun", "Green", "Barley", "Meadow", "Amber", "Wheat", "Rose", "Fair", "Bright"],
  mid: ["en", "dale", "ley", "mont", "wyn", "an"],
  suf: ["shire", "dale", "ford", "vale", "ton", "field", "mead", "brook"],
  epithets: ["Upper", "Little", "Sunny", "Old", "New"],
  epithetChance: 0.15,
};
