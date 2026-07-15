import { LOCATION_TYPES } from "../model/locationNote";
import { MARKET_PIN_TYPE } from "../gen/citynet";

/**
 * Type options for the add-location picker: the location taxonomy plus the
 * `market` COUPLING pin (plan 039) — a `type: market` Location inside a city
 * district anchors the generated plaza + arterial star. Market isn't a taxonomy
 * type (it renders with `custom` defaults via `typeDefaults`'s fallback), so it
 * is appended here rather than baked into TYPE_TAXONOMY; without this option the
 * 039 loop was unreachable from the GUI (frontmatter hand-edit only).
 *
 * Pure + DOM-free (no obsidian import) so the add-flow's type list is unit-
 * testable headlessly — QuickAddModal renders straight from it.
 */
export function quickAddTypeOptions(): { value: string; label: string }[] {
  const opts = LOCATION_TYPES.map((t) => ({ value: t, label: t }));
  if (!LOCATION_TYPES.includes(MARKET_PIN_TYPE)) {
    opts.push({ value: MARKET_PIN_TYPE, label: `${MARKET_PIN_TYPE} (city plaza anchor)` });
  }
  return opts;
}
