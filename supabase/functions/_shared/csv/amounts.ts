// Amount parsing for bank CSV exports — PURE.
//
// Nigerian bank exports are denominated in Naira (major units) with two
// decimals, so everything here converts to integer minor units (kobo) on the
// way out. The ledger stores integer minor units only
// (ARCHITECTURE.md §6, `amount_minor bigint check (amount_minor > 0)`), and
// finance.ts rejects non-integers, so the conversion must happen here.
//
// Rounding: `Math.round` to the nearest kobo. Floating-point subtraction from
// a parsed string can land a fraction of a kobo off; rounding at the boundary
// keeps the ledger clean.

/** Currencies accepted in a cell. Anything else is stripped as noise. */
const CURRENCY_NOISE = /(NGN|₦|\$|€|£|₵)/gi;

export interface ParsedAmount {
  /** Signed integer minor units. Negative means money out. */
  minor: number;
  /** True when the source cell was negative (sign, or accounting parentheses). */
  negative: boolean;
  /**
   * Whether the cell stated its direction outright.
   *
   * "debit"  — a leading "-", accounting parentheses, or a DR marker.
   * "credit" — a CR marker.
   * null     — the cell was a bare positive number with no direction at all.
   *
   * This distinction is what lets ./direction.ts refuse to treat an unsigned
   * single-amount cell as income. A bare "12,000.00" is `explicit: null`, not
   * `explicit: "credit"`, even though its numeric value is positive.
   */
  explicit: "debit" | "credit" | null;
}

/**
 * Strip currency decoration and thousands separators, honouring accounting
 * parentheses for negatives. Returns null when the cell is not a number.
 */
export function parseAmountCell(raw: string): ParsedAmount | null {
  if (typeof raw !== "string") return null;
  let value = raw.trim();
  if (value.length === 0) return null;

  value = value.replace(CURRENCY_NOISE, "");

  // Accounting negative: (1,234.56)
  let negative = false;
  if (/^\(.*\)$/.test(value.trim())) {
    negative = true;
    value = value.trim().slice(1, -1).trim();
  }

  // Trailing/leading sign, possibly after a currency prefix.
  if (value.startsWith("-")) {
    negative = true;
    value = value.slice(1).trim();
  } else if (value.startsWith("+")) {
    value = value.slice(1).trim();
  }

  // A trailing/leading DR or CR marker is common in some exports.
  const drCr = value.match(/^(.*?)\s*(DR|CR)$/i);
  let explicit: ParsedAmount["explicit"] = null;
  if (drCr) {
    value = drCr[1].trim();
    if (drCr[2].toUpperCase() === "DR") {
      negative = !negative;
      explicit = "debit";
    } else {
      explicit = "credit";
    }
  }

  value = value.replace(/[\s,]/g, "");
  if (value.length === 0 || !/^\d*\.?\d+$/.test(value)) return null;

  const major = Number(value);
  if (!Number.isFinite(major)) return null;

  const minor = Math.round(major * 100);
  // A sign or DR marker is an explicit statement of direction; a bare positive
  // number states nothing.
  if (negative) explicit = "debit";
  return { minor: negative ? -minor : minor, negative, explicit };
}

/**
 * Resolve one row's amount from either a debit/credit pair or a single amount
 * column.
 *
 * Bank exports put the direction in the column name, not the sign: a Debit cell
 * of "1,000.00" means money out even though the number is positive. So a
 * debit/credit pair resolves direction from the column it came from, which is
 * always a strong signal.
 *
 * A single amount column is different. A leading "-", parentheses or a trailing
 * DR/CR marker resolves direction outright; a bare positive number resolves
 * nothing, so `direction` comes back null rather than defaulting to credit. The
 * caller passes it to ./direction.ts, which falls back to the running balance
 * and then to a flagged expense.
 *
 * Returns null when the row carries no usable amount, or when it is ambiguous.
 */
export function resolveRowAmount(input: {
  amount?: string | null;
  debit?: string | null;
  credit?: string | null;
}): { minor: number; direction: "debit" | "credit" | null; parsed: ParsedAmount } | null {
  const debitCell = input.debit?.trim() ? input.debit : null;
  const creditCell = input.credit?.trim() ? input.credit : null;

  if (debitCell && creditCell) {
    // Both populated. Some exports put "0.00" in the unused column, so treat an
    // explicit zero as empty before declaring ambiguity.
    const d = parseAmountCell(debitCell);
    const c = parseAmountCell(creditCell);
    if (d && c && d.minor !== 0 && c.minor !== 0) return null;
    if (d && d.minor !== 0) return { minor: Math.abs(d.minor), direction: "debit", parsed: d };
    if (c && c.minor !== 0) return { minor: Math.abs(c.minor), direction: "credit", parsed: c };
    return null;
  }

  if (debitCell) {
    const d = parseAmountCell(debitCell);
    if (!d || d.minor === 0) return null;
    return { minor: Math.abs(d.minor), direction: "debit", parsed: d };
  }

  if (creditCell) {
    const c = parseAmountCell(creditCell);
    if (!c || c.minor === 0) return null;
    return { minor: Math.abs(c.minor), direction: "credit", parsed: c };
  }

  if (input.amount !== undefined && input.amount !== null && input.amount.trim()) {
    const a = parseAmountCell(input.amount);
    if (!a || a.minor === 0) return null;
    // Only a stated direction resolves here. An unsigned positive value leaves
    // direction unset for the caller's precedence chain to resolve.
    return {
      minor: Math.abs(a.minor),
      direction: a.explicit,
      parsed: a,
    };
  }

  return null;
}