// Known CSV export LAYOUTS — PURE.
//
// Why layouts and not banks:
//
// Bank identity is a bad proxy for how to parse a file. Several Nigerian banks
// export byte-identical header rows (Access and Zenith match exactly; UBA,
// Sterling and First Bank share GTBank's shape), and one bank has published
// more than one export format over the years. Guessing a bank from headers is
// therefore both impossible in the general case and wrong whenever it guesses.
//
// What actually determines parsing is the column layout — which headers are
// present and how the amount is expressed. That is what this module describes,
// and it is named for its shape rather than for a bank. The human-readable bank
// name comes from the account label the user supplies at import time.
//
// A layout declares:
//   id                  shape name, stable, used as the provider id suffix
//   label               what the UI shows when describing the layout
//   requiredColumns     headers that must all be present for a match
//   optionalColumns     headers that may also be present
//   mapping             canonical field -> header aliases for this shape
//
// Header comparison is by normalised key (lowercased, punctuation and spacing
// removed), so "TRANSACTION DATE", "transaction_date" and "Transaction  Date"
// all match one alias.

/** Canonical fields the parser understands. */
export type CanonicalField =
  | "date"
  | "valueDate"
  | "description"
  | "debit"
  | "credit"
  | "amount"
  | "balance"
  | "reference"
  | "type"
  | "accountNumber";

/** A required field is one the parser cannot work without. */
export const REQUIRED_FIELDS: CanonicalField[] = ["date", "description"];

export interface CsvLayout {
  id: string;
  /** Human description of the shape, for the import preview. */
  label: string;
  /**
   * Canonical fields that must all resolve for this layout to match.
   *
   * Expressed as canonical fields rather than literal header names because a
   * field can arrive under any of its aliases: requiring the literal string
   * "Narration" would reject a perfectly good "Description" column. Presence is
   * therefore judged by the resolved mapping, not by string equality.
   */
  requiredFields: CanonicalField[];
  /** Canonical fields that may also be present without changing the match. */
  optionalFields: CanonicalField[];
  /** How this layout expresses the amount, which drives direction resolution. */
  amountStyle: "debit_credit" | "signed_single";
  /** canonical field -> header aliases */
  mapping: Partial<Record<CanonicalField, string[]>>;
}

const NARRATION = ["Narration", "Narrative", "Description", "Details", "Particulars", "Memo"];
const DATE_ANY = ["Date", "Transaction Date", "Trans Date", "Trans. Date", "Posting Date"];
const VALUE_DATE = ["Value Date"];
const DEBIT = ["Debit", "Withdrawals", "Withdrawal", "Paid Out", "Money Out"];
const CREDIT = ["Credit", "Deposits", "Deposit", "Paid In", "Money In"];
const BALANCE = ["Balance", "Running Balance", "Closing Balance"];
const REFERENCE = ["Reference", "Ref", "Transaction Reference"];
const TYPE = ["Type", "Transaction Type", "DR/CR", "Dr/Cr", "Debit/Credit"];
const ACCOUNT_NUMBER = ["Account Number", "Account No", "Account", "Acct No", "Acct Number"];

export const CSV_LAYOUTS: CsvLayout[] = [
  {
    // GTBank, UBA, Sterling and First Bank all export this shape. Deliberately
    // one entry, not four: the rows parse identically, and pretending to tell
    // them apart would only produce a wrong bank name.
    id: "date_narration_debit_credit_balance",
    label: "date, narration, debit, credit, balance",
    requiredFields: ["date", "description", "debit", "credit"],
    optionalFields: ["valueDate", "balance", "reference", "type", "accountNumber"],
    amountStyle: "debit_credit",
    mapping: {
      date: DATE_ANY,
      valueDate: VALUE_DATE,
      description: NARRATION,
      debit: DEBIT,
      credit: CREDIT,
      balance: BALANCE,
      reference: REFERENCE,
      type: TYPE,
      accountNumber: ACCOUNT_NUMBER,
    },
  },
  {
    // Access and Zenith export this shape: a separate transaction and value
    // date. Identical parsing, again collapsed into one layout.
    id: "transaction_date_value_date_narration_debit_credit_balance",
    label: "transaction date, value date, narration, debit, credit, balance",
    requiredFields: ["date", "valueDate", "description", "debit", "credit"],
    optionalFields: ["balance", "reference", "type", "accountNumber"],
    amountStyle: "debit_credit",
    mapping: {
      date: ["Transaction Date", "Trans Date"],
      valueDate: VALUE_DATE,
      description: NARRATION,
      debit: DEBIT,
      credit: CREDIT,
      balance: BALANCE,
      reference: REFERENCE,
      type: TYPE,
      accountNumber: ACCOUNT_NUMBER,
    },
  },
  {
    // A single Amount column. The sign may or may not be present, so direction
    // resolution has to fall back to the type column, narration markers, the
    // running balance, and finally an assumed expense the user can correct.
    id: "date_description_amount_balance",
    label: "date, description, amount, balance",
    requiredFields: ["date", "description", "amount"],
    optionalFields: ["balance", "reference", "type", "valueDate", "accountNumber"],
    amountStyle: "signed_single",
    mapping: {
      date: DATE_ANY,
      valueDate: VALUE_DATE,
      description: NARRATION,
      amount: ["Amount", "Transaction Amount", "Value"],
      balance: BALANCE,
      reference: REFERENCE,
      type: TYPE,
      accountNumber: ACCOUNT_NUMBER,
    },
  },
];

export const UNKNOWN_LAYOUT_ID = "unknown";

/**
 * Collapse a header to a comparable key: lowercase, drop everything that is
 * not a letter or digit. "Value Date" and "VALUE_DATE" both become "valuedate".
 */
export function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function layoutById(id: string): CsvLayout | null {
  return CSV_LAYOUTS.find((l) => l.id === id) ?? null;
}

/** Human label for a layout id, used by the preview copy. */
export function layoutLabel(id: string): string {
  return layoutById(id)?.label ?? "unknown";
}
