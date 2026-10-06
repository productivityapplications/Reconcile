# Reconcile — Architecture

## 1. System shape

```text
Expo Mobile App
 React Native + TypeScript
        │
        ├── Supabase Auth
        ├── Supabase client + RLS
        └── Edge Function calls
                  │
        ┌─────────┼─────────┐
        ▼         ▼         ▼
      Mono     OpenAI   provider webhooks
        │
        ▼
   Supabase Edge Functions
        │
        ▼
   Postgres + RLS
```

## 2. Technology choices

### Frontend
**Expo + React Native + TypeScript + Expo Router**. Chosen for a mobile-first product and single codebase for iOS/Android.

### UI
React Native `StyleSheet` + a small design-token system. Avoid a heavy UI framework so the supplied visual reference can be reproduced precisely.

### Motion
`react-native-reanimated` + Expo Haptics.

### Charts
`react-native-svg` with custom lightweight chart primitives.

### Backend
**Supabase Auth + Postgres + Row Level Security + Edge Functions**. This keeps authentication, relational data, authorization and privileged server code in one managed system.

### Financial provider
**Mono first**, hidden behind a provider interface.

### AI
**OpenAI API**, called only from server-side Edge Functions. Exact model ID is an implementation detail chosen from the current supported low-cost structured-output models.

### Payments
None. Reconcile does not move money, take payments, or sell subscriptions. See
§10.

### Build/deployment
**EAS Build/Submit** to Apple App Store/Google Play.

## 3. Provider abstraction

The product must not couple business logic to Mono.

```ts
interface FinancialProvider {
  id: string;
  capabilities: ProviderCapabilities;
  getInstitutions(input: GetInstitutionsInput): Promise<Institution[]>;
  createConnectionSession(input: CreateConnectionInput): Promise<ConnectionSession>;
  refreshAccount(input: RefreshAccountInput): Promise<RefreshResult>;
  listAccounts(input: ListAccountsInput): Promise<ProviderAccount[]>;
  listTransactions(input: ListTransactionsInput): Promise<ProviderTransactionPage>;
  disconnect(input: DisconnectInput): Promise<void>;
}
```

Provider registry is selected by country + capability + current availability.

Example:
```text
NG → Mono
US → Future US provider
GB → Future UK/EU provider
...
```

## 4. Mono

Use Mono Connect financial-data capabilities only.

Required:
- institution discovery;
- connection/linking;
- account details;
- transaction retrieval;
- webhook processing;
- reauthorization handling.

Do not use DirectPay, Direct Debit or Disburse.

Mono's current docs state sandbox requests are free. Current PAYG documentation lists successful authorization at ₦80, transactions at ₦150 per returned page, and data sync at ₦100. Mono also publishes subscription tiers; these values are operational inputs and must not be hard-coded.

## 5. Sync design

```text
Manual / initial / provider signal
          ↓
     Edge Function
          ↓
 idempotency check
          ↓
 provider fetch + pagination
          ↓
 normalize + validate
          ↓
 dedupe against unique key
          ↓
 persist immutable ledger
          ↓
 create/update review state
```

MVP correctness baseline is initial/manual refresh. Provider real-time/background refresh is optional and never promised when unsupported.

## 6. Data model

### users
`id`, `email`, `display_name`, `country_code`, `default_currency`, `created_at`, `updated_at`, `deleted_at`.

### bank_connections
`id`, `user_id`, `provider_id`, `provider_customer_id`, `provider_connection_id`, `status`, `consented_at`, `consent_expires_at`, `last_sync_at`, timestamps.

Unique: `(provider_id, provider_connection_id)`.

### bank_accounts
`id`, `user_id`, `bank_connection_id`, `provider_account_id`, `institution_id`, `institution_name`, `display_name`, `masked_account_number`, `currency`, `current_balance_minor`, `available_balance_minor`, `status`, timestamps.

Unique: `(provider_id, provider_account_id)`.

### transactions
Immutable authoritative ledger:
`id`, `user_id`, `bank_account_id`, `provider_id`, `provider_transaction_id`, `amount_minor`, `currency`, `direction`, `semantic_type`, `occurred_at`, `merchant_name`, `narration`, `normalized_merchant`, `budget_eligible`, timestamps.

Unique: `(provider_id, bank_account_id, provider_transaction_id)`.

### transaction_reviews
`id`, `transaction_id` unique, `user_id`, `status`, `category_id`, `user_note`, `confirmed_at`, `source`, timestamps.

### categories
Seed canonical categories: Food, Transport, Bills, Shopping, Entertainment, Health, Personal, Education, Family, External Transfer, Income, Internal Transfer, Other.

### merchant_rules
`id`, `user_id`, `merchant_key`, `category_id`, `created_from`, `confidence`, timestamps.

Unique: `(user_id, merchant_key)`.

### budgets
`id`, `user_id`, `period_type`, `period_start`, `period_end`, `total_limit_minor`, `currency`, timestamps.

Unique: `(user_id, period_type, period_start)`.

### budget_categories
`id`, `budget_id`, `category_id`, `limit_minor`, timestamps.

### sync_runs
`id`, `user_id`, `bank_connection_id`, `mode`, `status`, timestamps, `transactions_seen`, `transactions_added`, `error_code`.

### provider_events
`id`, `provider_id`, `provider_event_id`, `event_type`, `received_at`, `processed_at`, `status`, `payload_hash`, `error_code`.

Unique by provider/event ID. Raw payload retention is short-lived only when operationally necessary.

### ai_sessions / ai_messages
User-scoped conversational state. Apply a short retention policy.

### audit_events
`id`, `user_id`, `actor_type`, `action`, `resource_type`, `resource_id`, sanitized metadata, `created_at`.

## 7. RLS and access

Every customer-owned row is protected by `user_id = auth.uid()`.

Client may read own:
- accounts;
- transactions;
- budgets;
- insights;
- review state.

Client does not write authoritative transaction facts.

Provider ingestion, AI execution, provider webhooks and deletion orchestration are server operations.

## 8. API surface

### `POST /functions/v1/bank/connect-session`
Create a provider session for the authenticated user.

### `POST /functions/v1/bank/sync`
Start a manual/initial sync. Must enforce ownership, rate limits and idempotency.

### `POST /functions/v1/bank/disconnect`
Disconnect the selected user's provider connection.

### `POST /functions/v1/ai/categorize`
Return schema-validated category suggestion for one transaction.

### `POST /functions/v1/ai/ask`
Run a read-only financial Q&A through deterministic tools.

### `POST /functions/v1/mono/webhook`
Process Mono events; verify authenticity and idempotency.

### `POST /functions/v1/account/delete`
Orchestrate provider disconnect and application-data deletion.

### `POST /functions/v1/csv/import`
Fallback import with file size/type validation, preview, parse validation and idempotency.

Error envelope:
```json
{"error":{"code":"SYNC_PROVIDER_UNAVAILABLE","message":"We couldn't refresh this bank right now.","retryable":true,"requestId":"opaque-id"}}
```

## 9. AI architecture

AI has no direct database access. Allowed deterministic read-only tools:
- `get_spend_summary`
- `get_category_spend`
- `get_merchant_spend`
- `compare_periods`
- `get_budget_status`
- `get_recurring_candidates`
- `search_transactions`

Financial calculations happen in application/database logic. AI converts validated results into human language.

Transaction narrations are untrusted text and are explicitly delimited in prompts to mitigate prompt injection.

## 10. Payment architecture
Deferred. Reconcile does not currently have a monetization layer. See
`IMPLEMENTATION_PLAN.md` for the current phase list.

## 11. Privacy/security architecture

- no bank credentials;
- server-only provider/AI secrets;
- RLS for user isolation;
- immutable transaction facts;
- separate review state;
- idempotent webhooks/sync;
- rate limits;
- no financial data in analytics/crash reporting;
- short-lived raw payloads;
- explicit data deletion;
- accurate privacy statements.

Open-source status is not treated as a zero-knowledge guarantee.

## 12. Deployment

Development: Expo + Supabase local + Mono sandbox.

Staging: separate Supabase project/environment and Mono sandbox.

Production: EAS + production Supabase + Mono live.

## 13. Design architecture

Use the attached visual reference as direction, not as a literal clone:
- dominant black/white contrast;
- signal yellow for primary actions and hero data;
- rounded 20–28px cards;
- large numeric typography;
- floating pill navigation;
- simple outline icons;
- coral as a secondary surface;
- mint/lavender as data accents;
- sparse starburst/burst decorations.

Palette:
- Ink `#070707`
- Paper `#F6F6F1`
- Signal Yellow `#F2F50A`
- Soft Coral `#FFB0A8`
- Mint `#79DE72`
- Lavender `#A49BFF`
- Line `#DADAD2`

Motion: 180–500ms, purposeful, haptic on key confirmations, reduced-motion support.

## 14. Explicit non-decisions the agent may make

Agent may choose exact component filenames, local hook names, fixture organization, exact compatible patch versions, current low-cost OpenAI model ID and EAS profile names.

Agent may not change product scope, security boundaries, data ownership, provider abstraction, or monetization architecture.
