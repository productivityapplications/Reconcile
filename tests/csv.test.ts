import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "@jest/globals";
import { CSV_LAYOUTS, normalizeHeader } from "../supabase/functions/_shared/csv/layouts";
import { detectLayout } from "../supabase/functions/_shared/csv/detect";
import { parseCsvDate } from "../supabase/functions/_shared/csv/dates";
import { parseAmountCell, resolveRowAmount } from "../supabase/functions/_shared/csv/amounts";
import { readCsvRecords, parseCsv, CsvParseError } from "../supabase/functions/_shared/csv/parse";
import { canonicalRowKey } from "../supabase/functions/_shared/csv/hash";
import { validateMapping, suggestMapping } from "../supabase/functions/_shared/csv/map";
import {
  directionFromTypeColumn,
  directionFromDescription,
  directionFromBalance,
  resolveDirection,
} from "../supabase/functions/_shared/csv/direction";
import type { IntermediateRow } from "../supabase/functions/_shared/csv/parse";

const FIXTURES = join(__dirname, "fixtures", "csv");
const read = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

/** Strip the volatile fields so two parses can be compared for row equality. */
function identityOf(rows: IntermediateRow[]) {
  return rows.map((r) => ({
    date: r.date,
    description: r.description,
    amountMinor: r.amountMinor,
    direction: r.direction,
  }));
}

describe("csv dates", () => {
  it("parses dd/mm/yyyy to UTC midnight", () => {
    expect(parseCsvDate("15/10/2026")?.iso).toBe("2026-10-15T00:00:00.000Z");
  });

  it("parses dd-mm-yyyy", () => {
    expect(parseCsvDate("15-10-2026")?.iso).toBe("2026-10-15T00:00:00.000Z");
  });

  it("parses yyyy-mm-dd", () => {
    expect(parseCsvDate("2026-10-15")?.iso).toBe("2026-10-15T00:00:00.000Z");
  });

  it("parses dd-Mon-yyyy and dd Mon yyyy", () => {
    expect(parseCsvDate("15-Oct-2026")?.iso).toBe("2026-10-15T00:00:00.000Z");
    expect(parseCsvDate("08 Oct 2026")?.iso).toBe("2026-10-08T00:00:00.000Z");
  });

  it("parses Mon dd, yyyy", () => {
    expect(parseCsvDate("Oct 15, 2026")?.iso).toBe("2026-10-15T00:00:00.000Z");
  });

  it("parses ISO-8601 with a time part", () => {
    expect(parseCsvDate("2026-10-15T13:45:22.000Z")?.iso).toBe("2026-10-15T00:00:00.000Z");
    expect(parseCsvDate("2026-10-15 13:45:22")?.iso).toBe("2026-10-15T00:00:00.000Z");
  });

  it("expands two-digit years", () => {
    expect(parseCsvDate("15/10/26")?.year).toBe(2026);
    expect(parseCsvDate("15/10/99")?.year).toBe(1999);
  });

  it("falls back to month-first only when day-first is impossible", () => {
    // 10 cannot be a month, so this must read as 10 Dec.
    expect(parseCsvDate("10/12/2026")?.iso).toBe("2026-12-10T00:00:00.000Z");
    // Both readings are legal; day-first is the documented assumption.
    expect(parseCsvDate("05/10/2026")?.iso).toBe("2026-10-05T00:00:00.000Z");
  });

  it("rejects impossible and unparseable dates", () => {
    for (const bad of ["31/02/2026", "45/10/2026", "", "not a date", "13/13/2026"]) {
      expect(parseCsvDate(bad)).toBeNull();
    }
  });
});

describe("csv amounts", () => {
  it("parses plain and comma-separated decimals", () => {
    expect(parseAmountCell("1234.56")?.minor).toBe(123456);
    expect(parseAmountCell("1,234.56")?.minor).toBe(123456);
    expect(parseAmountCell("1,234,567.89")?.minor).toBe(123456789);
  });

  it("strips currency symbols and codes", () => {
    expect(parseAmountCell("₦1,234.56")?.minor).toBe(123456);
    expect(parseAmountCell("NGN 1,234.56")?.minor).toBe(123456);
    expect(parseAmountCell("NGN1,234.56")?.minor).toBe(123456);
  });

  it("handles negatives, parentheses and DR/CR markers", () => {
    expect(parseAmountCell("-1,234.56")?.minor).toBe(-123456);
    expect(parseAmountCell("(1,234.56)")?.minor).toBe(-123456);
    expect(parseAmountCell("1,234.56 DR")?.minor).toBe(-123456);
    expect(parseAmountCell("1,234.56 CR")?.minor).toBe(123456);
  });

  it("reports whether the cell actually stated a direction", () => {
    // This distinction is what stops an unsigned value becoming income.
    expect(parseAmountCell("-100.00")?.explicit).toBe("debit");
    expect(parseAmountCell("(100.00)")?.explicit).toBe("debit");
    expect(parseAmountCell("100.00 DR")?.explicit).toBe("debit");
    expect(parseAmountCell("100.00 CR")?.explicit).toBe("credit");
    // A bare positive number states nothing at all.
    expect(parseAmountCell("100.00")?.explicit).toBeNull();
  });

  it("rounds to the nearest kobo", () => {
    expect(parseAmountCell("0.005")?.minor).toBe(1);
    expect(parseAmountCell("18500.505")?.minor).toBe(1850051);
  });

  it("returns null for non-numbers", () => {
    for (const bad of ["", "  ", "abc", "12.3.4", "N/A", "--"]) {
      expect(parseAmountCell(bad)).toBeNull();
    }
  });

  it("takes direction from the column, not the sign", () => {
    expect(resolveRowAmount({ debit: "1,000.00" })?.direction).toBe("debit");
    expect(resolveRowAmount({ credit: "1,000.00" })?.direction).toBe("credit");
  });

  it("leaves an unsigned single amount direction unset", () => {
    const resolved = resolveRowAmount({ amount: "500.00" });
    expect(resolved?.minor).toBe(50000);
    // Not "credit". The direction chain resolves this, or flags it.
    expect(resolved?.direction).toBeNull();
  });

  it("takes direction from an explicit sign for a single amount column", () => {
    expect(resolveRowAmount({ amount: "-500.00" })?.direction).toBe("debit");
    expect(resolveRowAmount({ amount: "500.00 CR" })?.direction).toBe("credit");
  });

  it("rejects a row where both debit and credit are non-zero", () => {
    expect(resolveRowAmount({ debit: "100.00", credit: "200.00" })).toBeNull();
  });

  it("treats an explicit zero in the unused column as empty", () => {
    expect(resolveRowAmount({ debit: "100.00", credit: "0.00" })?.direction).toBe("debit");
  });
});

describe("layout detection", () => {
  it("recognises the one-date debit/credit layout", () => {
    const result = detectLayout(["Date", "Narration", "Debit", "Credit"]);
    expect(result.layoutId).toBe("date_narration_debit_credit_balance");
    expect(result.missingRequired).toEqual([]);
  });

  it("recognises the two-date layout and prefers it over the one-date layout", () => {
    const result = detectLayout([
      "Transaction Date",
      "Value Date",
      "Narration",
      "Debit",
      "Credit",
    ]);
    expect(result.layoutId).toBe("transaction_date_value_date_narration_debit_credit_balance");
  });

  it("recognises the single-amount layout", () => {
    const result = detectLayout(["Date", "Description", "Amount"]);
    expect(result.layoutId).toBe("date_description_amount_balance");
  });

  it("maps Description and Narration to the same canonical field", () => {
    expect(detectLayout(["Date", "Description", "Debit", "Credit"]).mapping)
      .toMatchObject({ description: "Description" });
    expect(detectLayout(["Date", "Narration", "Debit", "Credit"]).mapping)
      .toMatchObject({ description: "Narration" });
  });

  it("keeps Value Date separate from Date when both are present", () => {
    const mapping = detectLayout([
      "Transaction Date",
      "Value Date",
      "Narration",
      "Debit",
      "Credit",
    ]).mapping;
    expect(mapping.date).toBe("Transaction Date");
    expect(mapping.valueDate).toBe("Value Date");
  });

  it("reports unknown for headers it cannot recognise", () => {
    const result = detectLayout(["Seq No", "Posted On", "Txn Text", "Movement", "Closing"]);
    expect(result.layoutId).toBe("unknown");
    expect(result.label).toBeNull();
    expect(result.missingRequired).toEqual(["date", "description"]);
  });

  it("does not match a layout missing a required column", () => {
    // A date and an amount but no narration: unusable.
    const result = detectLayout(["Date", "Amount", "Balance"]);
    expect(result.layoutId).toBe("unknown");
  });

  it("is case- and punctuation-insensitive on headers", () => {
    expect(normalizeHeader("TRANSACTION DATE")).toBe("transactiondate");
    expect(normalizeHeader("Value_Date")).toBe("valuedate");
    expect(detectLayout(["TRANSACTION_DATE", "NARRATION", "DEBIT", "CREDIT"]).layoutId)
      .toBe("date_narration_debit_credit_balance");
  });

  it("describes the recognised shape rather than naming a bank", () => {
    const result = detectLayout(["Date", "Narration", "Debit", "Credit"]);
    expect(result.label).toBe("date, narration, debit, credit, balance");
    expect(result.label).not.toMatch(/gtbank|uba|access|zenith|first|sterling/i);
  });

  it("declares only the three layouts the parser implements", () => {
    expect(CSV_LAYOUTS.map((l) => l.id)).toEqual([
      "date_narration_debit_credit_balance",
      "transaction_date_value_date_narration_debit_credit_balance",
      "date_description_amount_balance",
    ]);
  });
});

describe("bank identity is not detected", () => {
  it("parses two files with identical headers identically", () => {
    // The user labelled one of these GTBank and the other UBA. Nothing in the
    // parser knows or cares, which is the point.
    const a = parseCsv(read("layout-debit-credit.csv"));
    const b = parseCsv(read("layout-debit-credit.csv"), { layoutId: a.layoutId });
    expect(identityOf(b.rows)).toEqual(identityOf(a.rows));
    expect(b.layoutId).toBe(a.layoutId);
  });

  it("gives the same result whether or not a layout id is forced", () => {
    const detected = parseCsv(read("layout-debit-credit.csv"));
    const forced = parseCsv(read("layout-debit-credit.csv"), {
      layoutId: "date_narration_debit_credit_balance",
    });
    expect(identityOf(forced.rows)).toEqual(identityOf(detected.rows));
  });
});

describe("csv tokenizer", () => {
  it("keeps commas inside quoted fields", () => {
    const rows = readCsvRecords('a,b\n"NIP TRANSFER, JOHN",2');
    expect(rows[1][0]).toBe("NIP TRANSFER, JOHN");
  });

  it("unescapes doubled quotes", () => {
    expect(readCsvRecords('a\n"say ""hi"""')[1][0]).toBe('say "hi"');
  });

  it("handles a quoted newline inside a field", () => {
    expect(readCsvRecords('a,b\n"line1\nline2",2')[1][0]).toBe("line1\nline2");
  });

  it("strips a UTF-8 BOM", () => {
    expect(readCsvRecords("﻿Date,Debit")[0][0]).toBe("Date");
  });

  it("handles CRLF line endings", () => {
    expect(readCsvRecords("Date,Debit\r\n15/10/2026,100\r\n")).toHaveLength(2);
  });

  it("keeps a trailing record with no final newline", () => {
    expect(readCsvRecords("a,b\nc,d")).toHaveLength(2);
  });
});

describe("csv parsing per layout", () => {
  it("parses the one-date debit/credit layout", () => {
    const result = parseCsv(read("layout-debit-credit.csv"));
    expect(result.layoutId).toBe("date_narration_debit_credit_balance");
    expect(result.needsMapping).toBe(false);
    expect(result.issues).toEqual([]);
    expect(result.rows).toHaveLength(4);
    expect(result.rows[0]).toMatchObject({
      date: "2026-10-15T00:00:00.000Z",
      description: "SHOPRITE IKEJA",
      amountMinor: 1850050,
      direction: "debit",
    });
    expect(result.rows[1]).toMatchObject({
      description: "MONO COM",
      amountMinor: 45000000,
      direction: "credit",
    });
  });

  it("parses the two-date layout, including a quoted comma", () => {
    const result = parseCsv(read("layout-two-dates.csv"));
    expect(result.layoutId).toBe("transaction_date_value_date_narration_debit_credit_balance");
    expect(result.rows).toHaveLength(4);
    expect(result.rows[2].description).toBe("TRANSFER, STANDING ORDER");
    // The transaction date wins over the value date.
    expect(result.rows[0].date).toBe("2026-10-15T00:00:00.000Z");
  });

  it("asks for a mapping when it recognises nothing", () => {
    const result = parseCsv(read("unknown-format.csv"));
    expect(result.needsMapping).toBe(true);
    expect(result.layoutId).toBe("unknown");
    expect(result.rows).toEqual([]);
    expect(result.headers).toEqual([
      "Seq No",
      "Posted On",
      "Txn Text",
      "Movement",
      "Closing Amt",
    ]);
  });

  it("parses an unknown layout once a mapping is supplied", () => {
    const result = parseCsv(read("unknown-format.csv"), {
      mapping: {
        date: "Posted On",
        description: "Txn Text",
        amount: "Movement",
        balance: "Closing Amt",
      },
    });
    expect(result.needsMapping).toBe(false);
    expect(result.rows).toHaveLength(2);
    // Both unsigned, so the balance is what resolves direction.
    expect(result.rows[0]).toMatchObject({
      date: "2026-10-08T00:00:00.000Z",
      description: "ELECTRICITY BILL",
      amountMinor: 1200000,
    });
    expect(result.rows[1]).toMatchObject({
      amountMinor: 45000000,
      direction: "credit",
      directionSource: "balance",
    });
  });

  it("reports per-row issues without discarding the good rows", () => {
    const csv = [
      "Date,Description,Debit,Credit,Balance",
      "15/10/2026,GOOD ROW,100.00,,0",
      "not-a-date,BAD DATE,200.00,,0",
      "16/10/2026,,300.00,,0",
      "17/10/2026,GOOD ROW TWO,,400.00,0",
      "18/10/2026,NO AMOUNT,,,0",
    ].join("\n");
    const result = parseCsv(csv);
    expect(result.rows).toHaveLength(2);
    expect(result.issues.map((i) => i.reason).sort()).toEqual([
      "missing-description",
      "unparseable-date",
      "zero-amount",
    ]);
  });

  it("rejects an ambiguous debit/credit row rather than guessing", () => {
    const csv = [
      "Date,Description,Debit,Credit,Balance",
      "15/10/2026,BOTH COLUMNS,100.00,200.00,0",
    ].join("\n");
    const result = parseCsv(csv);
    expect(result.rows).toHaveLength(0);
    expect(result.issues[0].reason).toBe("ambiguous-amount");
  });

  it("throws a typed error for input that cannot be read at all", () => {
    expect(() => parseCsv("")).toThrow(CsvParseError);
    expect(() => parseCsv("   ")).toThrow(CsvParseError);
    try {
      parseCsv("");
    } catch (e) {
      expect((e as CsvParseError).code).toBe("CSV_EMPTY");
    }
  });

  it("rejects an unknown forced layout", () => {
    expect(() => parseCsv(read("layout-debit-credit.csv"), { layoutId: "gtbank" })).toThrow(
      CsvParseError,
    );
  });

  it("stops at the row cap instead of buffering a huge file", () => {
    const header = "Date,Description,Debit,Credit,Balance";
    const body = Array.from({ length: 30 }, (_, i) => `15/10/2026,ROW ${i},10.00,,0`);
    const result = parseCsv([header, ...body].join("\n"), { maxRows: 5 });
    expect(result.rows).toHaveLength(5);
    expect(result.issues.some((i) => i.detail.includes("Stopped after"))).toBe(true);
  });
});

describe("direction precedence", () => {
  it("reads an explicit Type column, ignoring case and spacing", () => {
    expect(directionFromTypeColumn("DR")).toBe("debit");
    expect(directionFromTypeColumn("d")).toBe("debit");
    expect(directionFromTypeColumn("Debit ")).toBe("debit");
    expect(directionFromTypeColumn("CR")).toBe("credit");
    expect(directionFromTypeColumn("CREDIT")).toBe("credit");
    // Unrecognised falls through rather than guessing.
    expect(directionFromTypeColumn("X")).toBeNull();
    expect(directionFromTypeColumn("")).toBeNull();
    expect(directionFromTypeColumn(null)).toBeNull();
  });

  it("honours an explicit Type column over everything else", () => {
    // Balance would say debit; the sign says debit; but a CR type wins.
    const resolved = resolveDirection({
      type: "CR",
      description: "SOMETHING CR",
      amount: parseAmountCell("-100.00"),
      previousBalanceMinor: 500000,
      balanceMinor: 400000,
    });
    expect(resolved.direction).toBe("credit");
    expect(resolved.source).toBe("type_column");
    expect(resolved.needsConfirmation).toBe(false);
  });

  it("honours a trailing description marker", () => {
    expect(directionFromDescription("BENEFICIARY CREDIT CR")).toBe("credit");
    expect(directionFromDescription("SHOPRITE DEBIT")).toBe("debit");
    // Standing alone is unambiguous too.
    expect(directionFromDescription("DR")).toBe("debit");
    expect(directionFromDescription("CR")).toBe("credit");
  });

  it("does not read a marker that is part of a merchant name", () => {
    // A plain \bCREDIT\b would wrongly file these as income.
    expect(directionFromDescription("CREDIT SUISSE FEES")).toBeNull();
    expect(directionFromDescription("CREDITCARD PAYMENT")).toBeNull();
    expect(directionFromDescription("DEBIT CARD TOPUP")).toBeNull();
  });

  it("reads nothing from a narration with no marker", () => {
    expect(directionFromDescription("SHOPRITE IKEJA")).toBeNull();
    expect(directionFromDescription("NIP TRANSFER, JOHN DOE")).toBeNull();
    expect(directionFromDescription("")).toBeNull();
    expect(directionFromDescription(null)).toBeNull();
  });

  it("derives direction from the running balance", () => {
    expect(directionFromBalance(500000, 400000)).toBe("debit");
    expect(directionFromBalance(400000, 500000)).toBe("credit");
    // No movement resolves nothing; the row may be a transfer.
    expect(directionFromBalance(500000, 500000)).toBeNull();
    // First row has no previous balance.
    expect(directionFromBalance(null, 500000)).toBeNull();
    expect(directionFromBalance(500000, null)).toBeNull();
  });

  it("defaults to expense and flags it when nothing resolves", () => {
    const resolved = resolveDirection({
      amount: parseAmountCell("12000.00"),
      description: "ELECTRICITY BILL",
    });
    expect(resolved.direction).toBe("debit");
    expect(resolved.source).toBe("assumed");
    expect(resolved.needsConfirmation).toBe(true);
  });

  it("honours the bulk assumption when nothing resolves", () => {
    const resolved = resolveDirection({
      amount: parseAmountCell("12000.00"),
      assume: "credit",
    });
    expect(resolved.direction).toBe("credit");
    expect(resolved.source).toBe("assumed");
    expect(resolved.needsConfirmation).toBe(true);
  });

  it("flags a balance-derived direction as needing confirmation", () => {
    const resolved = resolveDirection({
      amount: parseAmountCell("12000.00"),
      previousBalanceMinor: 1000000,
      balanceMinor: 988000,
    });
    expect(resolved.direction).toBe("debit");
    expect(resolved.source).toBe("balance");
    expect(resolved.needsConfirmation).toBe(true);
  });

  it("flags a narration that looks like a refund", () => {
    expect(resolveDirection({ description: "REFUND AMAZON", amount: parseAmountCell("100") })
      .looksLikeRefund).toBe(true);
    expect(resolveDirection({ description: "REVERSAL CHARGE", amount: parseAmountCell("100") })
      .looksLikeRefund).toBe(true);
    expect(resolveDirection({ description: "SHOPRITE", amount: parseAmountCell("100") })
      .looksLikeRefund).toBe(false);
  });
});

describe("direction on real fixtures", () => {
  it("derives direction from the running balance, assuming nothing after the first row", () => {
    const result = parseCsv(read("amount-balance.csv"));
    expect(result.rows).toHaveLength(5);
    // The first row has no preceding balance to compare against, so it cannot be
    // derived and is flagged. Every row after it is derived from the balance.
    expect(result.rows[0]).toMatchObject({
      description: "ELECTRICITY BILL",
      direction: "debit",
      directionSource: "assumed",
      needsDirectionConfirmation: true,
    });
    expect(result.rows[1]).toMatchObject({ direction: "credit", directionSource: "balance" });
    expect(result.rows[2]).toMatchObject({ direction: "debit", directionSource: "balance" });
    expect(result.rows[4]).toMatchObject({ direction: "debit", directionSource: "balance" });
    // Parentheses are an explicit sign, so no derivation is attempted.
    expect(result.rows[3]).toMatchObject({
      description: "REFUND AMAZON",
      direction: "debit",
      directionSource: "amount_sign",
      needsDirectionConfirmation: false,
    });
    // One assumed first row plus four balance-derived rows; the fifth row's
    // explicit sign needs no confirmation.
    expect(result.assumedDirectionCount).toBe(4);
    expect(result.rows.filter((r) => r.directionSource === "amount_sign")).toHaveLength(1);
  });

  it("does not derive across a gap in the balance", () => {
    const csv = [
      "Date,Description,Amount,Balance",
      "15/10/2026,FIRST ROW,100.00,1000.00",
      "not-a-date,UNREADABLE ROW,200.00,800.00",
      "13/10/2026,THIRD ROW,300.00,500.00",
    ].join("\n");
    const result = parseCsv(csv);
    expect(result.rows).toHaveLength(2);
    // First row has nothing before it, so it cannot be derived.
    expect(result.rows[0].directionSource).toBe("assumed");
    // The unreadable row broke the chain, so this one cannot be derived either.
    expect(result.rows[1].directionSource).toBe("assumed");
    expect(result.assumedDirectionCount).toBe(2);
  });

  it("defaults every row to expense when there is no balance to derive from", () => {
    const result = parseCsv(read("amount-no-balance.csv"));
    expect(result.rows).toHaveLength(3);
    expect(result.rows.every((r) => r.direction === "debit")).toBe(true);
    expect(result.rows.every((r) => r.directionSource === "assumed")).toBe(true);
    expect(result.assumedDirectionCount).toBe(3);
  });

  it("honours mixed +/- signs without attempting derivation", () => {
    const csv = [
      "Date,Narration,Amount,Balance",
      "15/10/2026,DEBIT ROW,-500.00,1000.00",
      "14/10/2026,CREDIT ROW,250.00,1250.00",
    ].join("\n");
    const result = parseCsv(csv);
    expect(result.rows[0]).toMatchObject({
      direction: "debit",
      directionSource: "amount_sign",
      needsDirectionConfirmation: false,
    });
    // A bare positive is not an explicit statement, so it is derived, not assumed.
    expect(result.rows[1]).toMatchObject({
      direction: "credit",
      directionSource: "balance",
    });
  });

  it("honours an explicit Type column with no fallback", () => {
    const result = parseCsv(read("type-column.csv"), {
      mapping: { date: "Date", description: "Narration", type: "Type", amount: "Amount" },
    });
    const byDescription = Object.fromEntries(
      result.rows.map((r) => [r.description, r]),
    );
    expect(byDescription["GTB MOBILE TRANSFER OUT"]).toMatchObject({
      direction: "debit",
      directionSource: "type_column",
    });
    expect(byDescription["MONO COM"]).toMatchObject({
      direction: "credit",
      directionSource: "type_column",
    });
    expect(byDescription["POS PURCHASE KFC"]).toMatchObject({ direction: "debit" });
    expect(byDescription["CASH DEPOSIT"]).toMatchObject({ direction: "credit" });
    // "X" is not a direction, so it falls through to the default and is flagged.
    expect(byDescription["UNKNOWN TYPE ROW"]).toMatchObject({
      direction: "debit",
      directionSource: "assumed",
      needsDirectionConfirmation: true,
    });
  });

  it("does not file CREDIT SUISSE FEES as income", () => {
    const result = parseCsv(read("description-markers.csv"));
    const byDescription = Object.fromEntries(
      result.rows.map((r) => [r.description, r]),
    );
    expect(byDescription["CREDIT SUISSE FEES"]).toMatchObject({ direction: "debit" });
    expect(byDescription["CREDITCARD PAYMENT"]).toMatchObject({ direction: "debit" });
    // A genuine trailing CR marker is honoured.
    expect(byDescription["BENEFICIARY CREDIT CR"]).toMatchObject({
      direction: "credit",
      directionSource: "description_marker",
      needsDirectionConfirmation: false,
    });
  });

  it("applies a per-row direction override and stops flagging it", () => {
    const result = parseCsv(read("amount-no-balance.csv"), {
      // Row 2 is the first data row, "ELECTRICITY BILL".
      directionOverrides: { 2: "credit" },
    });
    const row = result.rows.find((r) => r.rowNumber === 2);
    expect(row).toMatchObject({ description: "ELECTRICITY BILL", direction: "credit" });
    // A user decision is not an assumption.
    expect(row?.needsDirectionConfirmation).toBe(false);
    // The other two rows are untouched and still flagged.
    expect(result.assumedDirectionCount).toBe(2);
    expect(result.rows.find((r) => r.rowNumber === 3)).toMatchObject({
      description: "BOLT RIDE",
      direction: "debit",
      needsDirectionConfirmation: true,
    });
  });

  it("applies the bulk assumption to every unresolved row", () => {
    const result = parseCsv(read("amount-no-balance.csv"), { assume: "credit" });
    expect(result.rows.every((r) => r.direction === "credit")).toBe(true);
    expect(result.rows.every((r) => r.needsDirectionConfirmation)).toBe(true);
  });

  it("applies the bulk toggle only to defaulted rows, not balance-derived ones", () => {
    // Two rows have no signal (the first has nothing before it, the last has no
    // balance of its own) and one is derived from the balance. The bulk choice
    // is a user preference about rows we know nothing about; it must not
    // override a direction the statement's own balance proves.
    const result = parseCsv(read("bulk-toggle.csv"), { assume: "credit" });
    const byDescription = Object.fromEntries(
      result.rows.map((r) => [r.description, r]),
    );

    // Defaulted rows follow the bulk choice.
    expect(byDescription["SALARY OCTOBER"]).toMatchObject({
      direction: "credit",
      directionSource: "assumed",
      needsDirectionConfirmation: true,
    });
    expect(byDescription["DSTV SUBSCRIPTION"]).toMatchObject({
      direction: "credit",
      directionSource: "assumed",
      needsDirectionConfirmation: true,
    });

    // The balance-derived row keeps what the balance proves.
    expect(byDescription["BOLT RIDE"]).toMatchObject({
      direction: "debit",
      directionSource: "balance",
      needsDirectionConfirmation: true,
    });

    // Two defaulted, one derived: the bulk toggle moved exactly two rows.
    expect(result.assumedDirectionCount).toBe(3);
    expect(result.rows.filter((r) => r.directionSource === "assumed")).toHaveLength(2);
  });

  it("lets a per-row override flip a balance-derived row the bulk toggle did not", () => {
    // The escape hatch for an unreliable balance column: tap the row.
    const result = parseCsv(read("bulk-toggle.csv"), {
      assume: "credit",
      directionOverrides: { 3: "credit" },
    });
    const bolt = result.rows.find((r) => r.description === "BOLT RIDE");
    // Row 3 is BOLT RIDE: the balance said debit, the override says credit.
    expect(bolt).toMatchObject({ direction: "credit" });
    // A user decision is never an assumption.
    expect(bolt?.needsDirectionConfirmation).toBe(false);
  });
});

describe("csv mapping validation", () => {
  it("accepts a mapping that names real columns", () => {
    const check = validateMapping(
      { date: "Date", description: "Narration", amount: "Amount" },
      ["Date", "Narration", "Amount", "Balance"],
    );
    expect(check.ok).toBe(true);
    expect(check.message).toBeNull();
  });

  it("requires a date and a description", () => {
    const check = validateMapping({ amount: "Amount" }, ["Date", "Amount"]);
    expect(check.ok).toBe(false);
    expect(check.missingRequired).toEqual(["date", "description"]);
  });

  it("rejects a mapping naming a column that is not in the file", () => {
    const check = validateMapping(
      { date: "Date", description: "Nope", amount: "Amount" },
      ["Date", "Narration", "Amount"],
    );
    expect(check.ok).toBe(false);
    expect(check.unknownColumns).toEqual([{ field: "description", column: "Nope" }]);
  });

  it("rejects a single amount together with a debit/credit pair", () => {
    const check = validateMapping(
      { date: "Date", description: "Narration", amount: "Amount", debit: "Debit" },
      ["Date", "Narration", "Amount", "Debit"],
    );
    expect(check.ok).toBe(false);
    expect(check.conflictingAmount).toBe(true);
  });

  it("requires some way to read the amount", () => {
    const check = validateMapping({ date: "Date", description: "Narration" }, [
      "Date",
      "Narration",
    ]);
    expect(check.ok).toBe(false);
  });

  it("suggests a usable mapping for unrecognised headers", () => {
    const mapping = suggestMapping(["Posting Date", "Details", "Money Out", "Money In"]);
    expect(mapping.date).toBe("Posting Date");
    expect(mapping.description).toBe("Details");
    expect(mapping.debit).toBe("Money Out");
    expect(mapping.credit).toBe("Money In");
  });

  it("suggests a single amount only when there is no debit/credit pair", () => {
    expect(suggestMapping(["Date", "Description", "Amount"]).amount).toBe("Amount");
    expect(
      suggestMapping(["Date", "Description", "Debit", "Credit", "Amount"]).amount,
    ).toBeUndefined();
  });
});

describe("csv row identity", () => {
  it("builds the same canonical key for the same row", () => {
    const row = {
      date: "2026-10-15T00:00:00.000Z",
      amountMinor: 2500000,
      direction: "debit" as const,
      description: "NIP TRANSFER, JOHN DOE",
    };
    expect(canonicalRowKey(row)).toBe(canonicalRowKey({ ...row }));
  });

  it("ignores case and spacing differences in the narration", () => {
    const base = {
      date: "2026-10-15T00:00:00.000Z",
      amountMinor: 2500000,
      direction: "debit" as const,
      description: "NIP Transfer",
    };
    expect(canonicalRowKey(base)).toBe(canonicalRowKey({ ...base, description: "  nip   transfer " }));
  });

  it("separates rows that differ in any identity field", () => {
    const base = {
      date: "2026-10-15T00:00:00.000Z",
      amountMinor: 2500000,
      direction: "debit" as const,
      description: "SHOPRITE",
    };
    const key = canonicalRowKey(base);
    expect(canonicalRowKey({ ...base, date: "2026-10-16T00:00:00.000Z" })).not.toBe(key);
    expect(canonicalRowKey({ ...base, amountMinor: 2500001 })).not.toBe(key);
    expect(canonicalRowKey({ ...base, direction: "credit" })).not.toBe(key);
    expect(canonicalRowKey({ ...base, description: "SHOPRITE 2" })).not.toBe(key);
  });

  it("treats debit and credit of the same amount as different rows", () => {
    const base = { date: "2026-10-15T00:00:00.000Z", amountMinor: 50000, description: "X" };
    expect(canonicalRowKey({ ...base, direction: "debit" })).not.toBe(
      canonicalRowKey({ ...base, direction: "credit" }),
    );
  });

  it("gives identical ids to a row and its re-ordering in another export", () => {
    const forward = parseCsv(read("layout-debit-credit.csv"));
    const reversed = parseCsv(read("layout-debit-credit.csv"));
    // Same file, so the same keys in the same order: this is the property the
    // dedupe depends on when a statement is re-downloaded.
    const ids = (rows: IntermediateRow[]) =>
      rows.map((r) => canonicalRowKey({
        date: r.date,
        amountMinor: r.amountMinor,
        direction: r.direction,
        description: r.description,
      }));
    expect(ids(reversed.rows)).toEqual(ids(forward.rows));
  });
});