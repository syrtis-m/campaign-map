import type { NamingCulture } from "../culture";

/** Portmanteau + kana-esque syllables + Inc/Corp (docs/quality-bar.md pinned defaults). */
export const neonCorpo: NamingCulture = {
  id: "neon-corpo",
  genre: "neon",
  pre: ["Nova", "Kira", "Zeta", "Neo", "Chrome", "Vex", "Sora", "Rin", "Axi", "Mika"],
  mid: ["tsu", "ko", "dyne", "tex", "ryu", "flux", "hara", "on"],
  suf: ["Corp", "Industries", "Dynamics", "Systems", "Holdings", "Labs", "Collective", "Inc"],
  epithetChance: 0,
};
