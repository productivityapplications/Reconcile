// Typed data access for screens. Reads go to Supabase under RLS;
// privileged writes go through Edge Functions. No raw SQL, no raw fetch,
// no function URLs outside this module.
import { getSupabase } from "./supabase";
import {
  asEmbedArray,
  countMatchingConfirmations,
  shouldCreateRule,
} from "../../supabase/functions/_shared/finance";

export interface BankConnection {
  id: string;
  provider_id: string;
  status: string;
  last_sync_at: string | null;
}

export interface BankAccount {
  id: string;
  bank_connection_id: string;
  institution_name: string | null;
  display_name: string | null;
  masked_account_number: string | null;
  currency: string;
  current_balance_minor: number;
  available_balance_minor: number;
  status: string;
}

export interface Category {
  id: string;
  label: string;
}

export interface TxnReview {
  status: string;
  category_id: string | null;
  user_note: string | null;
  display_name?: string | null;
}

export interface UserProfile {
  id: string;
  email: string | null;
  avatar_url: string | null;
}

export interface Transaction {
  id: string;
  bank_account_id: string;
  amount_minor: number;
  currency: string;
  direction: string;
  semantic_type: string;
  occurred_at: string;
  merchant_name: string | null;
  narration: string | null;
  normalized_merchant: string | null;
  budget_eligible: boolean;
  transaction_reviews: TxnReview[];
  bank_accounts?: { display_name: string | null; masked_account_number?: string | null } | null;
}

export interface ReviewItem {
  id: string;
  transaction_id: string;
  status: string;
  category_id: string | null;
  user_note: string | null;
  display_name?: string | null;
  transaction: Transaction;
}

export interface Budget {
  id: string;
  period_start: string;
  period_end: string;
  total_limit_minor: number;
  currency: string;
}

export interface BudgetCap {
  category_id: string;
  limit_minor: number;
}

function friendly(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return fallback;
}

async function currentUserId(): Promise<string> {
  const { data, error } = await getSupabase().auth.getUser();
  if (error || !data.user) throw new Error("Please sign in and try again.");
  return data.user.id;
}

export async function getProfile(): Promise<UserProfile | null> {
  const { data, error } = await getSupabase()
    .from("users")
    .select("id,email,avatar_url")
    .maybeSingle();
  if (error) throw new Error(friendly(error, "Could not load profile."));
  return (data as UserProfile | null) ?? null;
}

export async function setAvatarUrl(url: string | null): Promise<void> {
  const userId = await currentUserId();
  const { error } = await getSupabase()
    .from("users")
    .update({ avatar_url: url })
    .eq("id", userId);
  if (error) throw new Error(friendly(error, "Could not save photo."));
}

export async function getActiveConnection(): Promise<BankConnection | null> {
  const { data, error } = await getSupabase()
    .from("bank_connections")
    .select("id,provider_id,status,last_sync_at")
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(friendly(error, "Could not load connection."));
  return data;
}

/**
 * The user's current connection including ones that need attention.
 *
 * Phase 11: `getActiveConnection` filters to `status = 'active'`, so a
 * `reauth_required` connection is invisible and the user is never prompted to
 * reconnect. This reads the newest connection regardless of status so the UI
 * can show the reauth state and offer a reconnect.
 *
 * `revoked` is excluded: a revoked connection is something the user has
 * already ended and should not be surfaced as needing attention.
 */
export async function getCurrentConnection(): Promise<BankConnection | null> {
  const { data, error } = await getSupabase()
    .from("bank_connections")
    .select("id,provider_id,status,last_sync_at")
    .neq("status", "revoked")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(friendly(error, "Could not load connection."));
  return data;
}

/** True when the connection needs the user to re-consent with their bank. */
export function needsReauth(connection: BankConnection | null): boolean {
  return connection?.status === "reauth_required";
}

export async function getAccounts(): Promise<BankAccount[]> {
  const { data, error } = await getSupabase()
    .from("bank_accounts")
    .select(
      "id,bank_connection_id,institution_name,display_name,masked_account_number,currency,current_balance_minor,available_balance_minor,status",
    )
    .order("display_name");
  if (error) throw new Error(friendly(error, "Could not load accounts."));
  return data ?? [];
}

export async function getCategories(): Promise<Category[]> {
  const { data, error } = await getSupabase()
    .from("categories")
    .select("id,label")
    .order("label");
  if (error) throw new Error(friendly(error, "Could not load categories."));
  return data ?? [];
}

export async function connectDemo(): Promise<{
  connection: BankConnection;
  accounts: BankAccount[];
  created: boolean;
}> {
  const { data, error } = await getSupabase().functions.invoke(
    "bank-connect-session",
    { body: { provider_id: "demo" } },
  );
  if (error) throw new Error(friendly(error, "Demo setup failed."));
  return data as { connection: BankConnection; accounts: BankAccount[]; created: boolean };
}

export async function syncConnection(
  connectionId: string,
  mode: "initial" | "manual" = "manual",
): Promise<{ seen: number; added: number; internal_transfer_pairs: number }> {
  const { data, error } = await getSupabase().functions.invoke("bank-sync", {
    body: { bank_connection_id: connectionId, mode },
  });
  if (error) throw new Error(friendly(error, "Sync failed."));
  return data as { seen: number; added: number; internal_transfer_pairs: number };
}

export async function disconnectConnection(connectionId: string): Promise<void> {
  const { error } = await getSupabase().functions.invoke("bank-disconnect", {
    body: { bank_connection_id: connectionId },
  });
  if (error) throw new Error(friendly(error, "Disconnect failed."));
}

export interface AskResult {
  intent: string;
  answer: string;
  basis: string;
}

export async function askQuestion(question: string): Promise<AskResult> {
  const { data, error } = await getSupabase().functions.invoke("ai-ask", {
    body: { question },
  });
  if (error) throw new Error(friendly(error, "Could not answer that question."));
  return data as AskResult;
}

// --------------------------------------------------- real bank (Phase 11)

/** What bank-connect-session returns for a real provider. */
export interface ConnectSession {
  provider_id: string;
  reference: string;
  connect_url: string | null;
  session_token: string | null;
  public_key: string | null;
  expires_at: string | null;
}

/**
 * Ask the server to start a real bank connection.
 *
 * The server mints the Mono Connect Link, so the secret key never reaches this
 * module and nothing Mono-specific is constructed on the client.
 */
export async function createConnectSession(
  providerId: string,
  redirectUrl: string,
): Promise<ConnectSession> {
  const { data, error } = await getSupabase().functions.invoke("bank-connect-session", {
    body: { provider_id: providerId, redirect_url: redirectUrl },
  });
  if (error) throw new Error(friendly(error, "Could not start the bank connection."));
  return data as ConnectSession;
}

/**
 * Exchange the widget's authorization code for an account, server-side.
 *
 * Returns null when Mono reports the account's data is not ready yet, which is
 * a normal state right after linking rather than an error.
 */
export async function exchangeConnectCode(code: string): Promise<boolean> {
  const { error } = await getSupabase().functions.invoke("bank-exchange-code", {
    body: { code },
  });
  if (!error) return true;
  const message = friendly(error, "");
  if (message.includes("CONNECT_ACCOUNT_UNAVAILABLE")) return false;
  throw new Error(message || "Could not complete the bank connection.");
}

/**
 * Wait for the `account_connected` webhook to activate a reserved connection.
 *
 * Mono's documented Connect Link flow completes via webhook, not via a code the
 * host can read, so the app polls the connection row it caused to be created.
 * This is a UI-side wait only; nothing here can change server state.
 */
export async function waitForConnection(
  reference: string,
  options: { attempts?: number; intervalMs?: number } = {},
): Promise<BankConnection | null> {
  const attempts = options.attempts ?? 12;
  const intervalMs = options.intervalMs ?? 2500;

  for (let i = 0; i < attempts; i++) {
    const { data, error } = await getSupabase()
      .from("bank_connections")
      .select("id,provider_id,status,last_sync_at")
      .eq("provider_connection_id", reference)
      .maybeSingle();
    if (error) throw new Error(friendly(error, "Could not check the bank connection."));
    if (data && data.status !== "pending") return data as BankConnection;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

// ------------------------------------------------------ CSV import (Phase 12)

/** Column mapping the server understands. Header text -> canonical role. */
export interface CsvColumnMapping {
  date?: string;
  description?: string;
  debit?: string;
  credit?: string;
  amount?: string;
  balance?: string;
  reference?: string;
}

export interface CsvRowIssue {
  rowNumber: number;
  reason: string;
  detail: string;
}

export interface CsvPreviewResult {
  /** Server could not recognise the columns; the UI must offer mapping. */
  needsMapping: boolean;
  headers?: string[];
  missingRequired?: string[];
  message?: string;
  /** Detected column layout. "unknown" means the UI must offer mapping. */
  layoutId?: string;
  /** Human shape description, e.g. "date, narration, debit, credit, balance". */
  layoutLabel?: string | null;
  ambiguousLayout?: boolean;
  totalRows?: number;
  parsed?: number;
  parsedOk?: number;
  added?: number;
  duplicates?: number;
  duplicateWithinFile?: number;
  /** Rows whose direction came from a weak signal (balance, or assumed). */
  assumedDirectionCount?: number;
  issues?: CsvRowIssue[];
  issueCount?: number;
  sample?: CsvSampleRow[];
}

/**
 * One row echoed back for the preview.
 *
 * `directionSource` and `needsDirectionConfirmation` let the preview separate a
 * direction the file stated from one we inferred, so the user can see which rows
 * are worth checking.
 */
export interface CsvSampleRow {
  rowNumber: number;
  date: string;
  description: string;
  amountMinor: number;
  direction: string;
  directionSource: string;
  needsDirectionConfirmation: boolean;
}

export interface CsvImportResult {
  layoutId: string;
  layoutLabel: string | null;
  ambiguousLayout?: boolean;
  assumedDirectionCount?: number;
  totalRows: number;
  parsed: number;
  added: number;
  skipped: number;
  rejected: number;
  duplicateWithinFile: number;
  issueCount: number;
  issues: CsvRowIssue[];
  connectionId: string;
  accountId: string;
  accountLabel: string;
}

export interface CsvImportInput {
  fileName: string;
  csvContent: string;
  /** User-supplied name for the account. This is the bank name we display. */
  accountLabel?: string;
  mapping?: CsvColumnMapping | null;
  /** Direction to assume for rows nothing resolved. Defaults to expense. */
  assume?: "debit" | "credit";
  /** Per-row direction overrides from the preview, keyed by row number. */
  directionOverrides?: Record<number, "debit" | "credit"> | null;
}

/**
 * Parse a file and report what an import would do, without writing anything.
 *
 * The CSV travels in the request body and is never stored: the server parses
 * it in memory and returns only counts and a few sample rows.
 */
export async function previewCsv(
  input: CsvImportInput,
): Promise<CsvPreviewResult> {
  const { data, error } = await getSupabase().functions.invoke("csv-import", {
    body: { ...input, preview: true },
  });
  // The server answers an unrecognised header row with 422 and a needsMapping
  // body. That is a valid answer to a preview, not a failure, so the body is
  // read out of the error rather than thrown.
  if (error) {
    if (isNeedsMapping(data)) return data as unknown as CsvPreviewResult;
    throw new Error(friendly(error, "Could not read that file."));
  }
  return data as CsvPreviewResult;
}

/** True when a failed invoke is really the "please map the columns" response. */
function isNeedsMapping(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { needsMapping?: unknown }).needsMapping === true
  );
}

/** Commit an import. Returns counts plus the connection/account it created. */
export async function importCsv(input: CsvImportInput): Promise<CsvImportResult> {
  const { data, error } = await getSupabase().functions.invoke("csv-import", {
    body: { ...input, preview: false },
  });
  if (error) throw new Error(friendly(error, "Could not import that file."));
  return data as CsvImportResult;
}

export async function getPendingReviews(): Promise<ReviewItem[]> {
  const { data, error } = await getSupabase()
    .from("transaction_reviews")
    .select(
      "id,transaction_id,status,category_id,user_note,display_name,transaction:transactions(id,bank_account_id,amount_minor,currency,direction,semantic_type,occurred_at,merchant_name,narration,normalized_merchant,budget_eligible,bank_accounts(display_name))",
    )
    .eq("status", "needs_review")
    .order("created_at");
  if (error) throw new Error(friendly(error, "Could not load review queue."));
  return (data ?? []) as unknown as ReviewItem[];
}

export async function getReviewCount(): Promise<number> {
  const { count, error } = await getSupabase()
    .from("transaction_reviews")
    .select("id", { count: "exact", head: true })
    .eq("status", "needs_review");
  if (error) throw new Error(friendly(error, "Could not count reviews."));
  return count ?? 0;
}

export async function getTransactions(limit = 200): Promise<Transaction[]> {
  const { data, error } = await getSupabase()
    .from("transactions")
    .select(
      "id,bank_account_id,amount_minor,currency,direction,semantic_type,occurred_at,merchant_name,narration,normalized_merchant,budget_eligible,transaction_reviews(status,category_id,user_note,display_name),bank_accounts(display_name)",
    )
    .order("occurred_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(friendly(error, "Could not load transactions."));
  return ((data ?? []) as unknown as RawTransactionRow[]).map((row) => ({
    ...row,
    transaction_reviews: asEmbedArray(row.transaction_reviews),
  }));
}

interface RawTransactionRow extends Omit<Transaction, "transaction_reviews"> {
  transaction_reviews: TxnReview | TxnReview[] | null;
}

export async function getTransaction(
  id: string,
): Promise<{ txn: Transaction; review: TxnReview | null }> {
  const { data, error } = await getSupabase()
    .from("transactions")
    .select(
      "id,bank_account_id,amount_minor,currency,direction,semantic_type,occurred_at,merchant_name,narration,normalized_merchant,budget_eligible,transaction_reviews(status,category_id,user_note,display_name),bank_accounts(display_name,masked_account_number)",
    )
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(friendly(error, "Could not load transaction."));
  if (!data) throw new Error("Transaction not found.");
  const raw = data as unknown as RawTransactionRow;
  const row: Transaction = {
    ...raw,
    transaction_reviews: asEmbedArray(raw.transaction_reviews),
  };
  return { txn: row, review: row.transaction_reviews[0] ?? null };
}

export async function confirmReview(
  transactionId: string,
  categoryId: string,
  userNote?: string,
  displayName?: string,
): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from("transaction_reviews")
    .update({
      status: "reconciled",
      category_id: categoryId,
      user_note: userNote ?? null,
      // Only overwrite an existing display name when the caller provides
      // one (the detail screen never edits names).
      ...(displayName !== undefined ? { display_name: displayName } : null),
      confirmed_at: new Date().toISOString(),
      source: "user:confirm",
    })
    .eq("transaction_id", transactionId);
  if (error) throw new Error(friendly(error, "Could not confirm review."));
  await maybeLearnMerchantRule(transactionId, categoryId);
}

/**
 * Writes ONLY the user's display name (Phase 10B, Fix C).
 *
 * Deliberately not routed through `confirmReview`: that helper also sets
 * `status`, `category_id`, `user_note`, `confirmed_at`, `source`, and learns
 * a merchant rule. Renaming a transaction must not flip an `excluded`
 * review back to `reconciled`, wipe the user's note, or pollute the learned
 * rules — so this touches the single user-owned display column and nothing
 * else. Provider facts are never involved.
 */
export async function setReviewDisplayName(
  transactionId: string,
  displayName: string,
): Promise<void> {
  const { error } = await getSupabase()
    .from("transaction_reviews")
    .update({ display_name: displayName })
    .eq("transaction_id", transactionId);
  if (error) throw new Error(friendly(error, "Could not save the name."));
}

/**
 * Learned merchant rules: when the same merchant/category pair has been
 * confirmed twice (including this one), store a merchant_rules row so
 * future matches auto-suggest that category. Best-effort: failures here
 * never fail the confirmation itself.
 */
async function maybeLearnMerchantRule(
  transactionId: string,
  categoryId: string,
): Promise<void> {
  try {
    const supabase = getSupabase();
    const userId = await currentUserId();
    const { data: txn } = await supabase
      .from("transactions")
      .select("normalized_merchant")
      .eq("id", transactionId)
      .maybeSingle();
    const merchantKey = (txn as { normalized_merchant?: string } | null)
      ?.normalized_merchant;
    if (!merchantKey) return;
    const { data } = await supabase
      .from("transaction_reviews")
      .select("transaction_id,category_id,transactions!inner(normalized_merchant)")
      .eq("user_id", userId)
      .eq("status", "reconciled")
      .like("source", "user:%");
    const confirmations = ((data ?? []) as unknown as {
      category_id: string;
      transactions: { normalized_merchant: string };
    }[]).map((r) => ({
      merchantKey: r.transactions.normalized_merchant,
      categoryId: r.category_id,
    }));
    if (
      shouldCreateRule(
        countMatchingConfirmations(confirmations, merchantKey, categoryId),
      )
    ) {
      await supabase.from("merchant_rules").upsert(
        {
          user_id: userId,
          merchant_key: merchantKey,
          category_id: categoryId,
          created_from: "confirmed-twice",
          confidence: 1.0,
        },
        { onConflict: "user_id,merchant_key", ignoreDuplicates: true },
      );
    }
  } catch {
    // Best-effort only; confirmation already succeeded.
  }
}

export async function excludeReview(transactionId: string): Promise<void> {
  const { error } = await getSupabase()
    .from("transaction_reviews")
    .update({
      status: "excluded",
      confirmed_at: new Date().toISOString(),
      source: "user:exclude",
    })
    .eq("transaction_id", transactionId);
  if (error) throw new Error(friendly(error, "Could not exclude transaction."));
}

export async function getCurrentMonthBudget(): Promise<{
  budget: Budget | null;
  caps: BudgetCap[];
}> {
  const now = new Date();
  const start = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  const { data, error } = await getSupabase()
    .from("budgets")
    .select("id,period_start,period_end,total_limit_minor,currency")
    .eq("period_type", "monthly")
    .eq("period_start", start)
    .maybeSingle();
  if (error) throw new Error(friendly(error, "Could not load budget."));
  if (!data) return { budget: null, caps: [] };
  const { data: caps, error: capError } = await getSupabase()
    .from("budget_categories")
    .select("category_id,limit_minor")
    .eq("budget_id", (data as Budget).id);
  if (capError) throw new Error(friendly(capError, "Could not load budget caps."));
  return { budget: data as Budget, caps: (caps ?? []) as BudgetCap[] };
}

export async function createBudget(
  totalLimitMinor: number,
  currency: string,
  periodStart: string,
  periodEnd: string,
  caps: BudgetCap[],
): Promise<void> {
  const supabase = getSupabase();
  const userId = await currentUserId();
  const { data, error } = await supabase
    .from("budgets")
    .insert({
      user_id: userId,
      period_type: "monthly",
      period_start: periodStart,
      period_end: periodEnd,
      total_limit_minor: totalLimitMinor,
      currency,
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(friendly(error, "Could not save budget. It may already exist."));
  }
  if (caps.length > 0) {
    const { error: capError } = await supabase.from("budget_categories").insert(
      caps.map((c) => ({
        budget_id: (data as { id: string }).id,
        category_id: c.category_id,
        limit_minor: c.limit_minor,
      })),
    );
    if (capError) throw new Error(friendly(capError, "Budget saved, but caps failed."));
  }
}

/** Update the monthly total and replace the category caps. User-owned rows only. */
export async function updateBudget(
  budgetId: string,
  totalLimitMinor: number,
  caps: BudgetCap[],
): Promise<void> {
  const supabase = getSupabase();
  const userId = await currentUserId();
  const { error } = await supabase
    .from("budgets")
    .update({ total_limit_minor: totalLimitMinor })
    .eq("id", budgetId)
    .eq("user_id", userId);
  if (error) throw new Error(friendly(error, "Could not save budget."));
  const { error: deleteError } = await supabase
    .from("budget_categories")
    .delete()
    .eq("budget_id", budgetId);
  if (deleteError) throw new Error(friendly(deleteError, "Could not save budget caps."));
  if (caps.length > 0) {
    const { error: capError } = await supabase.from("budget_categories").insert(
      caps.map((c) => ({
        budget_id: budgetId,
        category_id: c.category_id,
        limit_minor: c.limit_minor,
      })),
    );
    if (capError) throw new Error(friendly(capError, "Budget saved, but caps failed."));
  }
}

/** "1500.50" (major units) → integer minor units. Throws on invalid input. */
export function parseMajorToMinor(raw: string): number {
  const value = Number.parseFloat(raw.replace(/[,₦\s]/g, ""));
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Enter a valid non-negative amount.");
  }
  return Math.round(value * 100);
}
