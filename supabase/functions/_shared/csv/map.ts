// Column-mapping fallback — PURE.
//
// When header detection fails, the user is shown the real header row and picks
// which column plays which role. This module owns that vocabulary and the
// validation of what the user chose, so the UI and the Edge Function agree on
// what a valid mapping is.
//
// Validation is deliberately strict: a mapping that names a column that is not
// in this file's header row is rejected rather than silently ignored, because
// silently ignoring it produces an import that looks successful and imports
// nothing.

import type { CanonicalField, CsvLayout } from "./layouts.ts";
import { REQUIRED_FIELDS, layoutById, normalizeHeader } from "./layouts.ts";
import type { ColumnMapping } from "./detect.ts";

/** Everything the mapping UI needs to render, without hard-coding it in the screen. */
export interface MappingOption {
  field: CanonicalField;
  label: string;
  required: boolean;
  /** Rendered as the debit/credit pair when this option is chosen. */
  group: "core" | "amount" | "optional";
  help: string;
}

export const MAPPING_OPTIONS: MappingOption[] = [
  {
    field: "date",
    label: "Date",
    required: true,
    group: "core",
    help: "The column holding the transaction date.",
  },
  {
    field: "description",
    label: "Description",
    required: true,
    group: "core",
    help: "The column holding the narration or merchant text.",
  },
  {
    field: "debit",
    label: "Debit column",
    required: false,
    group: "amount",
    help: "Money leaving the account. Pick this OR Amount, not both.",
  },
  {
    field: "credit",
    label: "Credit column",
    required: false,
    group: "amount",
    help: "Money arriving in the account. Pick this OR Amount, not both.",
  },
  {
    field: "amount",
    label: "Single amount column",
    required: false,
    group: "amount",
    help: "One signed column instead of separate Debit and Credit columns.",
  },
  {
    field: "balance",
    label: "Balance",
    required: false,
    group: "optional",
    help: "Running balance, if the export has one.",
  },
  {
    field: "reference",
    label: "Reference",
    required: false,
    group: "optional",
    help: "The bank's own reference, if present.",
  },
];

export interface MappingValidation {
  ok: boolean;
  /** Fields the user has not filled in. */
  missingRequired: CanonicalField[];
  /** Fields mapped to a column that is not in the header row. */
  unknownColumns: { field: CanonicalField; column: string }[];
  /** Set when the user chose both a single amount and a debit/credit pair. */
  conflictingAmount: boolean;
  /** A message safe to show the user. */
  message: string | null;
}

export function validateMapping(
  mapping: ColumnMapping,
  headers: string[],
): MappingValidation {
  const missingRequired = REQUIRED_FIELDS.filter(
    (f) => !mapping[f] || mapping[f]!.trim().length === 0,
  );
  const unknownColumns: { field: CanonicalField; column: string }[] = [];
  for (const [field, column] of Object.entries(mapping) as Array<
    [CanonicalField, string]
  >) {
    if (!column) continue;
    const target = normalizeHeader(column);
    if (!headers.some((h) => normalizeHeader(h) === target)) {
      unknownColumns.push({ field, column });
    }
  }

  const hasPair = Boolean(mapping.debit || mapping.credit);
  const hasSingle = Boolean(mapping.amount);
  const conflictingAmount = hasPair && hasSingle;

  let message: string | null = null;
  if (missingRequired.length > 0) {
    message = `Choose a column for ${missingRequired
      .map((f) => MAPPING_OPTIONS.find((o) => o.field === f)?.label ?? f)
      .join(" and ")}.`;
  } else if (conflictingAmount) {
    message = "Use either a single Amount column, or a Debit/Credit pair — not both.";
  } else if (hasSingle && !hasPair && !mapping.amount) {
    message = "Choose a column for the amount.";
  } else if (!hasSingle && !hasPair) {
    message = "Choose either an Amount column, or Debit and Credit columns.";
  } else if (unknownColumns.length > 0) {
    message = unknownColumns
      .map((u) => `"${u.column}" is not a column in this file.`)
      .join(" ");
  }

  return {
    ok: message === null,
    missingRequired,
    unknownColumns,
    conflictingAmount,
    message,
  };
}

/**
 * Guess a mapping from header names alone, for a file detection did not
 * recognise. Deliberately generous — it accepts any header containing "date",
 * "narrat"/"description"/"details"/"particulars", "debit"/"withdraw",
 * "credit"/"deposit", "balance", or "reference" — so the common case needs one
 * tap to confirm rather than a full manual mapping.
 */
export function suggestMapping(headers: string[]): ColumnMapping {
  const find = (patterns: RegExp[]): string | undefined => {
    for (const pattern of patterns) {
      const hit = headers.find((h) => pattern.test(normalizeHeader(h)));
      if (hit) return hit;
    }
    return undefined;
  };

  const mapping: ColumnMapping = {};
  const date = find([/^transactiondate$/, /^valuedate$/, /^date$/, /date$/, /time/]);
  if (date) mapping.date = date;

  const description = find([
    /^description$/,
    /^narration$/,
    /^narrative$/,
    /^details$/,
    /^particulars$/,
    /^memo$/,
    /narrat/,
    /descript/,
  ]);
  if (description) mapping.description = description;

  const debit = find([/^debit$/, /debit/, /withdraw/, /paidout/, /^moneyout$/, /moneyout/, /^outflow$/]);
  if (debit) mapping.debit = debit;

  const credit = find([/^credit$/, /credit/, /deposit/, /paidin/, /^moneyin$/, /moneyin/, /^inflow$/]);
  if (credit) mapping.credit = credit;

  // Only fall back to a single amount column when there is no debit/credit
  // pair, since banks often have an "Amount" column alongside them.
  if (!debit && !credit) {
    const amount = find([/^amount$/, /^transactionamount$/, /amount/, /^value$/]);
    if (amount) mapping.amount = amount;
  }

  const balance = find([/^balance$/, /balance/, /runningbalance/]);
  if (balance) mapping.balance = balance;

  const reference = find([/^reference$/, /^ref$/, /reference/, /^instrument$/]);
  if (reference) mapping.reference = reference;

  return mapping;
}

/** Best-effort display label for a header, used in preview dropdowns. */
export function describeColumn(header: string): string {
  const value = header.trim();
  return value.length > 0 ? value : "(blank column)";
}

/** Re-exported so the Edge Function and UI share one vocabulary. */
export type { CanonicalField, ColumnMapping, CsvLayout };
export { layoutById };