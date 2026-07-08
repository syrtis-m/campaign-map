import type { NamingCulture } from "../culture";

/** Real-city overlay: person-name + generic (docs/06 §3). */
export const modernAnglo: NamingCulture = {
  id: "modern-anglo",
  genre: "modern",
  pre: ["King", "Queen", "Baker", "Church", "Mill", "Station", "Market", "Bridge", "High", "Park"],
  mid: ["s", "'s ", " "],
  suf: ["Street Café", "Arms", "& Sons", "Market", "Books", "Corner Shop", "Yard", "Social Club"],
  epithetChance: 0,
};
