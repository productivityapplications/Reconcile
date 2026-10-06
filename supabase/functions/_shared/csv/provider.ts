// CSV provider adapter — implements the frozen FinancialProvider contract
// (ARCHITECTURE.md §3, types in ../types.ts).
//
// WHY MOST OF THIS INTERFACE IS UNUSED
//
// `FinancialProvider` was designed for a *pull* provider: the app asks for
// institutions, opens a hosted connection, and pulls transactions on demand.
// A CSV import is not that. There is no session to create, nothing to refresh,
// and no upstream to list transactions from — the rows arrive once, inside the
// request body of a single Edge Function call, and are then gone.
//
// So the CSV provider implements the contract to the extent it is meaningful:
//
//   getInstitutions        -> [] : there are no institutions to connect to.
//   createConnectionSession -> not used: importing is not a connection flow.
//   refreshAccount          -> not used: a CSV file is a point-in-time export,
//                             so "refresh" has no meaning.
//   listAccounts            -> the synthetic account this provider creates,
//                             read back from our own rows.
//   listTransactions        -> transactions already imported, read back from
//                             our own rows. This is not a provider fetch.
//   disconnect               -> local only: revokes the synthetic connection
//                             and stops treating the account as live.
//
// The actual parsing and persistence happens in the dedicated `csv-import`
// Edge Function, which then writes through the same `_shared/ingest.ts`
// pipeline the other providers use. That is deliberate: CSV is a sibling of
// Mono, not a replacement, and it must not be able to bypass validation,
// dedupe, internal-transfer pairing or review-state creation.
//
// Server-side only. Never import from app/ or src/.

import type {
  ConnectionSession,
  CreateConnectionInput,
  DisconnectInput,
  FinancialProvider,
  GetInstitutionsInput,
  Institution,
  ListAccountsInput,
  ListTransactionsInput,
  ProviderAccount,
  ProviderTransaction,
  ProviderTransactionPage,
  RefreshAccountInput,
  RefreshResult,
} from "../providers/types.ts";
import { CSV_PROVIDER_ID } from "./toTransactions.ts";
import { sha256Hex } from "./hash.ts";

export { CSV_PROVIDER_ID };

/**
 * The provider_account_id for an imported statement.
 *
 * Precedence:
 *   1. The account number the file itself carries, when it has one. This is the
 *      strongest identity available: two statements for the same real account
 *      resolve to the same row even if the user relabelled them.
 *   2. Otherwise a hash of the user id and the account label. That keeps
 *      "GTBank Personal" and "GTBank Business" distinct, and re-importing to the
 *      same label updates the same account instead of creating a duplicate.
 *
 * The file content is deliberately not part of this. Including it would give a
 * re-downloaded but updated statement a new provider_account_id, splitting one
 * real account into two rows.
 */
export async function accountKeyFor(input: {
  userId: string;
  accountLabel: string;
  accountNumber?: string | null;
}): Promise<string> {
  const number = input.accountNumber?.trim() ?? "";
  if (number.length > 0) {
    // Scoped to the user so two users with the same account number cannot
    // collide on the (provider_id, provider_account_id) unique constraint.
    const digest = await sha256Hex(`${input.userId}|acct|${number}`);
    return `acct_${digest.slice(0, 24)}`;
  }
  const digest = await sha256Hex(`${input.userId}|${input.accountLabel.trim().toLowerCase()}`);
  return `label_${digest.slice(0, 24)}`;
}

/**
 * A CSV import cannot stream or be refreshed, so the usual provider
 * capabilities are false. `multipleAccounts` is true: a user can import
 * several statements, each becoming its own synthetic account.
 */
export const capabilities = {
  realtime: false,
  pagination: false,
  reauth: false,
  multipleAccounts: true,
  disconnect: true,
} as const;

/**
 * A placeholder session.
 *
 * Not reachable through the UI — importing does not go through
 * bank-connect-session. It exists so the contract is satisfied and so a caller
 * that does reach it gets a truthful object rather than an exception.
 */
function unsupportedSession(input: CreateConnectionInput): ConnectionSession {
  return {
    providerId: CSV_PROVIDER_ID,
    reference: `csv_${input.userId}`,
  };
}

export const csvProvider: FinancialProvider = {
  id: CSV_PROVIDER_ID,
  capabilities,

  /** There is nothing to connect to; CSV imports are not institution-based. */
  async getInstitutions(input: GetInstitutionsInput): Promise<Institution[]> {
    void input;
    return [];
  },

  async createConnectionSession(input: CreateConnectionInput): Promise<ConnectionSession> {
    return unsupportedSession(input);
  },

  /**
   * Not meaningful. A CSV export is a snapshot, so there is no upstream state
   * that could have moved since the last read.
   */
  async refreshAccount(input: RefreshAccountInput): Promise<RefreshResult> {
    void input;
    return {
      status: "unavailable",
      dataStatus: null,
      checkedAt: new Date().toISOString(),
    };
  },

  /**
   * Not reachable in normal use — the `csv-import` function creates the account
   * and returns it. Provided for contract completeness and for read-back.
   */
  async listAccounts(input: ListAccountsInput): Promise<ProviderAccount[]> {
    void input;
    return [];
  },

  /**
   * Not a provider fetch. A real implementation would need the Supabase client,
   * which a pure adapter does not hold; reads go through `getTransactions` in
   * `src/lib/db.ts`, which queries the ledger directly under RLS.
   */
  async listTransactions(
    input: ListTransactionsInput,
  ): Promise<ProviderTransactionPage> {
    void input;
    return { transactions: [] as ProviderTransaction[], page: 1, hasMore: false };
  },

  /** Local only. The `csv-import` sibling path performs the row updates. */
  async disconnect(input: DisconnectInput): Promise<void> {
    void input;
  },
};