// Mono payload normalisation — PURE. No imports from client.ts, no Deno, no
// I/O, no logging.
//
// This module is where Mono's field names are translated into the project's own
// shapes. It is separated from client.ts so it can be unit-tested under jest
// (which cannot evaluate Deno) and so the pure rules stay auditable on their
// own. It remains inside providers/mono/, so the "Mono vocabulary never leaves
// this folder" boundary is unchanged.
//
// Every function here is defensive: a provider payload is untrusted input, and
// a malformed row must be dropped rather than persisted.

import {
  normalizeMerchantName,
  validateNormalized,
  type NormalizedTransaction,
  type SemanticType,
} from "../../finance.ts";
import {
  budgetEligibleFor,
  classifyTransaction,
} from "../../semantics.ts";
import type {
  DataStatus,
  ProviderAccount,
  ProviderTransaction,
  ProviderTransactionPage,
} from "../types.ts";

type Row = Record<string, unknown>;

export function asRecord(value: unknown): Row | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Row;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Positive integer minor units only. Mono returns NGN already in kobo, so no
 * conversion happens; this just refuses anything the ledger cannot hold
 * (schema requires amount_minor > 0).
 */
function asMinorAmount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return null;
  }
  return value;
}

/** Only the last four digits ever leave this module (ARCHITECTURE.md §6). */
export function maskAccountNumber(raw: string | null): string {
  if (!raw) return "••••";
  const tail = raw.replace(/\D/g, "").slice(-4);
  return tail.length === 4 ? `•••• ${tail}` : "••••";
}

const DATA_STATUSES: DataStatus[] = [
  "AVAILABLE",
  "PARTIAL",
  "UNAVAILABLE",
  "FAILED",
  "PROCESSING",
];

export function toDataStatus(raw: unknown): DataStatus | null {
  const value = asString(raw);
  if (!value) return null;
  const upper = value.toUpperCase();
  return (DATA_STATUSES as string[]).includes(upper) ? (upper as DataStatus) : null;
}

/**
 * Deterministic semantic classification.
 *
 * Moved to `_shared/semantics.ts` in Phase 12 so CSV imports can share the
 * exact same rules instead of copying them. Behaviour is unchanged: this module
 * re-exports the shared implementation, so Mono's output is identical.
 */
export { classifyTransaction, budgetEligibleFor };

/**
 * Normalise a Mono account payload.
 *
 * Accepts both documented shapes: the bank-data envelope (`data.account.id`,
 * `account_number`, `institution.bank_code`) and the account_updated webhook
 * shape (`data.account._id`, `accountNumber`, `institution.bankCode`).
 */
export function normalizeAccount(
  envelope: unknown,
  fallbackAccountId: string,
): ProviderAccount {
  const root = asRecord(envelope);
  const data = asRecord(root?.data) ?? root ?? {};
  const accountRec = asRecord(data.account) ?? data;
  const metaRec = asRecord(data.meta) ?? {};
  const institution = asRecord(accountRec.institution) ?? {};

  const providerAccountId =
    asString(accountRec.id) ?? asString(accountRec._id) ?? fallbackAccountId;

  const balance = asMinorAmount(accountRec.balance);
  const currency = asString(accountRec.currency) ?? "NGN";
  const institutionName = asString(institution.name) ?? "Bank";

  return {
    providerAccountId,
    institutionId: asString(institution.bank_code) ?? asString(institution.bankCode),
    institutionName,
    displayName: asString(accountRec.name) ?? institutionName,
    maskedAccountNumber: maskAccountNumber(
      asString(accountRec.account_number) ?? asString(accountRec.accountNumber),
    ),
    currency: /^[A-Z]{3}$/.test(currency) ? currency : "NGN",
    currentBalanceMinor: balance ?? 0,
    // Mono exposes one balance per account; there is no separate available
    // figure, so the two are reported consistently rather than faked apart.
    availableBalanceMinor: balance ?? 0,
    status: "active",
    dataStatus: toDataStatus(metaRec.data_status),
  };
}

/** Normalise one transaction, or null when it cannot be trusted. */
export function normalizeTransaction(row: unknown): ProviderTransaction | null {
  const rec = asRecord(row);
  if (!rec) return null;

  const providerTransactionId = asString(rec.id);
  const amountMinor = asMinorAmount(rec.amount);
  const type = asString(rec.type);
  const date = asString(rec.date);
  if (!providerTransactionId || amountMinor === null) return null;
  if (type !== "debit" && type !== "credit") return null;
  if (!date || Number.isNaN(Date.parse(date))) return null;

  const narration = asString(rec.narration) ?? "";
  const direction = type;
  const semanticType = classifyTransaction(direction, asString(rec.category), narration);

  const candidate: ProviderTransaction = {
    providerTransactionId,
    amountMinor,
    currency: "NGN",
    direction,
    semanticType,
    occurredAt: new Date(Date.parse(date)).toISOString(),
    merchantName: narration.slice(0, 120),
    narration,
    normalizedMerchant: normalizeMerchantName(narration),
    budgetEligible: budgetEligibleFor(semanticType),
  };

  // Anything that fails the ledger's own validator is dropped here, never
  // persisted for later cleanup.
  if (validateNormalized(candidate).length > 0) return null;
  return candidate;
}

/**
 * Normalise a transactions page.
 *
 * `hasMore` is decided from how many rows Mono returned, not how many survived
 * validation — otherwise a page of entirely malformed rows would look like the
 * end of the data and silently truncate the ledger.
 */
export function normalizeTransactions(envelope: unknown): ProviderTransactionPage {
  const root = asRecord(envelope);
  const rows = Array.isArray(root?.data) ? (root.data as unknown[]) : [];
  const meta = asRecord(root?.meta) ?? {};
  // Bank-data responses put paging at meta.*; the telco variant nests it.
  const paging = asRecord(meta.paging) ?? meta;

  const total = typeof paging.total === "number" ? paging.total : undefined;
  const page = typeof paging.page === "number" ? paging.page : 1;

  // hasMore must be decided on how many rows Mono returned, not how many
  // survived validation: a page of entirely malformed rows would otherwise look
  // like the end of the data and silently truncate the ledger.
  const receivedAny = rows.length > 0;
  const transactions: ProviderTransaction[] = [];
  for (const row of rows) {
    const normalized = normalizeTransaction(row);
    if (normalized) transactions.push(normalized);
  }

  const hasMore = total !== undefined ? page * (receivedAny ? 1 : 0) < total : receivedAny;
  return { transactions, page, total, hasMore };
}
