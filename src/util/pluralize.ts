/**
 * English pluralization for notice/confirm strings that render a fabric kind
 * or algorithm label at a runtime count. Naive `word + "s"` turns "city" into
 * "citys"; this handles the consonant+y ⇒ ies case.
 *
 * Returns the correctly-inflected WORD (no count). `count === 1` ⇒ singular.
 *
 *   pluralize("city", 2)   // "cities"
 *   pluralize("forest", 2) // "forests"
 *   pluralize("city", 1)   // "city"
 */
export function pluralize(word: string, count: number): string {
  if (count === 1) return word;
  // consonant + y ⇒ ies ("city" → "cities", but not "day" → "daies")
  if (/[^aeiou]y$/i.test(word)) return word.slice(0, -1) + "ies";
  return word + "s";
}

/** Convenience: `${count} ${pluralize(word, count)}` — "2 cities", "1 city". */
export function countOf(word: string, count: number): string {
  return `${count} ${pluralize(word, count)}`;
}
