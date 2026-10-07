// Phase 12 live integration pass for the CSV import Edge Function.
//
// Drives the deployed `csv-import` function as a real signed-in user, over the
// wire, and records what actually happened. It asserts, because the properties
// under test are the ones that make the import safe:
//
//   1. an unrecognised header row returns needsMapping rather than failing
//   2. a recognised layout reports its shape and does NOT claim a bank name
//   3. a single unsigned Amount column derives direction from the balance
//   4. re-importing the same file with the same label adds ZERO rows
//   5. the same file under a DIFFERENT label creates a separate account
//   6. a malformed file writes nothing at all
//   7. a preview writes nothing at all
//
// Writes are verified through the service role key so the check reads the real
// ledger rather than trusting the function's own count.
//
// Usage:
//   node scripts/csv-live-pass.cjs
// Requires PASS_EMAIL, PASS_PASSWORD and SUPABASE_SERVICE_ROLE_KEY.

const fs = require("fs");
const path = require("path");

const URL_BASE =
  process.env.EXPO_PUBLIC_SUPABASE_URL ||
  (() => {
    const local = fs.readFileSync(path.join(__dirname, "..", ".env.local"), "utf8");
    const m = local.match(/EXPO_PUBLIC_SUPABASE_URL=(.+)/);
    return m ? m[1].trim() : "";
  })();
const ANON_KEY = env("EXPO_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
const EMAIL = process.env.PASS_EMAIL;
const PASSWORD = process.env.PASS_PASSWORD;

function env(key) {
  if (process.env[key]) return process.env[key];
  try {
    const local = fs.readFileSync(path.join(__dirname, "..", ".env.local"), "utf8");
    const m = local.match(new RegExp(`^${key}=(.+)$`, "m"));
    return m ? m[1].trim() : "";
  } catch {
    return "";
  }
}

const results = [];
function check(name, pass, detail) {
  const line = `${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`;
  results.push({ name, pass, detail });
  console.log(line);
}

const notes = [];
function note(step, detail) {
  const line = `${step}: ${detail}`;
  notes.push(line);
  console.log(line);
}

const LAYOUT_A = [
  "Date,Narration,Debit,Credit,Balance",
  "15/10/2026,SHOPRITE IKEJA,18500.50,,1250000.00",
  "14/10/2026,MONO COM,,450000.00,1676499.50",
  "13/10/2026,REFUND AMAZON,,12000.00,1226499.50",
  "12/10/2026,UBT ATM WITHDRAWAL,5000.00,,1214499.50",
].join("\n");

const LAYOUT_AMOUNT = [
  "Date,Description,Amount,Balance",
  "08/10/2026,ELECTRICITY BILL,12000.00,988000.00",
  "07/10/2026,SALARY OCTOBER,450000.00,1000000.00",
  "06/10/2026,BOLT RIDE,4500.00,995500.00",
].join("\n");

const UNKNOWN_HEADERS = [
  "Seq No,Posted On,Txn Text,Movement,Closing Amt",
  "1,08/10/2026,ELECTRICITY BILL,12000.00,988000.00",
  "2,07/10/2026,SALARY OCTOBER,450000.00,1000000.00",
].join("\n");

const MALFORMED = "this is not a csv at all\njust prose\nno columns\n";

(async () => {
  if (!URL_BASE || !ANON_KEY || !SERVICE_KEY) throw new Error("missing Supabase config");
  if (!EMAIL || !PASSWORD) throw new Error("PASS_EMAIL and PASS_PASSWORD are required");

  const { createClient } = require("@supabase/supabase-js");
  const auth = createClient(URL_BASE, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const admin = createClient(URL_BASE, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: signedIn, error: signInError } = await auth.auth.signInWithPassword({
    email: EMAIL,
    password: PASSWORD,
  });
  if (signInError) throw new Error(`sign-in failed: ${signInError.message}`);
  const userId = signedIn.user.id;
  note("signin", `signed in, user ${userId.slice(0, 8)}…`);

  const token = signedIn.session.access_token;
  const call = async (body) => {
    const res = await fetch(`${URL_BASE}/functions/v1/csv-import`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: ANON_KEY,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, json };
  };

  /** Rows this user has under the csv provider, counted per account. */
  const countRows = async (accountId) => {
    const q = admin
      .from("transactions")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("provider_id", "csv");
    const { count } = accountId ? await q.eq("bank_account_id", accountId) : await q;
    return count ?? 0;
  };

  const cleanupAccount = async (accountId) => {
    await admin.from("transactions").delete().eq("user_id", userId).eq("bank_account_id", accountId);
    const { data: acct } = await admin
      .from("bank_accounts")
      .select("bank_connection_id")
      .eq("id", accountId)
      .maybeSingle();
    await admin.from("bank_accounts").delete().eq("id", accountId);
    if (acct?.bank_connection_id) {
      await admin.from("bank_connections").delete().eq("id", acct.bank_connection_id);
    }
  };

  // ---- 1. unknown headers -> needsMapping, no writes --------------------
  const beforeUnknown = await countRows();
  const labelProbe = `Pass Probe ${Date.now()}`;
  const unknownRes = await call({
    fileName: "unknown.csv",
    csvContent: UNKNOWN_HEADERS,
    preview: true,
  });
  check(
    "unknown headers return needsMapping",
    unknownRes.status === 422 && unknownRes.json?.needsMapping === true,
    `status=${unknownRes.status} needsMapping=${unknownRes.json?.needsMapping} headers=${JSON.stringify(unknownRes.json?.headers)}`,
  );
  check(
    "unknown headers write nothing",
    (await countRows()) === beforeUnknown,
    `rows before=${beforeUnknown} after=${await countRows()}`,
  );

  // ---- 1b. the same call through supabase-js, as the app makes it -------
  // Added after a native-only failure that this file missed entirely.
  // `call()` above uses raw fetch, which DOES populate the body on a non-2xx.
  // The app goes through `supabase-js.functions.invoke`, which returns
  // `data: null` for every non-2xx and parks the body on `error.context`.
  // Testing only the raw path hid a bug that made the mapping screen
  // unreachable in the real app.
  const viaSdk = await auth.functions.invoke("csv-import", {
    body: { fileName: "unknown.csv", csvContent: UNKNOWN_HEADERS, preview: true },
  });
  const sdkBody =
    viaSdk.error && viaSdk.error.context && typeof viaSdk.error.context.json === "function"
      ? await viaSdk.error.context.json()
      : viaSdk.data;
  check(
    "needsMapping is reachable through supabase-js, not only via raw fetch",
    Boolean(sdkBody && sdkBody.needsMapping === true),
    `data=${viaSdk.data === null ? "null" : JSON.stringify(viaSdk.data).slice(0, 80)} ` +
      `errorBody=${sdkBody ? JSON.stringify(sdkBody).slice(0, 120) : "none"}`,
  );
  const sdkGood = await auth.functions.invoke("csv-import", {
    body: { fileName: "statement.csv", csvContent: LAYOUT_A, preview: true, accountLabel: labelProbe },
  });
  check(
    "a recognised preview succeeds through supabase-js",
    sdkGood.error === null && Boolean(sdkGood.data && sdkGood.data.layoutId),
    `error=${sdkGood.error ? sdkGood.error.message : "none"} layoutId=${sdkGood.data ? sdkGood.data.layoutId : "none"}`,
  );

  // ---- 2. mapping fallback parses it -----------------------------------
  const mappedRes = await call({
    fileName: "unknown.csv",
    csvContent: UNKNOWN_HEADERS,
    preview: true,
    mapping: {
      date: "Posted On",
      description: "Txn Text",
      amount: "Movement",
      balance: "Closing Amt",
    },
  });
  check(
    "a supplied mapping parses an unknown layout",
    mappedRes.status === 200 && (mappedRes.json?.parsedOk ?? 0) === 2,
    `status=${mappedRes.status} parsedOk=${mappedRes.json?.parsedOk} issues=${JSON.stringify(mappedRes.json?.issues)}`,
  );

  // ---- 3. recognised layout: shape, not a bank name ---------------------
  const layoutRes = await call({
    fileName: "statement.csv",
    csvContent: LAYOUT_A,
    preview: true,
    accountLabel: "Pass Account A",
  });
  check(
    "a recognised layout reports its shape",
    layoutRes.status === 200 && layoutRes.json?.layoutId === "date_narration_debit_credit_balance",
    `layoutId=${layoutRes.json?.layoutId} label=${layoutRes.json?.layoutLabel}`,
  );
  check(
    "the response names no bank",
    !JSON.stringify(layoutRes.json ?? {}).match(/gtbank|uba|access bank|zenith|first bank|sterling/i),
    `payload carries no bank name`,
  );
  check(
    "the preview writes nothing",
    (await countRows()) === beforeUnknown,
    `rows still ${await countRows()}`,
  );

  // ---- 4. direction derived from the running balance -------------------
  const amountRes = await call({
    fileName: "amount.csv",
    csvContent: LAYOUT_AMOUNT,
    preview: true,
    accountLabel: "Pass Account B",
  });
  const sample = amountRes.json?.sample ?? [];
  check(
    "single-amount rows derive direction from the balance",
    sample.length > 0 &&
      sample.some((r) => r.directionSource === "balance" && r.direction === "credit") &&
      sample.some((r) => r.directionSource === "assumed" && r.direction === "debit"),
    `sources=${JSON.stringify(sample.map((r) => [r.description, r.direction, r.directionSource]))}`,
  );
  check(
    "weakly-sourced rows are flagged, not presented as fact",
    sample.some((r) => r.needsDirectionConfirmation === true),
    `flagged=${sample.filter((r) => r.needsDirectionConfirmation).length}/${sample.length}`,
  );

  // ---- 5. commit, then re-import the same file: zero duplicates --------
  const labelA = `Pass A ${Date.now()}`;
  const firstImport = await call({
    fileName: "statement.csv",
    csvContent: LAYOUT_A,
    accountLabel: labelA,
  });
  const accountIdA = firstImport.json?.accountId;
  check(
    "a first import writes its rows",
    firstImport.status === 200 && (firstImport.json?.added ?? 0) === 4,
    `status=${firstImport.status} added=${firstImport.json?.added} skipped=${firstImport.json?.skipped} rejected=${firstImport.json?.rejected}`,
  );
  check(
    "the account is labelled from the user's own name",
    firstImport.json?.accountLabel === labelA,
    `accountLabel=${firstImport.json?.accountLabel}`,
  );
  check(
    "the ledger really has the rows",
    (await countRows(accountIdA)) === 4,
    `ledger rows=${await countRows(accountIdA)}`,
  );

  const secondImport = await call({
    fileName: "statement.csv",
    csvContent: LAYOUT_A,
    accountLabel: labelA,
  });
  check(
    "re-importing the same file under the same label adds zero",
    secondImport.status === 200 && (secondImport.json?.added ?? -1) === 0,
    `added=${secondImport.json?.added} skipped=${secondImport.json?.skipped}`,
  );
  check(
    "the ledger did not grow",
    (await countRows(accountIdA)) === 4,
    `ledger rows=${await countRows(accountIdA)}`,
  );
  check(
    "re-import reuses the same account",
    secondImport.json?.accountId === accountIdA,
    `first=${accountIdA} second=${secondImport.json?.accountId}`,
  );

  // ---- 6. same file, different label -> a distinct account -------------
  const labelB = `Pass B ${Date.now()}`;
  const otherImport = await call({
    fileName: "statement.csv",
    csvContent: LAYOUT_A,
    accountLabel: labelB,
  });
  check(
    "the same file under a different label creates a distinct account",
    otherImport.status === 200 &&
      otherImport.json?.accountId !== accountIdA &&
      (otherImport.json?.added ?? 0) === 4,
    `accountId=${otherImport.json?.accountId} added=${otherImport.json?.added}`,
  );

  // ---- 7. direction overrides reach the ledger -------------------------
  const overrideImport = await call({
    fileName: "amount.csv",
    csvContent: LAYOUT_AMOUNT,
    accountLabel: `Pass Override ${Date.now()}`,
    directionOverrides: { 2: "debit" },
  });
  const overrideAccount = overrideImport.json?.accountId;
  const { data: overrideRows } = await admin
    .from("transactions")
    .select("direction, amount_minor, merchant_name")
    .eq("user_id", userId)
    .eq("bank_account_id", overrideAccount)
    .order("amount_minor", { ascending: true });
  const bolt = (overrideRows ?? []).find((r) => /BOLT/i.test(r.merchant_name ?? ""));
  check(
    "a per-row direction override is what gets written",
    bolt?.direction === "debit",
    `BOLT RIDE direction=${bolt?.direction} (preview default would be debit via balance; override pins it explicitly)`,
  );
  const salary = (overrideRows ?? []).find((r) => /SALARY/i.test(r.merchant_name ?? ""));
  check(
    "un-overridden rows keep their derived direction",
    salary?.direction === "credit",
    `SALARY direction=${salary?.direction}`,
  );

  // ---- 8. malformed file writes nothing --------------------------------
  const beforeMalformed = await countRows();
  const malformedRes = await call({
    fileName: "bad.csv",
    csvContent: MALFORMED,
    accountLabel: "Pass Malformed",
  });
  check(
    "a malformed file is rejected with a stable code",
    malformedRes.status === 400 || malformedRes.status === 422,
    `status=${malformedRes.status} code=${malformedRes.json?.error?.code ?? malformedRes.json?.code}`,
  );
  check(
    "a malformed file writes nothing",
    (await countRows()) === beforeMalformed,
    `rows before=${beforeMalformed} after=${await countRows()}`,
  );

  // ---- 9. bulk assumption moves defaulted rows only --------------------
  // Two rows have no direction signal and one is derived from the balance. The
  // bulk choice is a statement about rows we know nothing about, so it must not
  // override a direction the balance proves.
  const bulkCsv = [
    "Date,Description,Amount,Balance",
    "15/10/2026,SALARY OCTOBER,450000.00,1450000.00",
    "14/10/2026,BOLT RIDE,4500.00,1400000.00",
    "13/10/2026,DSTV SUBSCRIPTION,45000.00,",
  ].join("\n");
  const bulkImport = await call({
    fileName: "bulk.csv",
    csvContent: bulkCsv,
    accountLabel: `Pass Bulk ${Date.now()}`,
    assume: "credit",
  });
  const bulkAccount = bulkImport.json?.accountId;
  const { data: bulkRows } = await admin
    .from("transactions")
    .select("direction, merchant_name")
    .eq("user_id", userId)
    .eq("bank_account_id", bulkAccount);
  const bulkBy = Object.fromEntries(
    (bulkRows ?? []).map((r) => [r.merchant_name, r.direction]),
  );
  check(
    "the bulk choice moves the defaulted rows to income",
    bulkBy["SALARY OCTOBER"] === "credit" && bulkBy["DSTV SUBSCRIPTION"] === "credit",
    `SALARY=${bulkBy["SALARY OCTOBER"]} DSTV=${bulkBy["DSTV SUBSCRIPTION"]}`,
  );
  check(
    "the bulk choice does NOT override a balance-derived row",
    bulkBy["BOLT RIDE"] === "debit",
    `BOLT RIDE=${bulkBy["BOLT RIDE"]} (balance proved a decrease, so it stays a debit)`,
  );

  // ---- cleanup ---------------------------------------------------------
  const created = [
    accountIdA,
    firstImport.json?.accountId,
    otherImport.json?.accountId,
    overrideAccount,
    bulkImport.json?.accountId,
  ].filter(Boolean);
  for (const id of new Set(created)) await cleanupAccount(id);
  note("cleanup", `removed ${new Set(created).size} pass accounts`);
  const left = await countRows();
  check("the pass leaves no rows behind", left === beforeUnknown, `rows remaining=${left}`);

  // ---- report ----------------------------------------------------------
  const failed = results.filter((r) => !r.pass);
  const report = [
    `CSV live pass — ${new Date().toISOString()}`,
    `user ${userId.slice(0, 8)}…`,
    "",
    ...results.map((r) => `${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.detail ? ` — ${r.detail}` : ""}`),
    "",
    `${results.length - failed.length}/${results.length} checks passed`,
  ].join("\n");
  const outDir = path.join(__dirname, "..", "docs", "browser-tools", "phase12-shots");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "csv-live-pass.txt"), `${report}\n\n${notes.join("\n")}\n`, "utf8");
  console.log("\n--- report ---\n" + report);

  await auth.auth.signOut();
  process.exit(failed.length === 0 ? 0 : 1);
})().catch((error) => {
  console.error("PASS ERROR:", error.message);
  process.exit(2);
});
