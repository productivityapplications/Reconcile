// Transaction direction resolution for single-amount CSV layouts — PURE.
//
// A debit/credit column pair states direction outright, so this module only has
// to work for files that carry one unsigned Amount column. There, a positive
// number says nothing about which way the money moved.
//
// Direction is resolved by a fixed precedence, strongest signal first:
//
//   1. type_column       an explicit DR/CR Type column
//   2. description_marker  a trailing DR/CR marker in the narration
//   3. amount_sign       a leading "-", accounting parentheses, or trailing DR/CR
//   4. balance           derived from the movement of the running balance
//   5. assumed           an expense, flagged for the user to confirm
//
// Steps 4 and 5 are the weak signals. Both set `needsConfirmation`, and the
// import preview shows them as such so the user can correct them before the rows
// become authoritative ledger facts.
//
// Why the default is expense: statement rows are predominantly debits. Treating
// an unresolved row as income invents money that never arrived and corrupts
// budget and insight math. Treating it as an expense is the safer wrong answer,
// and the preview gives the user a chance to flip it.

import type { ParsedAmount } from "./amounts.ts";

export type Direction = "debit" | "credit";

/** Which step produced the direction. */
export type DirectionSource =
  | "type_column"
  | "description_marker"
  | "amount_sign"
  | "balance"
  | "assumed";

export interface ResolvedDirection {
  direction: Direction;
  source: DirectionSource;
  /**
   * True when direction came from a weak signal (balance, or assumed). The
   * preview marks these rows and offers a bulk toggle and a per-row override.
   */
  needsConfirmation: boolean;
  /**
   * True when the narration looks like a reversal or refund, so a row whose
   * direction had to be assumed can still be reviewed as a probable refund.
   */
  looksLikeRefund: boolean;
}

// Whole-word markers, matched only as a trailing token or as the entire string.
//
// Restricting to those positions is deliberate. A plain \bCREDIT\b would match
// "CREDIT SUISSE FEES" and file a merchant name as income; a leading token is
// indistinguishable from a merchant that happens to start with an abbreviation.
// A trailing marker is unambiguous, and an abbreviation standing alone as the
// whole narration is unambiguous too.
const DEBIT_MARKER = /^(?:DR|DEBIT|DEB)$/;
const CREDIT_MARKER = /^(?:CR|CREDIT|CRE)$/;
const REFUND_MARKER = /\b(?:REV(?:ERSAL)?|REFUND|REBATE)\b/i;

/** Normalise a narration for marker matching: collapse whitespace, trim. */
function markerText(description: string): string[] {
  const trimmed = description.replace(/\s+/g, " ").trim();
  if (trimmed.length === 0) return [];
  const words = trimmed.split(" ");
  const candidates = [words[words.length - 1]];
  // A marker standing alone as the entire narration counts too.
  if (words.length > 1) candidates.push(trimmed);
  return candidates;
}

/**
 * Step 1: read an explicit Type / DR-CR column.
 * Returns null for anything unrecognised so the caller falls through.
 */
export function directionFromTypeColumn(type: string | null | undefined): Direction | null {
  if (typeof type !== "string") return null;
  const v = type.replace(/\s+/g, " ").trim().toUpperCase();
  if (v.length === 0) return null;
  if (["DR", "D", "DEBIT", "DEB", "OUT", "WITHDRAWAL", "PAID OUT"].includes(v)) return "debit";
  if (["CR", "C", "CREDIT", "CRE", "IN", "DEPOSIT", "PAID IN"].includes(v)) return "credit";
  return null;
}

/** Step 2: a trailing DR/CR marker in the narration. */
export function directionFromDescription(
  description: string | null | undefined,
): Direction | null {
  if (typeof description !== "string") return null;
  for (const candidate of markerText(description)) {
    if (DEBIT_MARKER.test(candidate)) return "debit";
    if (CREDIT_MARKER.test(candidate)) return "credit";
  }
  return null;
}

/** True when the narration suggests a reversal or refund. */
export function looksLikeRefund(description: string | null | undefined): boolean {
  return typeof description === "string" && REFUND_MARKER.test(description);
}

/**
 * Step 4: derive direction from the running balance.
 *
 * `previous` is the balance of the preceding row in file order, or null for the
 * first row or any row following a gap. A decrease is money out, an increase is
 * money in, and no change resolves nothing — the row may be a transfer or a fee
 * absorbed elsewhere in the statement.
 */
export function directionFromBalance(
  previous: number | null,
  current: number | null,
): Direction | null {
  if (previous === null || current === null) return null;
  if (current < previous) return "debit";
  if (current > previous) return "credit";
  return null;
}

export interface ResolveDirectionInput {
  type?: string | null;
  description?: string | null;
  /** Parsed single amount cell, or null when the cell was unusable. */
  amount?: ParsedAmount | null;
  /** Balance of the previous row in file order, null when unknown. */
  previousBalanceMinor?: number | null;
  /** Balance on this row, null when the file has no usable balance. */
  balanceMinor?: number | null;
  /**
   * Bulk override from the preview: "expense" or "income" applied to rows whose
   * direction came from a weak signal. Defaults to expense.
   */
  assume?: Direction;
}

/**
 * Resolve one row's direction through the fixed precedence.
 */
export function resolveDirection(input: ResolveDirectionInput): ResolvedDirection {
  const refund = looksLikeRefund(input.description);

  const fromType = directionFromTypeColumn(input.type);
  if (fromType) {
    return { direction: fromType, source: "type_column", needsConfirmation: false, looksLikeRefund: refund };
  }

  const fromMarker = directionFromDescription(input.description);
  if (fromMarker) {
    return { direction: fromMarker, source: "description_marker", needsConfirmation: false, looksLikeRefund: refund };
  }

  // Step 3: only counts when the cell actually stated a direction. A bare
  // positive amount is `explicit: null` and falls through to the balance.
  const explicit = input.amount?.explicit ?? null;
  if (explicit) {
    return {
      direction: explicit,
      source: "amount_sign",
      needsConfirmation: false,
      looksLikeRefund: refund,
    };
  }

  const fromBalance = directionFromBalance(
    input.previousBalanceMinor ?? null,
    input.balanceMinor ?? null,
  );
  if (fromBalance) {
    return { direction: fromBalance, source: "balance", needsConfirmation: true, looksLikeRefund: refund };
  }

  // Step 5: nothing resolved it. Default to expense and flag it, so the preview
  // can show the assumption rather than presenting a guess as a fact.
  return {
    direction: input.assume === "credit" ? "credit" : "debit",
    source: "assumed",
    needsConfirmation: true,
    looksLikeRefund: refund,
  };
}
