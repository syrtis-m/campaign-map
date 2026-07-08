import type { NamingCulture } from "../culture";

/**
 * Real-city overlay: person-name + generic (docs/06 §3). `mid` used to
 * include a bare "s" (no trailing space) — `pre + "s" + suf` concatenates
 * with no word boundary at all ("Mill" + "s" + "Corner Shop" =
 * "MillsCorner Shop"), producing garbled run-together names. Dropped it;
 * "'s " (trailing space) already covers the possessive case correctly.
 */
export const modernAnglo: NamingCulture = {
  id: "modern-anglo",
  genre: "modern",
  pre: ["King", "Queen", "Baker", "Church", "Mill", "Station", "Market", "Bridge", "High", "Park"],
  mid: ["'s ", " "],
  suf: ["Street Café", "Arms", "& Sons", "Market", "Books", "Corner Shop", "Yard", "Social Club"],
  epithetChance: 0,
};
