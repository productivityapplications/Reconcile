// POST /functions/v1/csv-import
//
// Phase 12. Imports a bank statement CSV and writes normalised transactions
// through the same `_shared/ingest.ts` pipeline the Mono and demo providers
// use, so dedupe, internal-transfer pairing and review-state creation behave
// identically no matter where the rows came from.
//
// Flow: authenticate -> parse -> normalise -> hash -> find/create the synthetic
// connection and account -> ingest (dedupe on the unique key) -> write
// sync_runs -> summarise.
//
// PRIVACY. The CSV content is parsed in memory and never persisted, logged, or
// echoed back. Only counts and the first few row summaries come back to the
// client. Bank credentials never appear in a statement export and are not
// accepted in any field.
//
// OWNERSHIP. The user id comes from the verified JWT, never from the request
// body. A caller cannot import into another user's ledger.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { requireUser } from "../_shared/auth.ts";
import { json, preflight } from "../_shared/cors.ts";
import { errResponse } from "../_shared/envelope.ts";
import { checkSyncRateLimit } from "../_shared/rateLimit.ts";
import { ingestTransactions } from "../_shared/ingest.ts";
import { upsertConnection } from "../_shared/providers/persist.ts";
import {
  CSV_PROVIDER_ID,
  CsvParseError,
  accountKeyFor,
  parseCsv,
  planImport,
  validateMapping,
  type ColumnMapping,
} from "../_shared/csv/index.ts";
import type { Direction } from "../_shared/finance.ts";

/** 10 imports per hour per user. Generous for real use, tight against abuse. */
const CSV_RATE_LIMIT = { max: 10, windowSeconds: 60 * 60 } as const;

/** Refuse oversized bodies before spending any parsing effort. */
const MAX_CONTENT_BYTES = 5 * 1024 * 1024;
/** Guard against a pathological file; also bounds the insert batch. */
const MAX_ROWS = 5000;
/** Rows echoed back for preview. Never more than this. */
const PREVIEW_ROWS = 5;

interface ImportRequest {
  fileName?: string;
  csvContent?: string;
  accountLabel?: string;
  mapping?: ColumnMapping | null;
  layoutId?: string | null;
  /** When true, parse and report counts without writing anything. */
  preview?: boolean;
  currency?: string;
  /**
   * Direction to assume for rows no explicit signal resolved. Defaults to
   * expense, which is the safer wrong answer for a spending statement.
   */
  assume?: Direction;
  /** Per-row direction overrides from the preview, keyed by row number. */
  directionOverrides?: Record<number, Direction> | null;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") {
    return errResponse(405, "METHOD_NOT_ALLOWED", "Use POST.", false);
  }

  const authed = await requireUser(req);
  if (authed instanceof Response) return authed;
  const { client, userId } = authed;

  let body: ImportRequest;
  try {
    body = (await req.json()) as ImportRequest;
  } catch {
    return errResponse(400, "INVALID_INPUT", "Request body must be JSON.", false);
  }

  const content = typeof body.csvContent === "string" ? body.csvContent : "";
  if (content.trim().length === 0) {
    return errResponse(400, "CSV_EMPTY", "We could not read that file.", false);
  }
  // Character count is a safe upper bound on byte count for this purpose and
  // avoids buffering the raw bytes.
  if (content.length > MAX_CONTENT_BYTES) {
    return errResponse(
      413,
      "CSV_TOO_LARGE",
      "That file is too large. Please split it into smaller files.",
      false,
    );
  }

  const limit = await checkSyncRateLimit(client, userId, CSV_RATE_LIMIT);
  if (!limit.allowed) {
    return errResponse(
      429,
      "CSV_RATE_LIMITED",
      "You've imported a few files recently. Please try again later.",
      true,
    );
  }

  // ---- parse -----------------------------------------------------------
  let parsed;
  try {
    parsed = parseCsv(content, {
      mapping: body.mapping ?? null,
      layoutId: body.layoutId ?? null,
      maxRows: MAX_ROWS,
      assume: body.assume ?? "debit",
      directionOverrides: body.directionOverrides ?? null,
    });
  } catch (error) {
    if (error instanceof CsvParseError) {
      return errResponse(400, error.code, error.message, false);
    }
    return errResponse(
      400,
      "CSV_PARSE_FAILED",
      "We could not read that file. Check it is a CSV export from your bank.",
      false,
    );
  }

  // Unrecognised headers: tell the client to ask the user to map columns, and
  // include what was detected so the UI can prefill a sensible guess.
  if (parsed.needsMapping) {
    return json(
      {
        ok: false,
        needsMapping: true,
        layoutId: parsed.layoutId,
        headers: parsed.headers,
        totalRows: parsed.totalRows,
        missingRequired: parsed.missingRequired,
        message: "We could not recognise these columns. Please map them for us.",
      },
      422,
    );
  }

  // A client-supplied mapping is validated before use, so a mapping naming a
  // column that is not in the file is rejected instead of importing nothing.
  if (body.mapping) {
    const check = validateMapping(body.mapping, parsed.headers);
    if (!check.ok) {
      return errResponse(400, "CSV_INVALID_MAPPING", check.message ?? "Invalid mapping.", false);
    }
  }

  const plan = await planImport(parsed.rows);
  const currency = isIsoCurrency(body.currency) ? body.currency : "NGN";
  const transactions = plan.transactions.map((t) => ({ ...t, currency }));

  // ---- preview: count without writing ----------------------------------
  if (body.preview === true) {
    const existing = await existingIds(client, userId, transactions.map((t) => t.providerTransactionId));
    return json({
      ok: true,
      preview: true,
      layoutId: parsed.layoutId,
      layoutLabel: parsed.layoutLabel,
      ambiguousLayout: parsed.ambiguous,
      headers: parsed.headers,
      mapping: parsed.mapping,
      totalRows: parsed.totalRows,
      parsed: plan.transactions.length + plan.rejected,
      parsedOk: plan.transactions.length,
      added: transactions.length - existing.size,
      duplicates: existing.size,
      duplicateWithinFile: plan.duplicateWithinFile,
      assumedDirectionCount: parsed.assumedDirectionCount,
      issues: parsed.issues.slice(0, 20),
      issueCount: parsed.issues.length,
      // Sampled from the parsed rows rather than the planned transactions: the
      // preview is about what was read from the file, before persistence.
      sample: previewOf(parsed.rows),
    });
  }

  if (plan.transactions.length === 0) {
    return errResponse(
      422,
      "CSV_NO_USABLE_ROWS",
      "We could not read any transactions from that file. Check the column mapping.",
      false,
    );
  }

  // ---- synthetic connection + account ----------------------------------
  const label = sanitiseLabel(body.accountLabel) || defaultLabel(body.fileName);
  // Identity comes from the file's own account number when it has one, so two
  // statements for the same real account resolve to a single row. Otherwise it
  // falls back to user + label. Never from the file content, which would split
  // one real account into two when the user re-downloads an updated statement.
  const fileAccountNumber = parsed.rows.find((r) => r.accountNumber)?.accountNumber ?? null;
  const accountKey = await accountKeyFor({ userId, accountLabel: label, accountNumber: fileAccountNumber });

  const { row: connection, error: connError } = await upsertConnection(client, {
    userId,
    providerId: CSV_PROVIDER_ID,
    providerConnectionId: `csv_${accountKey}`,
    status: "active",
    consentedAt: null,
  });
  if (connError || !connection) {
    return errResponse(
      500,
      "CSV_CONNECTION_FAILED",
      "We could not save that import. Please try again.",
      true,
    );
  }

  const { data: accountRow, error: accountError } = await client
    .from("bank_accounts")
    .upsert(
      [
        {
          user_id: userId,
          bank_connection_id: connection.id,
          provider_id: CSV_PROVIDER_ID,
          provider_account_id: accountKey,
          // A CSV carries no institution identity, and the bank name comes from
          // the user's own label rather than from detection.
          institution_id: null,
          institution_name: null,
          display_name: label,
          // Only ever a last-two style fragment, and only when the file stated
          // the number itself. Nothing is invented.
          masked_account_number: maskAccountNumber(fileAccountNumber),
          currency,
          current_balance_minor: 0,
          available_balance_minor: 0,
          status: "active",
          updated_at: new Date().toISOString(),
        },
      ],
      { onConflict: "provider_id,provider_account_id" },
    )
    .select("id")
    .single();
  if (accountError || !accountRow) {
    return errResponse(
      500,
      "CSV_ACCOUNT_FAILED",
      "We could not save that import. Please try again.",
      true,
    );
  }

  // ---- sync_runs bookkeeping -------------------------------------------
  const { data: run } = await client
    .from("sync_runs")
    .insert({
      user_id: userId,
      bank_connection_id: connection.id,
      mode: "csv-import",
      status: "started",
    })
    .select("id")
    .single();

  // ---- write -----------------------------------------------------------
  let result;
  try {
    result = await ingestTransactions(client, {
      userId,
      providerId: CSV_PROVIDER_ID,
      accountIdByProvider: { [accountKey]: accountRow.id as string },
      transactions: transactions.map((t) => ({
        providerAccountId: accountKey,
        transaction: t,
      })),
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "CSV_INGEST_FAILED";
    if (run) {
      await client
        .from("sync_runs")
        .update({
          status: "failed",
          completed_at: new Date().toISOString(),
          error_code: code,
        })
        .eq("id", run.id);
    }
    return errResponse(500, code, "We could not save those transactions. Please try again.", true);
  }

  if (run) {
    await client
      .from("sync_runs")
      .update({
        status: "complete",
        completed_at: new Date().toISOString(),
        transactions_seen: result.seen,
        transactions_added: result.inserted,
      })
      .eq("id", run.id);
  }

  await client
    .from("bank_connections")
    .update({ last_sync_at: new Date().toISOString() })
    .eq("id", connection.id);

  return json({
    ok: true,
    layoutId: parsed.layoutId,
    layoutLabel: parsed.layoutLabel,
    ambiguousLayout: parsed.ambiguous,
    assumedDirectionCount: parsed.assumedDirectionCount,
    totalRows: parsed.totalRows,
    parsed: parsed.rows.length,
    parsedOk: plan.transactions.length,
    added: result.inserted,
    skipped: result.seen - result.inserted,
    rejected: result.rejected + plan.rejected,
    duplicateWithinFile: plan.duplicateWithinFile,
    issueCount: parsed.issues.length,
    issues: parsed.issues.slice(0, 20),
    reviewsCreated: result.reviewsCreated,
    internalTransferPairs: result.internalTransferPairs,
    connectionId: connection.id,
    accountId: accountRow.id,
    accountLabel: label,
    runId: run?.id ?? null,
  });
});

// -------------------------------------------------------------- helpers

/**
 * Which of these ids already exist for this user, so a preview can say how
 * many rows would actually be added.
 *
 * Querying by user (not by account) is deliberate: the same statement imported
 * twice lands on the same account, but a user may also re-import into a
 * differently-labelled account, and the id is content-derived so it is stable
 * either way.
 */
async function existingIds(
  client: SupabaseClient,
  userId: string,
  ids: string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  if (ids.length === 0) return found;
  // Chunked so the URL never exceeds a database parameter limit on a big file.
  const CHUNK = 200;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const { data } = await client
      .from("transactions")
      .select("provider_transaction_id")
      .eq("user_id", userId)
      .eq("provider_id", CSV_PROVIDER_ID)
      .in("provider_transaction_id", chunk);
    for (const row of (data ?? []) as { provider_transaction_id: string }[]) {
      found.add(row.provider_transaction_id);
    }
  }
  return found;
}

/** Echo at most a few rows back, never the whole file. */
function previewOf(rows: {
  rowNumber: number;
  date: string;
  description: string;
  amountMinor: number;
  direction: string;
  directionSource: string;
  needsDirectionConfirmation: boolean;
}[]): {
  rowNumber: number;
  date: string;
  description: string;
  amountMinor: number;
  direction: string;
  directionSource: string;
  needsDirectionConfirmation: boolean;
}[] {
  // Echoed with row numbers so the preview's per-row direction override can name
  // the right row on the way back.
  return rows.slice(0, PREVIEW_ROWS).map((r) => ({
    rowNumber: r.rowNumber,
    date: r.date.slice(0, 10),
    description: r.description.slice(0, 80),
    amountMinor: r.amountMinor,
    direction: r.direction,
    directionSource: r.directionSource,
    needsDirectionConfirmation: r.needsDirectionConfirmation,
  }));
}

/**
 * Show only the last two characters of an account number the file itself
 * provided. A CSV statement has no other masking guarantee, so this keeps the
 * useful "which account is this?" cue without storing a full number.
 */
function maskAccountNumber(raw: string | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 4) return null;
  return `****${digits.slice(-2)}`;
}

function sanitiseLabel(raw: string | undefined): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/\s+/g, " ").trim().slice(0, 60);
}

function defaultLabel(fileName: string | undefined): string {
  const base = (fileName ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ").trim();
  return sanitiseLabel(cleaned) || "Imported statement";
}

function isIsoCurrency(raw: string | undefined): boolean {
  return typeof raw === "string" && /^[A-Z]{3}$/.test(raw);
}
