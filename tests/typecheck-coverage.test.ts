import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "@jest/globals";

// Gate against "tsc says green but never read the file".
//
// In Phase 12 a new module under supabase/functions/_shared/csv/ shipped with a
// broken import. `tsc --noEmit` exited 0 the whole time, because tsconfig.json
// enumerated individual _shared files by path and none of them were in the new
// directory. The deploy then failed to boot with BOOT_ERROR. The typecheck was
// green because it had never looked.
//
// A typecheck gate is only as strong as its include patterns, so this asserts
// the patterns actually cover the source tree. Adding a file under a covered
// directory now fails here rather than passing an unchecked build.

const ROOT = join(__dirname, "..");

/** Directories whose .ts/.tsx files must all be type-checked. */
const COVERED_DIRS = ["supabase/functions", "src", "app"];

/** Paths tsconfig legitimately does not type-check. */
const ALLOWED_UNCOVERED = [
  // Entry points use Deno globals (Deno.serve) and jsr: specifiers that resolve
  // only inside the Edge runtime. Their imports and pure helpers ARE checked via
  // the _shared files tsconfig includes explicitly.
  "supabase/functions/ai-ask",
  "supabase/functions/bank-connect-session",
  "supabase/functions/bank-disconnect",
  "supabase/functions/bank-exchange-code",
  "supabase/functions/bank-sync",
  "supabase/functions/csv-import",
  "supabase/functions/mono-webhook",
  // Route-local test fixtures and design/dev surfaces, checked by lint and the
  // test suite rather than by tsc.
  "app/dev",
];

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.tsx?$/.test(full)) {
      out.push(full);
    }
  }
  return out;
}

/** Every source file tsconfig must be reading. */
function allSourceFiles(): string[] {
  return COVERED_DIRS.flatMap((dir) => walk(join(ROOT, dir)));
}

/**
 * Translate one tsconfig glob into a matcher over repo-relative POSIX paths.
 *
 * Supports the forms tsconfig actually uses here: a bare directory prefix such
 * as "src", a recursive glob such as "app/<star>/<star>", and an extension glob
 * such as "supabase/functions/_shared/csv/<star>/<star>.ts". Anything more
 * exotic is treated as no match, which makes this test fail loudly rather than
 * guess.
 *
 * The stars are spelled out in the comments above because a literal star-star
 * inside a block comment closes the comment.
 */
function matcherFor(pattern: string): (file: string) => boolean {
  const p = pattern.replace(/\\/g, "/").replace(/\/+$/, "");

  // "dir/**\/*" or "dir/**" — everything under dir, any extension.
  if (p.endsWith("/**/*") || p.endsWith("/**")) {
    const prefix = p.replace(/\/\*\*(\/\*)?$/, "");
    return (file) => file === prefix || file.startsWith(`${prefix}/`);
  }

  // "dir/<star>/<star>.<ext>" — everything under dir with one of the
  // extensions. Several extensions may be listed, e.g. ".<ts>.<d.ts>".
  const extGlob = p.match(/^(.*)\/\*\*\/\*((?:\.[A-Za-z]+)+)$/);
  if (extGlob) {
    const prefix = extGlob[1];
    const suffixes = extGlob[2]
      .split(".")
      .filter(Boolean)
      .map((ext) => `.${ext}`);
    return (file) =>
      file.startsWith(`${prefix}/`) &&
      // ".ts" must not match ".d.ts", and ".d.ts" must not match ".ts", so the
      // suffix is compared against the extension tail exactly.
      suffixes.some((suffix) => file.endsWith(suffix));
  }

  // "**\/*.ts" — that extension anywhere.
  const anyExt = p.match(/^\*\*\/\*\.(ts|tsx|js|jsx)$/);
  if (anyExt) {
    const ext = anyExt[1];
    return (file) => file.endsWith(`.${ext}`);
  }

  // A bare directory: everything under it.
  if (!p.includes("*")) {
    return (file) => file === p || file.startsWith(`${p}/`);
  }

  // A specific file path.
  return (file) => file === p;
}

function tsconfigPatterns(): { include: string[]; exclude: string[] } {
  // Read through TypeScript's own JSONC parser so comments, trailing commas and
  // `//` sequences inside glob strings are handled the same way tsc handles them.
  // A regex stripper here would corrupt patterns like "dir/**\/*.ts".
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ts = require("typescript") as {
    parseConfigFileTextToJson(
      fileName: string,
      json: string,
    ): { config?: { include?: string[]; exclude?: string[] }; error?: { messageText: string } };
  };
  const parsed = ts.parseConfigFileTextToJson(
    join(ROOT, "tsconfig.json"),
    readFileSync(join(ROOT, "tsconfig.json"), "utf8"),
  );
  if (parsed.error) {
    throw new Error(`tsconfig.json is not parseable: ${parsed.error.messageText}`);
  }
  return {
    include: parsed.config?.include ?? [],
    exclude: parsed.config?.exclude ?? [],
  };
}

describe("typecheck coverage gate", () => {
  it("has include patterns to check against", () => {
    const { include } = tsconfigPatterns();
    expect(include.length).toBeGreaterThan(0);
  });

  it("type-checks every .ts and .tsx file under the covered directories", () => {
    const { include } = tsconfigPatterns();
    const includeMatchers = include.map(matcherFor);

    const files = allSourceFiles();
    // A guard on the walk itself: if this were 0 the assertions below would pass
    // vacuously, which is the same failure mode as an empty include list.
    expect(files.length).toBeGreaterThan(0);

    const uncovered = files
      .map((file) => relative(ROOT, file).split(sep).join("/"))
      .filter((file) => !includeMatchers.some((m) => m(file)))
      .filter((file) => !ALLOWED_UNCOVERED.some((allowed) => file === allowed || file.startsWith(`${allowed}/`)));

    if (uncovered.length > 0) {
      throw new Error(
        "these source files are not in tsconfig.json's include list, so `tsc --noEmit` " +
          "reports success without reading them. Add the file or its directory to include:\n" +
          uncovered.map((f) => `  - ${f}`).join("\n"),
      );
    }
    expect(uncovered).toEqual([]);
  });

  it("does not exclude any source file from the covered directories", () => {
    const { exclude } = tsconfigPatterns();
    const excludeMatchers = exclude.map(matcherFor);
    const excluded = allSourceFiles()
      .map((file) => relative(ROOT, file).split(sep).join("/"))
      .filter((file) => excludeMatchers.some((m) => m(file)));
    expect(excluded).toEqual([]);
  });

  it("covers the CSV pipeline and the shared semantics module explicitly", () => {
    // Regression guard for the Phase 12 failure: these were the files that
    // shipped unchecked. Keeping them named here makes a future removal of the
    // csv/ glob visible in the diff rather than only at deploy time.
    const { include } = tsconfigPatterns();
    const matchers = include.map(matcherFor);
    for (const file of [
      "supabase/functions/_shared/csv/parse.ts",
      "supabase/functions/_shared/csv/detect.ts",
      "supabase/functions/_shared/csv/layouts.ts",
      "supabase/functions/_shared/csv/direction.ts",
      "supabase/functions/_shared/csv/provider.ts",
      "supabase/functions/_shared/semantics.ts",
    ]) {
      expect(`${file} covered=${matchers.some((m) => m(file))}`).toBe(`${file} covered=true`);
    }
  });
});
