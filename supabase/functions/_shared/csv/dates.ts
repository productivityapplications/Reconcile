// Date parsing for bank CSV exports — PURE.
//
// Every supported input resolves to an ISO instant at UTC midnight of the
// calendar date it names. That is a deliberate, single convention: Phase 10B.5
// established that mixing local and UTC date arithmetic is a real defect class
// in this codebase, so day/month grouping and period windows agree by
// construction instead of drifting near boundaries.
//
// A CSV export has no timezone, so anchoring at UTC midnight is also the only
// choice that is stable no matter which device replays the import.

const MONTHS: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

export interface ParsedDate {
  /** ISO instant at UTC midnight, e.g. 2026-10-15T00:00:00.000Z. */
  iso: string;
  year: number;
  month: number;
  day: number;
}

function make(year: number, month: number, day: number): ParsedDate | null {
  if (year < 1900 || year > 2200) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  const ms = Date.UTC(year, month - 1, day);
  const d = new Date(ms);
  // Rejects impossible calendar dates such as 31/02, which Date.UTC rolls over.
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return { iso: d.toISOString(), year, month, day };
}

function twoOrFour(raw: string): number | null {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return null;
  if (raw.length === 2) return n >= 70 ? 1900 + n : 2000 + n;
  if (raw.length === 4) return n;
  return null;
}

/**
 * Parse a bank CSV date cell.
 *
 * Supported: yyyy-mm-dd, dd/mm/yyyy, dd-mm-yyyy, dd/mm/yy, dd-Mon-yyyy,
 * "dd Mon yyyy", "dd-Mon-yy", "Mon dd, yyyy", ISO-8601 (with or without a time).
 *
 * `dd/mm` vs `mm/dd` is genuinely ambiguous for low day values. Nigerian banks
 * export day-first, so day-first is assumed — but only when the first
 * component cannot be a valid month, otherwise both readings are legal and we
 * keep day-first and document the assumption rather than guess per-row.
 *
 * Returns null when the value is not a date. A row with an unparseable date is
 * reported as a row-level issue, never silently coerced.
 */
export function parseCsvDate(raw: string): ParsedDate | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value.length === 0) return null;

  // ISO-8601, optionally with a time part. Checked first because it is
  // unambiguous and also the shape this app writes.
  const isoMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2})?.*)?$/);
  if (isoMatch) {
    return make(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]));
  }

  // dd-Mon-yyyy / dd Mon yyyy / Mon dd, yyyy / dd-Mon-yy
  const monthName = value.match(
    /^(\d{1,2})[\s-]*([A-Za-z]{3,9})[\s,-]*(\d{2,4})$/,
  );
  if (monthName) {
    const day = Number(monthName[1]);
    const month = MONTHS[monthName[2].toLowerCase()];
    const year = twoOrFour(monthName[3]);
    if (month && year) return make(year, month, day);
  }

  const nameFirst = value.match(
    /^([A-Za-z]{3,9})[\s-]*(\d{1,2})[\s,-]+(\d{2,4})$/,
  );
  if (nameFirst) {
    const month = MONTHS[nameFirst[1].toLowerCase()];
    const day = Number(nameFirst[2]);
    const year = twoOrFour(nameFirst[3]);
    if (month && year) return make(year, month, day);
  }

  // Numeric: dd/mm/yyyy, dd-mm-yyyy, dd.mm.yyyy, and 2-digit years.
  const numeric = value.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (numeric) {
    const first = Number(numeric[1]);
    const second = Number(numeric[2]);
    const year = twoOrFour(numeric[3]);
    if (year === null) return null;
    // Prefer day-first (Nigerian convention) but fall back to month-first only
    // when day-first is impossible, e.g. 10/12/2026.
    if (first > 12 && second <= 12) return make(year, second, first);
    if (second > 12 && first <= 12) return make(year, first, second);
    if (first <= 31 && second <= 31) return make(year, second, first);
    return null;
  }

  return null;
}