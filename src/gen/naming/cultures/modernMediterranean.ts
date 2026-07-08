import type { NamingCulture } from "../culture";

/** Real-city neighborhood texture, Mediterranean-heritage flavor — contrast to modern-anglo per docs/04 F5. */
export const modernMediterranean: NamingCulture = {
  id: "modern-mediterranean",
  genre: "modern",
  pre: ["Casa", "Villa", "Nonna's", "Piazza", "Via", "Ponte", "Rosa", "Sole", "Vino", "Luna"],
  mid: [" ", "'s ", " del "],
  suf: ["Trattoria", "Ristorante", "Café", "Osteria", "Bottega", "Gelateria", "Piazza", "Enoteca"],
  epithetChance: 0,
};
