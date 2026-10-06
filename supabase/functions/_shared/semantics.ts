// Provider-neutral transaction semantics — PURE.
//
// Shared by every ingestion path (Mono, CSV, and the demo fixture) so the
// deterministic classification rules exist once. Extracted from
// `providers/mono/normalize.ts` without changing behaviour: that module
// re-exports `classifyTransaction` from here, so Mono's surface and output are
// unchanged.
//
// These rules stay deterministic and conservative. Nothing here calls out to
// an LLM, and `unknown` is deliberately not an outcome once a row has a
// resolved direction — a row that reaches here is either money in or money out.

import { normalizeMerchantName, type Direction, type SemanticType } from "./finance.ts";

/**
 * Classify one resolved transaction.
 *
 * `category` is a provider-supplied hint (Mono sends one; CSV imports have
 * none, so they pass null and the narration alone decides).
 *
 * Transfer-vs-expense and internal-vs-external are NOT decided here: internal
 * transfers are detected across rows by the deterministic pairing pass in
 * `_shared/ingest.ts`.
 */
export function classifyTransaction(
  direction: Direction,
  category: string | null,
  narration: string,
): SemanticType {
  const cat = (category ?? "").toLowerCase();
  const text = normalizeMerchantName(narration);

  if (cat.includes("refund") || text.includes("refund") || text.includes("reversal")) {
    return "refund";
  }
  if (cat.includes("salary") || cat.includes("payroll") || cat.includes("income")) {
    return "income";
  }
  if (cat.includes("transfer") || text.includes("transfer")) {
    return direction === "credit" ? "external_transfer" : "expense";
  }
  if (cat.includes("charge") || cat.includes("fee")) {
    return "expense";
  }
  return direction === "credit" ? "income" : "expense";
}

/** Internal transfers are decided across rows and are never budget-eligible. */
export function budgetEligibleFor(semanticType: SemanticType): boolean {
  return semanticType !== "internal_transfer";
}