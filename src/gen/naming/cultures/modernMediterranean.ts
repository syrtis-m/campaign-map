import type { NamingCulture } from "../culture";

/**
 * Real-city neighborhood texture, Mediterranean-heritage flavor — contrast to
 * modern-anglo per docs/quality-bar.md F5. `mid` is a single space, deliberately: "Casa",
 * "Villa", "Piazza" etc. are Italian/Spanish common nouns, not names, so
 * mixing in an English possessive ("Casa's Osteria") or a partitive ("Rosa
 * del Café") produced grammatically broken results — every `pre`+`suf` pair
 * here reads as a plausible venue name with nothing but a space between them
 * (mirrors how real Italian restaurants brand as "Villa Toscana", "Casa
 * Bonita", etc).
 */
export const modernMediterranean: NamingCulture = {
  id: "modern-mediterranean",
  genre: "modern",
  pre: ["Casa", "Villa", "Nonna", "Piazza", "Via", "Ponte", "Rosa", "Sole", "Vino", "Luna"],
  mid: [" "],
  suf: ["Trattoria", "Ristorante", "Café", "Osteria", "Bottega", "Gelateria", "Piazza", "Enoteca"],
  epithetChance: 0,
};
