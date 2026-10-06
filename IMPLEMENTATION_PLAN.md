# Reconcile — Implementation Plan

**Version:** 4 — frontend-first with native verification; monetization removed,
CSV import and custom budgets added.
**Supersedes:** v1 (horizontal layers), v2 (web-only verification), v3 (which
scheduled RevenueCat monetization as Phase 12).
**Method:** one phase at a time. Implement → test → inspect → deploy (web + native) → verify as user → commit → checkpoint → STOP.

---

## 0. Plan shape

The demo is complete and frozen at tag `demo-v1`. The full build extends from it.

The full build is **frontend-first**, per `SKILL_LEAN_DELIVERY.md` §2 Stage 4:

1. Build the design system from `design.md`.
2. Rebuild every screen against it.
3. Deploy and verify visually — **on web and on a real device.**
4. Layer real backend integrations underneath.
5. Harden.
6. Package and publish.

The demo already delivered the working data layer (auth, provider abstraction,
demo provider, sync, review, budget, insights, deterministic Ask). The full
build's frontend phases replace the skeletal UI. The backend phases replace the
demo scaffolding with real providers, real AI, and richer budgeting.

**No monetization layer is planned.** RevenueCat was scheduled as Phase 12 in
v3 and is now deferred indefinitely; see the note at the end of §2.

**Verification is dual-surface.** Web (Vercel + Playwright) is fast iteration.
Native (EAS build → installed on a real Android device) is the reality check.
Both are required from Phase 7 onward. Native-specific behavior — safe areas,
keyboard handling, fonts, shadows, touch targets, haptics — cannot be verified
on web.

---

## 1. Completed phases

| Phase | Name | Status |
|---|---|---|
| 0 | Blueprint — source-of-truth docs, skills, design | ✅ Complete |
| 1 | Mobile foundation — Expo shell, tooling | ✅ Complete |
| 2 | Core demo — auth, provider, sync, review, budget, insights, ask | ✅ Complete, tag `demo-v1` |
| 3 | Design tokens | ✅ Complete |
| 4 | Wave 1–3 primitives | ✅ Complete |
| 5 | Wave 4–5: charts, motion, haptics | ✅ Complete |
| 6 | Wave 6–7: rows, states, shells, navigation | ✅ Complete |
| 7 | Wave 8 feature organisms + native build pipeline | ✅ Complete |
| 8 | Screen rebuild: onboarding, auth, Home, Review | ✅ Complete |
| 9 | Screen rebuild: Activity, Detail, Budget, Insights, Ask, Settings | ✅ Complete |
| 10 | Dual-surface audit and `SKILL_FRONTEND_DESIGN.md` v1 | ✅ Complete — 10A, 10A.5, 10B, 10B.5, and the 10B close |
| 11 | Mono integration | 🔄 Implementation complete; sandbox verified on device. Live keys pending Mono KYB |

Phase 2 was delivered in two slices, deployed to Vercel, and verified by the
operator in a browser. Browser-runtime bugs found and fixed (CORS preflight on
Edge Functions, missing `babel-preset-expo` + whole-object env reads,
per-weight font family mismatch). Learnings recorded in
`SKILL_LEAN_DELIVERY.md` §8.

Phases 3–10 are implemented, tested, deployed, and committed. Phase 11 is
implemented and sandbox-verified; it stays open because live data depends on
Mono business KYB, which has not started. Per-phase commits, defect lists,
agent-as-user pass evidence, and the exact next task are recorded in
`AI_HANDOFF.md`, whose "Current state" block is authoritative on status. This
table is a status summary, not a substitute for that file; if the two disagree,
`AI_HANDOFF.md` wins and this table is corrected.

---

## 2. Full-build phases

### FRONTEND LAYER

#### Phase 7 — Wave 8 feature organisms + native build pipeline
**Status:** Complete. Organisms shipped at `b5a7ff2`; the native build pipeline
and the first Android APK shipped at `0211c39`. Native runtime verification
followed in the Phase 7 native smoke-test pass.

**Objective:** Complete the frontend component stack with the composite feature
cards, and establish the native build pipeline (EAS) that every phase from
Phase 8 onward will be verified against.

**Deliverable (organisms — done):**
- `HeroSummaryCard` — yellow card, donut, income/expenses legend.
- `BudgetOverviewCard` — mist card, progress bar, "Today" pill.
- `ExpensesBarCard` — yellow card, 4-month bar chart, hatched highlight,
  alert-red starburst callout.
- `SpendTrendCard` — ink card, line chart with dashed projection, paper
  starburst.
- `PositiveMessageCard` — mint card, single reassurance line.
- `InsightCard` — paired numbers with delta indicator.
- `ReviewHeader` — paired title with starburst.

**Deliverable (native pipeline — this completion):**
- `eas.json` with `development`, `preview`, `production` profiles.
- `app.json` updated with `android.package`, `ios.bundleIdentifier`,
  `versionCode`, `buildNumber`, `scheme`.
- `.easignore` preventing secrets from being uploaded to EAS.
- First Android preview build (APK) produced successfully.
- APK URL delivered to the operator for installation on a real device.

**Acceptance:**
- Organisms render in the gallery and match `design.md` §8 (done).
- EAS build succeeds.
- APK downloads and installs on the operator's Android device.
- App launches without crash.
- Welcome → Demo → Home renders correctly on device.
- Safe areas, keyboard behavior, fonts, and touch targets are verified on
  device.
- Any native-only defect is fixed in-phase or explicitly logged with a plan.
- No secret is included in the EAS upload.

**Commits:** `feat: add wave 8 feature organisms (Phase 7)` (done at `b5a7ff2`),
`chore: configure eas build and produce first android apk (Phase 7)`
(this completion).

#### Phase 8 — Screen rebuild: onboarding, auth, Home, Review
**Objective:** Replace the demo's skeletal versions of these screens with the
real design system.

**Screens:** Welcome, Privacy, Country, Sign up, Sign in, Demo entry, Home,
Review Transactions.

**Acceptance:**
- Each screen uses only primitives from Phases 4–7.
- Every screen has empty, loading, error states.
- Reduced-motion fallback present.
- `PillNav` wired to Expo Router (first time); Home active on Home; hidden on
  Review Transactions.
- Every screen passes the `design.md` §15 adoption checklist.
- **Agent-as-user pass on web:** screenshots at 375×812 and 1280×800, console
  and network clean, second pass clean.
- **Native smoke test:** EAS build succeeds; APK installs on the operator's
  Android device; app launches; the phase's screens render and the primary flow
  works on device. Report findings.
- Any native-only defect (safe area, keyboard, touch target, font rendering)
  fixed in-phase or explicitly logged with a plan.

**Commit:** `feat: rebuild onboarding, auth, Home, and Review (Phase 8)`

#### Phase 9 — Screen rebuild: Activity, Detail, Budget, Insights, Ask, Settings
**Objective:** Same as Phase 8 for the remaining screens.

**Screens:** Activity, Transaction Detail, Budget Setup, Budget, Insights,
Ask Reconcile, Settings, Error/offline/not-found.

**Acceptance:** Same as Phase 8, including native smoke test.

**Commit:** `feat: rebuild Activity, Detail, Budget, Insights, Ask, and Settings (Phase 9)`

#### Phase 10 — Dual-surface agent-as-user pass + `SKILL_FRONTEND_DESIGN.md` v1
**Objective:** Complete the visual verification cycle on both surfaces and
codify what was learned.

**Deliverable:**
- Agent walks every screen on web (Playwright) and on device (via EAS preview
  build installed on the operator's Android device).
- Screenshots on both surfaces.
- Fixes what fails.
- After at least one screen completes the full cycle (`build → deploy → visual
  pass on web and native → fix → re-deploy → clean second pass`), rewrite
  `SKILL_FRONTEND_DESIGN.md` v1 per `frontend-implementation-plan.md` §16.
  The file pre-exists from the blueprint; Phase 10 **rewrites** it with what
  the browser and native passes actually taught.

**Acceptance:** Second-pass screenshots clean against `design.md` on both
surfaces. Skill v1 committed.

**Commit:** `feat: complete dual-surface visual pass and write frontend skill v1 (Phase 10)`

### BACKEND LAYER

#### Phase 11 — Mono integration
**Objective:** Replace the demo provider with the real Mono adapter behind the
same `FinancialProvider` interface.

**Status: implementation complete, sandbox verified on device.** The Connect Link
was completed, the account persisted, and sync ran without error. Live data
requires Mono business KYB, which **has not started**, so live verification is
deferred indefinitely. Mono stays behind both `EXPO_PUBLIC_FEATURE_MONO` (client)
and `FEATURE_MONO` (Edge Function secret). **This is not a blocker for the phases
below** — Phase 12 gives the product a primary data path that does not depend on
Mono at all.

**Deliverable:** Mono client in Edge Functions; `MONO_SECRET_KEY` as a server
secret; institution discovery; connection session; account persistence;
webhook with authenticity + idempotency; reauth handling.

**Acceptance:** Sandbox connection works end to end on both web and native;
secret is server-only; webhook is verified and idempotent; live test proves the
full loop against Mono sandbox.

**Commit:** `feat: add mono financial data provider (Phase 11)`

#### Phase 12 — CSV import
**Objective:** Let the user import transactions from a CSV exported from their
bank. CSV is the **primary data path** until Mono live keys become available, so
the product is usable end to end without any third-party provider.

**Deliverable:**
- Provider `csv` registered in the provider registry, so ingestion reuses the
  same pipeline as Mono and the demo provider.
- Creates synthetic `bank_connections` and `bank_accounts` rows with
  `provider_id = "csv"`.
- CSV parser auto-detecting common Nigerian bank formats by header inspection —
  at least three of GTBank, UBA, Access Bank, Zenith, First Bank, Sterling.
- Column-mapping fallback UI when headers are not recognized.
- Date parser for `dd/mm/yyyy`, `yyyy-mm-dd`, `dd-Mon-yyyy`, and common
  variants.
- Amount parser handling comma separators, currency symbols, and separate debit
  and credit columns.
- Dedupe via a deterministic hash of `(date | amount | narration)`, so
  re-importing the same CSV adds zero duplicates.
- Import preview showing rows that will be added versus rows already present.
- Import confirmation step.
- Feature flag `EXPO_PUBLIC_FEATURE_CSV_IMPORT`, default `true`.
- UI entry points: Settings → Import, and the Connect flow → Import CSV.

**Acceptance:**
- Given a GTBank CSV, transactions appear in Activity.
- Re-importing the same CSV adds zero duplicates.
- A malformed CSV shows a clear error and does not crash.
- Column mapping appears when headers are not recognized.

**Commit:** `feat: add csv import provider (Phase 12)`

#### Phase 13 — Custom budgets
**Objective:** Extend the budget model from a single monthly budget to multiple
named budgets spanning arbitrary periods and scopes.

**Deliverable:**
- Schema migration: `budgets` gains `name` (text, nullable for backward
  compatibility), `scope_type` (text: `all` | `categories`), and
  `scope_category_ids` (`uuid[]` or a link table); `period_type` expands to
  include `weekly` and `custom`.
- Unique constraint changes from `(user_id, period_type, period_start)` to
  `(user_id, name)`, with a partial unique on `(user_id)` where `name IS NULL`
  for the default budget.
- Budget engine updated to compute spend per budget using its own period and
  scope.
- Budget list screen replacing the current single-budget screen.
- Budget creation flow: name, period type (weekly / monthly / custom), date
  range, and scope picker (all categories or a selection).
- Home screen shows a designated "primary" budget with a way to switch it.
- Insights aware of multiple budgets (no crash when more than one exists).
- The existing monthly budget continues to work as the default.

**Acceptance:**
- The user creates a budget named "Business Equipment" with a 3-month custom
  range and a category scope of "Shopping".
- Transactions in that category during that range count against it.
- The existing monthly budget still works unchanged.
- Home still shows the monthly default until the user designates another.

**Commit:** `feat: add custom budgets (Phase 13)`

#### Phase 14 — Real AI (OpenAI categorization + Ask Reconcile upgrade)
**Objective:** Add server-side OpenAI for categorization fallback and upgrade
Ask Reconcile from deterministic-only to tool-driven LLM.

**Deliverable:** `ai/categorize` Edge Function with structured output
validation; `ai/ask` Edge Function with allow-listed read-only tools;
prompt-injection defense; caching of confirmed merchant patterns.

**Acceptance:** Low-confidence AI is a suggestion, never authoritative; tools
resolve user ownership server-side; no arbitrary SQL; injection tests pass.
Verified on web and native.

**Commit:** `feat: add openai categorization and tool-driven ask (Phase 14)`

#### Phase 15 — Security hardening and deletion
**Objective:** Close the security and lifecycle gaps the demo deferred.

**Deliverable:** Rate limits on sync and AI; logging redaction; a full deletion
flow (`account/delete` disconnecting provider + purging app data); security
tests (IDOR, user-ID substitution, webhook replay, prompt injection, secret
scan).

**Acceptance:** All security tests pass; no secrets in any built bundle (web or
native); deletion leaves no user data.

**Commit:** `feat: add security hardening and account deletion (Phase 15)`

### RELEASE

#### Phase 16 — E2E and store packaging
**Objective:** Final packaging and publication of the app.

**Deliverable:**
- E2E tests on the full build (web + native).
- EAS production build (Android AAB, iOS IPA if in scope) uploaded to Google
  Play (internal testing track at minimum) and App Store Connect (if in scope).
- 1024×1024 icon.
- Store screenshots.
- Published release when ready.

**Acceptance:**
- E2E critical journeys pass on web and native.
- The app is fully published on Google Play (required) and the App Store (if in
  scope).

**Commit:** `chore: ship reconcile (Phase 16)`

> **RevenueCat monetization was originally planned as Phase 12.** It is deferred
> indefinitely. The hackathon deadline passed; subscriptions are not a current
> goal. The schema and code do not assume any monetization layer.

---

## 3. Per-phase protocol

1. Inspect current repository state.
2. Read source-of-truth docs relevant to the phase.
3. Implement only the assigned phase.
4. Run targeted tests plus the project's standard checks.
5. Inspect the complete diff.
6. Deploy to web.
7. Run the agent-as-user pass on web (Playwright). Screenshots at 375×812 and
   1280×800.
8. From Phase 7 onward: deploy to native (EAS preview build), install on the
   operator's Android device, run the native smoke test.
9. Fix only verified problems on either surface.
10. Update `AI_HANDOFF.md`.
11. Commit one logical checkpoint.
12. Verify commit.
13. STOP.

---

## 4. Definition of full product complete

- Design system fully implemented per `design.md`.
- Every screen rebuilt against it.
- Agent-as-user pass completed on web and native for every screen.
- Native build (Android APK/AAB) installs and runs on a real device without
  crash.
- CSV import working end to end on web and native.
- Custom budgets working on web and native.
- Mono integration sandbox-verified on both surfaces; live verification
  deferred pending Mono KYB.
- AI categorization and Ask Reconcile working under the allow-listed tool model.
- Security hardening complete.
- Account deletion and disconnect flows work.
- E2E critical journeys pass on web and native.
- Google Play listing published. App Store listing published if iOS is in scope.

---

## 5. External dependencies

- Mono business onboarding / KYB and live credentials. **Not started**; live
  verification deferred indefinitely. Not a blocker for Phases 12–16.
- Current Mono institution coverage must be fetched dynamically.
- Supabase project and Edge Function secrets.
- OpenAI API key.
- Apple and Google developer accounts and store review.
- Final product-name availability check.
- **Expo account** (free) — required for EAS build.
- **EAS CLI** (installed locally) — required for native builds from Phase 7.
- **Google Play developer account** — $25 one-time fee. Required for Phase 16.
- **Apple Developer account** — $99/year. Required if iOS is in scope for
  Phase 16.

---

## 6. Skill relationship

- `SKILL_LEAN_DELIVERY.md` governs sequencing and deployment for every phase.
- `SKILL_FRONTEND_DESIGN.md` is earned at Phase 10, not before. The file
  pre-exists from the blueprint commit; Phase 10 rewrites it based on what the
  dual-surface pass taught.
- `frontend-implementation-plan.md` governs the frontend build order within
  Phases 3–10.
- `design.md` wins on visual conflicts.
- This file wins on phase sequencing, subject to the above.
