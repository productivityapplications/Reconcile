// CSV import pipeline — public surface for Edge Functions and tests.
//
// Everything re-exported here is PURE (no Deno, no I/O) except the hashing
// helpers, which use WebCrypto and are therefore async.

export { CSV_LAYOUTS, layoutById, layoutLabel, normalizeHeader, REQUIRED_FIELDS, UNKNOWN_LAYOUT_ID } from "./layouts.ts";
export type { CsvLayout, CanonicalField } from "./layouts.ts";
export { detectLayout, mapHeadersFor } from "./detect.ts";
export type { DetectionResult, ColumnMapping } from "./detect.ts";
export { parseCsvDate } from "./dates.ts";
export type { ParsedDate } from "./dates.ts";
export { parseAmountCell, resolveRowAmount } from "./amounts.ts";
export type { ParsedAmount } from "./amounts.ts";
export {
  resolveDirection,
  directionFromTypeColumn,
  directionFromDescription,
  directionFromBalance,
  looksLikeRefund,
} from "./direction.ts";
export type { ResolvedDirection, DirectionSource } from "./direction.ts";
export { parseCsv, readCsvRecords, CsvParseError, DEFAULT_MAX_ROWS } from "./parse.ts";
export type { ParseResult, ParseOptions, IntermediateRow, RowIssue } from "./parse.ts";
export { csvTransactionId, csvTransactionIds, canonicalRowKey, sha256Hex } from "./hash.ts";
export type { HashInput } from "./hash.ts";
export {
  MAPPING_OPTIONS,
  validateMapping,
  suggestMapping,
  describeColumn,
} from "./map.ts";
export type { MappingOption, MappingValidation } from "./map.ts";
export { CSV_PROVIDER_ID, csvProvider, accountKeyFor } from "./provider.ts";
export { planImport, toProviderTransaction, CSV_DEFAULT_CURRENCY } from "./toTransactions.ts";
export type { PlannedTransaction, ImportPlan } from "./toTransactions.ts";