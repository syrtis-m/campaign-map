import { mulberry32, hashSeed, pick } from "../rng";

/**
 * Minimal naming-culture profile: phoneme/part tables + assembly rule.
 * Phase 1 scope (quality-bar F5): offer 3 culture-consistent suggestions in the
 * quick-add flow so typing a name isn't the only path. Full per-genre generator
 * depth (region inheritance, WFC-assisted variation) is Phase 3a — see roadmap.
 */
export interface NamingCulture {
  id: string;
  pre: readonly string[];
  mid: readonly string[];
  suf: readonly string[];
  /** Occasionally prefixes a generic descriptor, e.g. "The Brine" style. */
  epithets?: readonly string[];
  epithetChance: number;
}

export function generateName(seed: number, culture: NamingCulture): string {
  const rng = mulberry32(seed);
  let name = pick(rng, culture.pre) + pick(rng, culture.mid) + pick(rng, culture.suf);
  name = name.charAt(0).toUpperCase() + name.slice(1);
  if (culture.epithets && rng() < culture.epithetChance) {
    name = `${pick(rng, culture.epithets)} ${name}`;
  }
  return name;
}

/** Deterministic given (baseSeed, culture, count); varying `salt` gives a fresh batch. */
export function generateNameSuggestions(
  baseSeed: number,
  culture: NamingCulture,
  count: number,
  salt: number | string = 0
): string[] {
  const names = new Set<string>();
  let i = 0;
  while (names.size < count && i < count * 8) {
    names.add(generateName(hashSeed(baseSeed, salt, i), culture));
    i++;
  }
  return [...names];
}
