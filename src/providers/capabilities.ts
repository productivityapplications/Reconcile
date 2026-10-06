// Static per-provider capability descriptor.
//
// Pure metadata, no network. Read by the UI to decide which flows to offer
// and to avoid promising a provider capability it does not have
// (ARCHITECTURE.md §5: realtime is never promised when unsupported).
//
// Every value here is justified by Mono's documented API surface; see the
// comment on the `mono` entry.

import type { ProviderCapabilities } from "./types";

export type ProviderId = "demo" | "mono" | "csv";

/**
 * Mono, verified against the current API docs.
 *
 * - realtime: `mono.events.account_updated` fires once new financial data is
 *   available on a linked account, and the Connect SDK reports realtime data
 *   when the `x-real-time` header is set. Provider-push is real.
 * - pagination: `GET /v2/accounts/{id}/transactions` returns
 *   `meta.{total,page,previous,next}` and accepts a `page` param.
 * - reauth: `mono.events.account_reauthorized` exists and Mono documents both
 *   a Reauth Link and `POST /v2/connect/reauth/session`.
 * - multipleAccounts: the widget emits ACCOUNT_SELECTED with
 *   `selectedAccountsCount`, so one consent can yield several accounts.
 * - disconnect: `POST /v2/accounts/unlink`, plus the unlink webhook.
 */
export const MONO_CAPABILITIES: ProviderCapabilities = {
  realtime: true,
  pagination: true,
  reauth: true,
  multipleAccounts: true,
  disconnect: true,
};

/**
 * The demo provider is a local fixture. It has no network, so nothing is
 * pushed and there is nothing to page through or re-authorise. Disconnect is
 * local-only (no upstream call to make).
 */
export const DEMO_CAPABILITIES: ProviderCapabilities = {
  realtime: false,
  pagination: false,
  reauth: false,
  multipleAccounts: true,
  disconnect: true,
};

/**
 * CSV import. A file export is a point-in-time snapshot, so nothing streams
 * and there is nothing to page through or re-authorise. Several statements can
 * be imported as separate accounts, so `multipleAccounts` is true.
 */
export const CSV_CAPABILITIES: ProviderCapabilities = {
  realtime: false,
  pagination: false,
  reauth: false,
  multipleAccounts: true,
  disconnect: true,
};
