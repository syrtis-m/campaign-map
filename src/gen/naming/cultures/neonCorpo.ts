import type { NamingCulture } from "../culture";

/** Portmanteau + kana-esque syllables + Inc/Corp (docs/06 §3). */
export const neonCorpo: NamingCulture = {
  id: "neon-corpo",
  pre: ["Nova", "Kira", "Zeta", "Neo", "Chrome", "Vex", "Sora", "Rin", "Axi", "Mika"],
  mid: ["tsu", "ko", "dyne", "tex", "ryu", "flux", "hara", "on"],
  suf: ["Corp", "Industries", "Dynamics", "Systems", "Holdings", "Labs", "Collective", "Inc"],
  epithetChance: 0,
};
