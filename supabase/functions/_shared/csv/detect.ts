// CSV layout detection — PURE.
//
// Detects which column LAYOUT a header row matches. It deliberately does not
// attempt to identify the bank: several banks export identical headers, so that
// question has no answer from the file alone. The account label the user types
// at import time supplies the human-readable name.
//
// Matching rule, in order:
//   1. Every one of a layout's requiredColumns must be present.
//   2. Among layouts that match, prefer the one matching the most required
//      columns, then the most optional columns. This picks the most specific
//      shape: an export carrying both "Transaction Date" and "Value Date"
//      matches the two-date layout rather than the one-date layout.
//   3. A tie is broken by declaration order, deterministically. The result
//      reports every layout that matched so the caller can show it.
//
// When nothing matches, the result is "unknown" and the column-mapping fallback
// in ./map.ts takes over.

import {
  CSV_LAYOUTS,
  REQUIRED_FIELDS,
  UNKNOWN_LAYOUT_ID,
  normalizeHeader,
  type CanonicalField,
  type CsvLayout,
} from "./layouts.ts";

export type ColumnMapping = Partial<Record<CanonicalField, string>>;

export interface DetectionResult {
  /** Layout id, or "unknown" when no layout matched. */
  layoutId: string;
  /** Human description of the recognised shape, e.g. "date, narration, debit,
   *  credit, balance". Null when unknown. */
  label: string | null;
  /** header text -> canonical field, for every column we recognised. */
  mapping: ColumnMapping;
  /** Ids of every layout that matched, best first. */
  matchedLayouts: string[];
  /** True when more than one layout matched and the choice was not forced. */
  ambiguous: boolean;
  /** Required fields the header row does not provide, for the mapping UI. */
  missingRequired: CanonicalField[];
}

/**
 * Build a header -> field map for one layout against one header row.
 * Returns only fields whose alias set is present.
 */
export function mapHeadersFor(
  layout: CsvLayout,
  headers: string[],
): ColumnMapping {
  const normalised = headers.map((h) => normalizeHeader(h));
  const mapping: ColumnMapping = {};

  for (const [field, aliases] of Object.entries(layout.mapping) as Array<
    [CanonicalField, string[]]
  >) {
    const aliasKeys = aliases.map((a) => normalizeHeader(a));
    // First header column that matches any alias wins, so a file with both
    // "Date" and "Value Date" maps them to different canonical fields.
    for (let i = 0; i < normalised.length; i++) {
      if (normalised[i].length > 0 && aliasKeys.includes(normalised[i])) {
        mapping[field] = headers[i];
        break;
      }
    }
  }
  return mapping;
}

/**
 * How many of the layout's required fields this header row resolves.
 * A field counts as present when any one of its aliases matched a header.
 */
function countPresent(
  mapping: ColumnMapping,
  fields: CanonicalField[],
): number {
  return fields.filter((f) => mapping[f] !== undefined).length;
}

/**
 * Detect the layout of a CSV from its header row.
 *
 * `headers` is the first non-empty record, already split into cells.
 */
export function detectLayout(headers: string[]): DetectionResult {
  const usable = headers.filter((h) => h.trim().length > 0);
  if (usable.length === 0) {
    return {
      layoutId: UNKNOWN_LAYOUT_ID,
      label: null,
      mapping: {},
      matchedLayouts: [],
      ambiguous: false,
      missingRequired: [...REQUIRED_FIELDS],
    };
  }

  const scored = CSV_LAYOUTS.map((layout, order) => {
    const mapping = mapHeadersFor(layout, usable);
    const requiredMatched = countPresent(mapping, layout.requiredFields);
    const optionalMatched = countPresent(mapping, layout.optionalFields);
    const complete = requiredMatched === layout.requiredFields.length;
    return { layout, mapping, requiredMatched, optionalMatched, complete, order };
  })
    .filter((s) => s.complete)
    // More required columns first (most specific shape), then more optional
    // columns, then declaration order so the outcome is deterministic.
    .sort(
      (a, b) =>
        b.requiredMatched - a.requiredMatched ||
        b.optionalMatched - a.optionalMatched ||
        a.order - b.order,
    );

  const best = scored[0];
  if (!best) {
    return {
      layoutId: UNKNOWN_LAYOUT_ID,
      label: null,
      mapping: {},
      matchedLayouts: [],
      ambiguous: false,
      // Nothing matched at all, so every required field is still outstanding.
      missingRequired: [...REQUIRED_FIELDS],
    };
  }

  const matchedLayouts = scored.map((s) => s.layout.id);
  return {
    layoutId: best.layout.id,
    label: best.layout.label,
    mapping: best.mapping,
    matchedLayouts,
    // A tie means two layouts matched with equal specificity and we fell back to
    // declaration order. The rows parse the same either way, but the caller is
    // told rather than left to assume.
    ambiguous: scored.length > 1 && scored[1].requiredMatched === best.requiredMatched &&
      scored[1].optionalMatched === best.optionalMatched,
    missingRequired: [],
  };
}
