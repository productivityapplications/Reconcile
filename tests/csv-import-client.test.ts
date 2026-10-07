import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { importCsv, previewCsv } from "../src/lib/db";

/** The shape of a supabase-js functions.invoke call, as this client makes it. */
type InvokeArgs = [string, { body?: Record<string, unknown> }];
type InvokeResult = { data: unknown; error: unknown };

const mockInvoke = jest.fn<(...args: InvokeArgs) => Promise<InvokeResult>>();

jest.mock("../src/lib/supabase", () => ({
  getSupabase: () => ({
    functions: { invoke: mockInvoke },
  }),
}));

// Regression test for the native CSV import failure.
//
// SYMPTOM
// Tapping Import on the Phase 12 APK showed "Edge function returned a non-2xx
// status code". The function was reached and answered correctly.
//
// ROOT CAUSE
// `csv-import` answers an unrecognised header row with HTTP 422 and a
// `{ needsMapping: true }` body, so the UI can offer the column-mapping screen.
// `supabase-js.functions.invoke` returns `data: null` for EVERY non-2xx and
// parks the response body on `error.context`. The client was checking `data`,
// so `isNeedsMapping` was never true: the mapping branch was unreachable and
// every unrecognised file surfaced as a generic failure.
//
// The live pass missed this because scripts/csv-live-pass.cjs calls `fetch`
// directly, which does populate the body on a non-2xx. The bug was in the one
// layer the live pass did not exercise — the client's own invoke wrapper.
//
// WHAT THIS PINS
// The body must be read from `error.context`, and the server's own stable error
// message must reach the user instead of supabase-js's generic one.


/**
 * The shape supabase-js actually produces for a non-2xx: `data` is null and the
 * body is only reachable by calling `error.context.json()`.
 */
function httpError(status: number, body: unknown) {
  const context = { status, json: async () => body };
  return {
    name: "FunctionsHttpError",
    message: "Edge Function returned a non-2xx status code",
    context,
  };
}

const GOOD_INPUT = { fileName: "statement.csv", csvContent: "Date,Narration\n" };

beforeEach(() => {
  mockInvoke.mockReset();
});

describe("previewCsv error handling", () => {
  it("reads the needsMapping body from error.context, not data", async () => {
    // Exactly what the deployed function returns for unrecognised headers.
    const body = {
      ok: false,
      needsMapping: true,
      layoutId: "unknown",
      headers: ["Seq No", "Posted On", "Txn Text", "Movement"],
      totalRows: 1,
      missingRequired: ["date", "description"],
      message: "We could not recognise these columns. Please map them for us.",
    };
    // Note `data: null`, which is what supabase-js gives on any non-2xx.
    mockInvoke.mockResolvedValue({ data: null, error: httpError(422, body) });

    const result = await previewCsv(GOOD_INPUT);

    expect(result.needsMapping).toBe(true);
    expect(result.headers).toEqual(["Seq No", "Posted On", "Txn Text", "Movement"]);
    expect(result.missingRequired).toEqual(["date", "description"]);
  });

  it("surfaces the server's message instead of the generic non-2xx text", async () => {
    mockInvoke.mockResolvedValue({
      data: null,
      error: httpError(400, {
        error: {
          code: "CSV_EMPTY",
          message: "We could not read that file.",
          retryable: false,
          requestId: "abc",
        },
      }),
    });

    await expect(previewCsv({ ...GOOD_INPUT, csvContent: "" })).rejects.toThrow(
      "We could not read that file.",
    );
    // The generic supabase-js message must never be what a user sees.
    await expect(previewCsv({ ...GOOD_INPUT, csvContent: "" })).rejects.not.toThrow(
      /non-2xx/,
    );
  });

  it("falls back to the error message when the body is not JSON", async () => {
    mockInvoke.mockResolvedValue({
      data: null,
      error: {
        name: "FunctionsHttpError",
        message: "Edge Function returned a non-2xx status code",
        context: {
          status: 500,
          json: async () => {
            throw new Error("not json");
          },
        },
      },
    });

    await expect(previewCsv(GOOD_INPUT)).rejects.toThrow(/non-2xx/);
  });

  it("handles a network failure with no response context at all", async () => {
    mockInvoke.mockResolvedValue({
      data: null,
      error: { name: "FunctionsFetchError", message: "TypeError: Network request failed" },
    });

    await expect(previewCsv(GOOD_INPUT)).rejects.toThrow(/Network request failed/);
  });

  it("returns the parsed preview on success", async () => {
    const body = { ok: true, preview: true, layoutId: "date_narration_debit_credit_balance", added: 4 };
    mockInvoke.mockResolvedValue({ data: body, error: null });

    await expect(previewCsv(GOOD_INPUT)).resolves.toMatchObject({ added: 4, layoutId: expect.any(String) });
  });

  it("sends the file as raw text, never base64", async () => {
    const csv = "Date,Narration,Debit,Credit\n15/10/2026,X,100.00,\n";
    mockInvoke.mockResolvedValue({ data: { ok: true, added: 1 }, error: null });

    await previewCsv({ fileName: "s.csv", csvContent: csv, preview: true } as never);

    const [, options] = mockInvoke.mock.calls[0];
    const sent = options.body ?? {};
    expect(sent.csvContent).toBe(csv);
    expect(sent.preview).toBe(true);
  });
});

describe("importCsv error handling", () => {
  it("surfaces the server's stable error message", async () => {
    mockInvoke.mockResolvedValue({
      data: null,
      error: httpError(422, {
        error: {
          code: "CSV_NO_USABLE_ROWS",
          message: "We could not read any transactions from that file. Check the column mapping.",
          retryable: false,
          requestId: "def",
        },
      }),
    });

    await expect(importCsv(GOOD_INPUT)).rejects.toThrow(
      "We could not read any transactions from that file. Check the column mapping.",
    );
  });

  it("returns the committed result on success", async () => {
    mockInvoke.mockResolvedValue({ data: { ok: true, added: 4, accountId: "a1" }, error: null });
    await expect(importCsv(GOOD_INPUT)).resolves.toMatchObject({ added: 4, accountId: "a1" });
  });
});
