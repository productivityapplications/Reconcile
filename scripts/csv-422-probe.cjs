// Does supabase-js populate `data` on a non-2xx response?
//
// This is the crux: previewCsv() detects "recognised nothing, send a mapping" by
// reading `data`, but the function answers that case with HTTP 422. If supabase-js
// sets data=null on any non-2xx, the client can never see the needsMapping body
// and throws the generic message instead.
//
// Usage: node scripts/csv-422-probe.cjs   (needs PASS_EMAIL/PASS_PASSWORD)

const fs = require("fs");
const path = require("path");

const env = (key) => {
  if (process.env[key]) return process.env[key];
  const local = fs.readFileSync(path.join(__dirname, "..", ".env.local"), "utf8");
  const m = local.match(new RegExp(`^${key}=(.+)$`, "m"));
  return m ? m[1].trim() : "";
};

const URL_BASE = env("EXPO_PUBLIC_SUPABASE_URL");
const ANON_KEY = env("EXPO_PUBLIC_SUPABASE_ANON_KEY");

// Unrecognised headers -> the function answers 422 with needsMapping:true.
const UNKNOWN_CSV = ["Seq No,Posted On,Txn Text,Movement", "1,08/10/2026,X,100.00"].join("\n");

(async () => {
  const { createClient } = require("@supabase/supabase-js");
  const auth = createClient(URL_BASE, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await auth.auth.signInWithPassword({
    email: process.env.PASS_EMAIL,
    password: process.env.PASS_PASSWORD,
  });
  if (error) throw new Error(`sign-in failed: ${error.message}`);
  const token = data.session.access_token;

  const res = await auth.functions.invoke("csv-import", {
    body: { fileName: "unknown.csv", csvContent: UNKNOWN_CSV, preview: true },
  });

  console.log("=== raw fetch first (ground truth) ===");
  const raw = await fetch(`${URL_BASE}/functions/v1/csv-import`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: ANON_KEY,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ fileName: "unknown.csv", csvContent: UNKNOWN_CSV, preview: true }),
  });
  console.log(`  status: ${raw.status}`);
  console.log(`  body: ${(await raw.text()).slice(0, 300)}`);

  console.log("\n=== now via supabase-js invoke, as the app does ===");
  console.log(`  error is null: ${res.error === null}`);
  console.log(`  data: ${res.data === null ? "null" : res.data === undefined ? "undefined" : JSON.stringify(res.data).slice(0, 300)}`);
  if (res.error) {
    console.log(`  error.name: ${res.error.name}`);
    console.log(`  error.message: ${res.error.message}`);
    console.log(`  error has context: ${res.error.context !== undefined}`);
    const ctx = res.error.context;
    if (ctx && typeof ctx === "object") {
      console.log(`  context keys: ${Object.keys(ctx).join(", ")}`);
      const ctxStatus = ctx.status ?? (ctx.response && ctx.response.status);
      console.log(`  context status: ${ctxStatus}`);
      // Is the parsed JSON body reachable from the error?
      const asAny = res.error;
      console.log(`  error own keys: ${Object.keys(asAny).join(", ")}`);
      if (asAny.data !== undefined) {
        console.log(`  error.data: ${JSON.stringify(asAny.data).slice(0, 300)}`);
      }
      if (ctx.json && typeof ctx.json.then === "function") {
        const parsed = await ctx.json;
        console.log(`  context.json() => ${JSON.stringify(parsed).slice(0, 300)}`);
      } else if (ctx.json !== undefined) {
        console.log(`  context.json => ${JSON.stringify(ctx.json).slice(0, 300)}`);
      }
    }
  }

  await auth.auth.signOut();
})().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(2);
});
