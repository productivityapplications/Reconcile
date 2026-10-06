# Reconcile — Project Specification

**Status:** Pre-implementation; product decisions locked for MVP
**Working name:** Reconcile
**Primary market:** Nigeria
**Global posture:** country/provider extensible

## 1. Product definition

### One-line description
Connect your banks, reconcile your transactions, and understand where your money is going.

### Problem
People with multiple bank accounts have fragmented financial information. They repeatedly open different bank apps, manually categorize transactions, and struggle to distinguish real spending from transfers between their own accounts.

### Target users
Mobile-first adults in Nigeria with one or more supported bank accounts who want low-friction budgeting. The architecture must later support additional countries.

### Roles
- **Customer:** owns their profile, linked accounts, transactions, review state, and budgets.
- **Operator/Admin:** minimal internal support role; no broad financial-data browsing UI in MVP.

### Value proposition
One financial picture across connected accounts, with a fast review workflow between raw transactions and useful budgeting.

### Differentiator
Reconcile is built around **reconciliation**, not merely aggregation: newly observed transactions enter a review queue; user corrections teach future categorization; internal transfers are handled so they do not inflate spending; the same normalized ledger powers budgets and AI explanations.

### Primary use case
User connects GTBank and UBA → syncs transactions → reviews new transactions → confirms categories → budget immediately updates.

### Secondary use cases
- Ask how much was spent at a merchant/category.
- Understand why spending changed from the prior period.
- Identify recurring charges.
- View all connected-account balances in one place.
- Import a CSV when bank connection is unavailable.

### Explicit non-goals
Reconcile does **not**:
- move money or initiate payments;
- store bank passwords, PINs, or OTPs;
- act as a bank;
- provide investment, lending, tax, credit-scoring, or regulated financial advice;
- promise instant transaction notifications when provider/account capability does not support them;
- support household/shared budgets in MVP;
- use an LLM as the source of truth for financial arithmetic.

## 2. MVP scope

### MUST HAVE
- iOS/Android mobile app.
- Supabase Auth and session lifecycle.
- Provider abstraction.
- Mono adapter for Nigeria.
- Mono sandbox integration.
- Demo Mode using clearly synthetic data.
- Bank/account connection flow.
- Transaction ingestion, normalization, pagination and deduplication.
- New transaction review queue.
- Category confirmation/change.
- Deterministic category rules + AI fallback.
- Learned merchant/category preferences.
- High-confidence internal-transfer detection.
- Monthly total and category budgets.
- Home, Activity, Budget and Insights experiences.
- Read-only Ask Reconcile.
- CSV import as the primary data path (Phase 12).
- Disconnect account and delete application data flows.
- E2E tests for core journeys.
- Store-ready icon and screenshots.

### SHOULD HAVE
- Recurring-payment detection.
- Prior-month comparisons.
- Provider reauthorization UX.
- Local notifications.
- Provider-capability messaging.
- Funnel/conversion analytics.

### NICE TO HAVE
- Custom categories.
- Data export.
- More chart types.
- OneSignal integration.
- Web dashboard.
- Receipt capture.

### FUTURE
- Plaid/Tink/other regional adapters.
- Country/provider routing.
- Household spaces.
- Cash/wallet accounts.
- Net-worth tracking.
- More advanced forecasting.
- Statement PDF parsing.
- Bill workflows.

### OUT OF SCOPE
Payment initiation, lending, brokerage, crypto, insurance, credit scores, tax filing, enterprise accounting, financial advisory.

## 3. Core business rules

### Money
Store amounts as integer minor units plus ISO currency code. Display conversion happens only at the presentation boundary.

### Transaction semantic types
`income`, `expense`, `external_transfer`, `internal_transfer`, `refund`, `unknown`.

### Categorization priority
1. User merchant rule.
2. Prior user-confirmed merchant/category pattern.
3. Deterministic rules.
4. AI suggestion.
5. Other.

Low-confidence AI output requires user confirmation.

### Internal transfers
Candidate internal transfers must belong to the same user, use two different connected accounts, have opposite directions, matching absolute amounts, and compatible dates/references. Only high-confidence matches are automatically excluded from spending/income; uncertain matches remain reviewable.

### Review state
`needs_review → reconciled | excluded`
`reconciled ↔ excluded` only through explicit user action.

Provider-sourced financial facts (amount, date, provider IDs) are immutable to the client.

### Budget
`remaining = budget_limit - net_eligible_spend`

Refunds reduce eligible spend. Internal transfers do not count as spending. External transfers are real outflows unless the user explicitly reclassifies them.

### Forecast
MVP forecast uses deterministic spend pace; do not show a projection when there is insufficient elapsed-period data.

### Monetization
None. Reconcile has no monetization layer, no paid tier, and no trial. The
product is delivered free. See `IMPLEMENTATION_PLAN.md` for the current phase
list.

## 4. Functional requirements

### Authentication
- User can sign up, sign in, sign out and restore an existing session.
- Protected data is inaccessible to unauthenticated users.
- User identity is derived from the authenticated session, never a client-supplied user ID.

### Bank connection
- User chooses country.
- Provider registry determines available provider(s).
- Provider connection session is created server-side.
- Provider UI handles institution authentication/consent.
- Provider webhook creates local connection/account state.
- Connection status supports pending, active, reauth_required, error and revoked.
- Supported institutions are discovered dynamically from the provider where possible.

### Transactions
- Initial sync handles pagination.
- Repeated syncs are idempotent.
- Transaction uniqueness is enforced at the database layer.
- Authoritative provider facts are immutable to users.
- New transactions create reviewable state.

### Reconciliation
- One tap confirms a category.
- User can change a suggestion.
- Confirmed choices can become merchant rules.
- Budget and insight queries reflect the current review/category state.

### Budget
- User can create a monthly budget.
- User can create optional category limits.
- Spending is derived from eligible transactions, not client-maintained counters.

### AI
- AI can classify and explain.
- AI cannot alter bank data, balances, or permissions.
- AI answers are grounded in deterministic read-only tool results.

## 5. Acceptance criteria

### Connection
- Demo Mode works without a bank.
- Mono sandbox can create a connection when configured.
- No Mono secret exists in the mobile bundle.
- Duplicate provider account connections are prevented.

### Transactions
- Provider transaction IDs are unique per provider/account.
- Re-running a sync never duplicates the ledger.
- Pagination is handled.
- User cannot edit amount/date/provider identity.

### Reconciliation
- User can review, confirm, change and exclude a transaction.
- Merchant rules affect subsequent classification.
- High-confidence internal transfers do not double-count spending.

### AI
- Structured outputs are schema-validated.
- Low confidence becomes a suggestion, not a silent decision.
- AI has no arbitrary SQL/database access.
- Narrations are treated as untrusted input.

### Monetization
None. There is no subscription, no paid tier, no trial, and no paywall, so
there is nothing to gate and nothing to verify. See
`IMPLEMENTATION_PLAN.md` for the current phase list.

## 6. Privacy requirements

- Never store bank passwords/PINs/OTPs.
- Provider/AI secrets are server-only.
- Financial data is sensitive.
- Transaction data is excluded from public analytics and crash logs.
- Raw provider payloads, if temporarily retained, have a short retention period and are never shown to clients.
- User can disconnect and delete application data.
- Privacy copy must not promise zero developer access unless the implementation actually provides it.

## 7. Store distribution requirements
Deferred. The previous hackathon-submission requirements — a submission-period
release, a sub-two-minute demo, judge promo access for premium testing, and
award positioning — no longer apply. Reconcile has no monetization layer, so
premium-access requirements are moot. Publishing requirements are covered by
Phase 16 of `IMPLEMENTATION_PLAN.md`.

## 8. Feature requirement matrix

### F-01 Authentication
- **Actor:** Customer
- **Preconditions:** App installed; network available for first authentication.
- **Inputs:** email/password or approved auth method.
- **Processing:** Supabase Auth validates credentials; create/restore profile.
- **Outputs:** authenticated session and user profile.
- **Permissions:** only the authenticated user's profile.
- **Validation:** provider-managed auth validation; normalized profile fields.
- **Errors:** invalid credentials, rate limit, network unavailable.
- **Edge cases:** expired session, deleted account, duplicate email.
- **Acceptance:** protected screens cannot be loaded without an authenticated session.

### F-02 Bank connection
- **Actor:** Customer
- **Preconditions:** authenticated; provider available for selected country.
- **Inputs:** country; provider; optionally selected institution.
- **Processing:** Edge Function creates provider session; provider UI handles authentication/consent; webhook creates connection/account records.
- **Outputs:** connected account(s), status and initial sync state.
- **Permissions:** user can manage only own connections.
- **Validation:** provider/country capability check; plan connection limit; no duplicate connection.
- **Errors:** unsupported institution, provider outage, consent failure, reauth required.
- **Edge cases:** user cancels; webhook delayed; provider returns partial data; bank supports multiple accounts.
- **Acceptance:** a successful provider flow produces an active local connection without exposing provider secrets to the client.

### F-03 Transaction sync
- **Actor:** System / Customer-triggered
- **Preconditions:** active connection/account.
- **Inputs:** connection/account ID and sync mode.
- **Processing:** rate-limit → fetch pages → normalize → validate → dedupe → insert/update non-authoritative metadata → create review candidates.
- **Outputs:** sync result and counts.
- **Permissions:** only the owner can trigger a manual sync for their connection; ingestion functions resolve ownership server-side.
- **Validation:** schema, provider transaction key, currency, amount bounds.
- **Errors:** timeout, provider error, malformed response, pagination failure.
- **Edge cases:** duplicate request, partial page, transaction updated by provider, reauth required during refresh.
- **Acceptance:** repeated sync never duplicates a provider transaction.

### F-04 Reconciliation
- **Actor:** Customer
- **Preconditions:** transaction exists and is visible to the owner.
- **Inputs:** category choice, include/exclude state, optional note.
- **Processing:** validate category → persist review state → update merchant rule if confirmed → refresh derived budget/insight queries.
- **Outputs:** reconciled state and updated budget.
- **Permissions:** only transaction owner.
- **Validation:** category must exist and be allowed.
- **Errors:** transaction missing, concurrent update, invalid category.
- **Edge cases:** transaction already reconciled, user changes mind, refunded transaction.
- **Acceptance:** one user action changes review state and subsequent budget views reflect it.

### F-05 Internal-transfer detection
- **Actor:** System
- **Preconditions:** at least two connected accounts belonging to the same user.
- **Inputs:** transaction pairs.
- **Processing:** compare opposite direction, amount, date window and reference/narration similarity; assign confidence.
- **Outputs:** internal-transfer candidate/match.
- **Permissions:** server-only; never based on client-provided user IDs.
- **Validation:** candidate transactions must belong to same user.
- **Errors:** none should corrupt ledger; failed matching leaves transactions unchanged.
- **Edge cases:** delayed bank dates, amount mismatch, multiple candidates.
- **Acceptance:** only high-confidence matches are excluded automatically; ambiguous matches remain reviewable.

### F-06 Budget
- **Actor:** Customer
- **Preconditions:** authenticated.
- **Inputs:** monthly total and optional category caps.
- **Processing:** create period; derive spend from eligible transactions.
- **Outputs:** spent, remaining, percentage and deterministic forecast.
- **Permissions:** only owner.
- **Validation:** non-negative limits; category caps cannot be negative.
- **Errors:** malformed period or duplicate budget period.
- **Edge cases:** no spend, refund, internal transfer, budget lower than current spend.
- **Acceptance:** calculations match independently computed fixtures.

### F-07 AI categorization
- **Actor:** System/Customer
- **Preconditions:** transaction exists; AI service available or deterministic fallback can run.
- **Inputs:** normalized merchant/narration, amount, direction, prior user rule context.
- **Processing:** user rule → deterministic rules → model fallback; validate structured output.
- **Outputs:** category suggestion, confidence, reason.
- **Permissions:** current user's transaction only.
- **Validation:** schema, allowed category IDs, confidence range.
- **Errors:** timeout, invalid output, provider quota.
- **Edge cases:** prompt injection text, no merchant name, ambiguous transfer.
- **Acceptance:** invalid or low-confidence model output does not silently change the user's category.

### F-08 Ask Reconcile
- **Actor:** Customer
- **Preconditions:** authenticated; AI feature available.
- **Inputs:** natural-language question.
- **Processing:** classify allowed intent → execute read-only deterministic tool(s) → validate result → generate explanation.
- **Outputs:** answer plus basis/context.
- **Permissions:** tools enforce current user scope.
- **Validation:** length/rate limits; question must map to supported finance intents.
- **Errors:** unsupported question, service failure, no data.
- **Edge cases:** prompt injection, question requiring unavailable data, zero matching transactions.
- **Acceptance:** answer is grounded in returned data; no arbitrary SQL/tool execution.

### F-09 Monetization
Not applicable. Reconcile has no monetization layer — no subscription, paid
tier, trial, or paywall — so there is no purchase flow to specify. If
monetization is revived it will be added here deliberately. See
`IMPLEMENTATION_PLAN.md` for the current phase list.

### F-10 Data deletion
- **Actor:** Customer
- **Preconditions:** authenticated; confirmation step completed.
- **Inputs:** explicit deletion confirmation and reauthentication where required.
- **Processing:** disable sign-in → provider disconnect attempt → delete/anonymize app-owned records → revoke local session.
- **Outputs:** signed-out state and deletion confirmation.
- **Permissions:** current user only.
- **Validation:** confirmation token/state.
- **Errors:** provider disconnect unavailable, partial deletion.
- **Edge cases:** sync in progress, pending webhook.
- **Acceptance:** customer cannot access deleted application data after completion.

## 9. Screen-by-screen UI contract

| Screen | Purpose | Required data | Primary actions | Empty/loading/error |
|---|---|---|---|---|
| Welcome | Explain product | static | Get started | n/a |
| Privacy | Build trust | static + policy version | Continue | n/a |
| Country | Route to provider set | country list | Select | loading providers |
| Auth | Account lifecycle | auth state | Sign up/sign in | auth errors |
| Home | Answer "how am I doing?" | balances, spend, budget, review count | Review, Ask, Connect | skeleton / first-month state |
| Connect Bank | Start aggregation | provider/institutions | Connect | unsupported/error |
| Accounts | Manage linked accounts | accounts/connections | Connect/disconnect/refresh | no accounts |
| Review | Reconcile pending transactions | pending transactions + suggestions | Confirm/change/exclude | no pending transactions |
| Transaction Detail | Inspect one transaction | immutable transaction + review | Categorize/note | loading/error |
| Activity | Browse ledger | transactions/reviews | filters | no transactions |
| Budget Setup | Create budget | previous spend optional | Save | validation |
| Budget | Track plan | budget + derived spend | Edit/Ask | no budget |
| Insights | Explain changes | derived metrics | Ask | insufficient data |
| Ask | Conversational analysis | session + tool results | Send | no history/error |
| Settings | Manage app | profile/connections | Privacy/Accounts/Logout | n/a |
| Privacy Controls | Manage data | connections + policy | Disconnect/Delete | operation errors |

### Responsive behavior
The design is mobile-first. Tablet widths may expand card layouts but must retain hierarchy and one-handed interactions where possible. There is no desktop-specific UI in MVP.

## 10. Analytics contract

Product analytics must be privacy-safe.

Event names:
- `onboarding_started`
- `demo_entered`
- `bank_connect_started`
- `bank_connect_completed`
- `initial_sync_completed`
- `transaction_reviewed`
- `category_changed`
- `budget_created`
- `insight_viewed`
- `ai_question_asked`

Allowed event properties:
- app version;
- country code;
- provider ID;
- screen name;
- anonymous feature counts.

Never send amounts, balances, full narrations, account numbers, provider credentials or raw transaction IDs to public analytics.

## 11. Monetization UX contract
Deferred. Reconcile does not currently have a monetization layer, so there is
no paywall, no upgrade moment, and no conversion surface to specify. If
monetization is revived it will be added here deliberately. See
`IMPLEMENTATION_PLAN.md` for the current phase list.

## 12. Data retention policy

Default product policy:
- authoritative normalized transactions retained while the user keeps the account, subject to published privacy policy;
- raw provider webhook bodies, if temporarily needed operationally, purge within 7 days;
- AI chat history purge within 30 days unless product policy changes;
- deleted-account application data removed/anonymized in the deletion job;
- provider-side retention follows provider terms and the user's consent/disconnection mechanism.

Any legally required retention that differs from this must be addressed by the operator before production.
