// Reproduce the native client's exact request against the deployed function.
//
// The native failure was "Edge function returned a non-2xx status code". That is
// a FunctionsHttpError from supabase-js, so the function answered with a 4xx/5xx.
// This script sends the same shape the app sends and prints the full response.
//
// Usage: node scripts/csv-native-repro.cjs   (needs PASS_EMAIL/PASS_PASSWORD)

const fs = require("fs");
const path = require("path");

const env = (key) => {
  if (process.env[key]) return process.env[key];
  const local = fs.readFileSync(path.join(__dirname, "..", ".env.local"), "utf8");
  const m = local.match(new RegExp(`^${key}=(.+)$`, "m"));
  return m ? m[1].trim() : "";
};

const URL_BASE = process.env.EXPO_PUBLIC_SUPABASE_URL || env("EXPO_PUBLIC_SUPABASE_URL");
const ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || env("EXPO_PUBLIC_SUPABASE_ANON_KEY");
const EMAIL = process.env.PASS_EMAIL;
const PASSWORD = process.env.PASS_PASSWORD;

// Exactly the body app/import-csv.tsx -> src/lib/db.ts previewCsv() sends.
// Raw text, never base64.
const GOOD_CSV = [
  "Date,Narration,Debit,Credit,Balance",
  "15/10/2026,SHOPRITE IKEJA,18500.50,,1250000.00",
].join("\n");

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Base64 of a UTF-8 string, without relying on Buffer being in eslint's globals. */
function base64(input) {
  const bytes = Array.from(new TextEncoder().encode(input));
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += ALPHABET[b0 >> 2];
    out += ALPHABET[((b0 & 3) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    out += b1 === undefined ? "=" : ALPHABET[((b1 & 15) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    out += b2 === undefined ? "=" : ALPHABET[b2 & 63];
  }
  return out;
}

const CASES = [
  {
    name: "1. exactly what the app sends (raw text, preview:true)",
    fn: "csv-import",
    body: {
      fileName: "statement.csv",
      csvContent: GOOD_CSV,
      accountLabel: "Diag Account",
      preview: true,
    },
  },
  {
    name: "2. empty csvContent (what a failed content-URI read would send)",
    fn: "csv-import",
    body: { fileName: "statement.csv", csvContent: "", preview: true },
  },
  {
    name: "3. csvContent missing entirely",
    fn: "csv-import",
    body: { fileName: "statement.csv", preview: true },
  },
  {
    name: "4. base64 instead of raw text (if the native read base64-encoded)",
    fn: "csv-import",
    body: {
      fileName: "statement.csv",
      csvContent: base64(GOOD_CSV),
      preview: true,
    },
  },
  {
    name: "5. wrong function name, as a control",
    fn: "csv/import",
    body: { fileName: "statement.csv", csvContent: GOOD_CSV, preview: true },
  },
];

(async () => {
  const { createClient } = require("@supabase/supabase-js");
  const auth = createClient(URL_BASE, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await auth.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
  if (error) throw new Error(`sign-in failed: ${error.message}`);
  const token = data.session.access_token;
  console.log(`signed in as ${data.user.id.slice(0, 8)}…\n`);

  for (const c of CASES) {
    const url = `${URL_BASE}/functions/v1/${c.fn}`;
    let line = `${c.name}\n  POST ${url}`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: ANON_KEY,
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(c.body),
      });
      const text = await res.text();
      line += `\n  status: ${res.status} ${res.statusText}`;
      line += `\n  content-type: ${res.headers.get("content-type")}`;
      line += `\n  body: ${text.slice(0, 600)}`;
    } catch (e) {
      line += `\n  THREW: ${e.message}`;
    }
    console.log(line + "\n");
  }

  // What supabase-js reports for a non-2xx, since that is the message the app
  // surfaces. Confirms which layer produces "non-2xx status code".
  console.log("supabase-js invoke behaviour on the good case:");
  const { data: d2, error: e2 } = await auth.functions.invoke("csv-import", {
    body: { fileName: "statement.csv", csvContent: GOOD_CSV, preview: true },
  });
  console.log(`  error: ${e2 ? JSON.stringify({ name: e2.name, message: e2.message, status: e2.status ?? (e2.context && e2.context.status) }) : "none"}`);
  console.log(`  data: ${d2 ? JSON.stringify(d2).slice(0, 400) : "null"}`);

  await auth.auth.signOut();
})().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(2);
});
