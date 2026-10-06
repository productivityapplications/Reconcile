// Deterministic provider_transaction_id for imported rows — PURE.
//
// The ledger's unique key is (provider_id, bank_account_id,
// provider_transaction_id). A CSV has no upstream transaction id we can trust,
// so the id is derived from the row's own content. That makes re-importing the
// same file a no-op through the existing constraint, with no extra bookkeeping.
//
// The hash covers date, amount, direction and narration — the fields that
// together identify a statement line. It deliberately does NOT cover the row
// number or file name: the same transaction appearing in a re-downloaded or
// re-ordered export must produce the same id, or dedupe silently fails.
//
// Balance is excluded for the same reason: it is a running total that shifts
// when unrelated rows change.

import type { Direction } from "../finance.ts";

export interface HashInput {
  /** ISO instant, as produced by parseCsv. */
  date: string;
  amountMinor: number;
  direction: Direction;
  description: string;
}

/**
 * Normalise the description before hashing.
 *
 * Banks pad narrations inconsistently and vary whitespace between exports, so
 * case and whitespace are collapsed. The description itself is NOT otherwise
 * altered — that happens in the normaliser, not the identity function.
 */
function canonicalDescription(raw: string): string {
  return raw.toLowerCase().replace(/\s+/g, " ").trim();
}

/** The canonical string that gets hashed. Exported for tests and debugging. */
export function canonicalRowKey(input: HashInput): string {
  const direction = input.direction === "debit" ? "d" : "c";
  return [
    input.date,
    String(Math.abs(input.amountMinor)),
    direction,
    canonicalDescription(input.description),
  ].join("|");
}

/**
 * SHA-256 of an arbitrary string, hex encoded.
 *
 * Exported because account identity derives from it too (see ./provider.ts
 * `accountKeyFor`), and the same primitive must be used in both places.
 */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * SHA-256 of the canonical row key, hex encoded.
 *
 * Async because it uses WebCrypto, which is the same primitive the Mono
 * webhook already uses for payload hashing.
 */
export async function csvTransactionId(input: HashInput): Promise<string> {
  return await sha256Hex(canonicalRowKey(input));
}

/** Hash many rows, preserving input order. */
export async function csvTransactionIds(
  inputs: HashInput[],
): Promise<string[]> {
  return await Promise.all(inputs.map((i) => csvTransactionId(i)));
}