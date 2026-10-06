// Intermediate rows -> ledger-shaped transactions — PURE (except the hash).
//
// This is the seam between "a row we read from a file" and "a row the ledger
// will hold". Everything the app relies on is applied here: integer minor
// units, a stable direction, a deterministic provider transaction id, and a
// semantic type from the shared deterministic classifier.

import {
  budgetEligibleFor,
  classifyTransaction,
} from "../semantics.ts";
import { normalizeMerchantName, validateNormalized, type Direction } from "../finance.ts";
import { csvTransactionIds } from "./hash.ts";
import type { IntermediateRow } from "./parse.ts";

/** The provider id every CSV import writes under. */
export const CSV_PROVIDER_ID = "csv";

/** Currency assumption for imported files. Nigerian banks export NGN. */
export const CSV_DEFAULT_CURRENCY = "NGN";

export interface PlannedTransaction {
  providerTransactionId: string;
  amountMinor: number;
  currency: string;
  direction: Direction;
  semanticType: ReturnType<typeof classifyTransaction>;
  occurredAt: string;
  merchantName: string;
  narration: string;
  normalizedMerchant: string;
  budgetEligible: boolean;
}

export interface ImportPlan {
  transactions: PlannedTransaction[];
  /** Rows read but rejected by the ledger's own validator. */
  rejected: number;
  /** providerTransactionIds that appear more than once in this file. */
  duplicateWithinFile: number;
}

/**
 * Turn one parsed row into a ledger transaction.
 *
 * The provider transaction id is derived from row content, never from the row
 * number or the file name, so a re-downloaded or re-ordered export of the same
 * statement produces identical ids and dedupes through the existing unique
 * constraint.
 */
export async function toProviderTransaction(
  row: IntermediateRow,
): Promise<PlannedTransaction> {
  const semanticType = classifyTransaction(row.direction, null, row.description);
  const providerTransactionId = (
    await csvTransactionIds([
      {
        date: row.date,
        amountMinor: row.amountMinor,
        direction: row.direction,
        description: row.description,
      },
    ])
  )[0];

  return {
    providerTransactionId,
    amountMinor: row.amountMinor,
    currency: CSV_DEFAULT_CURRENCY,
    direction: row.direction,
    semanticType,
    occurredAt: row.date,
    merchantName: row.description.slice(0, 120),
    narration: row.description,
    normalizedMerchant: normalizeMerchantName(row.description),
    budgetEligible: budgetEligibleFor(semanticType),
  };
}

/**
 * Build the full plan for an import, dropping rows the ledger would refuse and
 * collapsing in-file duplicates before they reach the database.
 */
export async function planImport(rows: IntermediateRow[]): Promise<ImportPlan> {
  const planned: PlannedTransaction[] = [];
  let rejected = 0;
  const seen = new Set<string>();
  let duplicateWithinFile = 0;

  for (const row of rows) {
    const candidate = await toProviderTransaction(row);
    if (validateNormalized(candidate).length > 0) {
      rejected++;
      continue;
    }
    if (seen.has(candidate.providerTransactionId)) {
      duplicateWithinFile++;
      continue;
    }
    seen.add(candidate.providerTransactionId);
    planned.push(candidate);
  }

  return { transactions: planned, rejected, duplicateWithinFile };
}