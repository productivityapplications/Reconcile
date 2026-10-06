// CSV parsing into the normalised intermediate shape — PURE.
//
// One concern only: turn raw CSV text into rows the rest of the pipeline can
// reason about. Hashing, persistence and rendering happen elsewhere.
//
// The parser is layout-driven, not bank-driven. It never asks which bank
// produced the file, because several banks share a header row and guessing would
// be wrong. See ./layouts.ts.

import { detectLayout, mapHeadersFor, type ColumnMapping } from "./detect.ts";
import { UNKNOWN_LAYOUT_ID, layoutById } from "./layouts.ts";
import { parseCsvDate } from "./dates.ts";
import { parseAmountCell, resolveRowAmount } from "./amounts.ts";
import { resolveDirection, type DirectionSource } from "./direction.ts";
import type { Direction } from "../finance.ts";

/**
 * One parsed CSV row, before it becomes a ledger transaction.
 *
 * `date` is already an ISO instant at UTC midnight so every downstream
 * comparison and grouping agrees.
 */
export interface IntermediateRow {
  /** 1-based line number in the source file, for error messages. */
  rowNumber: number;
  date: string;
  description: string;
  amountMinor: number;
  direction: Direction;
  /**
   * Which step resolved direction. "balance" and "assumed" are weak signals that
   * the import preview marks for the user to confirm.
   */
  directionSource: DirectionSource;
  /** True when direction came from a weak signal and the user may want to flip it. */
  needsDirectionConfirmation: boolean;
  /** Narration suggests a reversal or refund. */
  looksLikeRefund: boolean;
  balanceMinor: number | null;
  reference: string | null;
  /** Account number from the file, when the layout has one. */
  accountNumber: string | null;
}

/** Why a row could not be used. Never thrown; always counted. */
export interface RowIssue {
  rowNumber: number;
  reason:
    | "unparseable-date"
    | "unparseable-amount"
    | "ambiguous-amount"
    | "missing-description"
    | "zero-amount"
    | "ragged-row";
  detail: string;
}

export interface ParseResult {
  /** Detected layout id, or "unknown" when the caller must supply a mapping. */
  layoutId: string;
  /** Human description of the layout, e.g. "date, narration, debit, credit,
   *  balance". This is what the parser actually knows — not a bank name. */
  layoutLabel: string | null;
  headers: string[];
  mapping: ColumnMapping;
  /** More than one layout matched and the tie was broken by declaration order. */
  ambiguous: boolean;
  /** Layout could not be recognised; the caller should offer column mapping. */
  needsMapping: boolean;
  missingRequired: string[];
  rows: IntermediateRow[];
  issues: RowIssue[];
  /** Total data rows seen, including ones that produced issues. */
  totalRows: number;
  /** Rows whose direction came from a weak signal, for the preview summary. */
  assumedDirectionCount: number;
}

/**
 * RFC 4180 tokenizer.
 *
 * Handles quoted fields containing commas, newlines and escaped quotes ("").
 * Bank narrations routinely contain commas — "NIP TRANSFER, JOHN DOE" — so a
 * naive split-on-comma would corrupt most real exports.
 */
export function readCsvRecords(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let sawAnyChar = false;

  // Strip a UTF-8 BOM, which Excel writes and which would corrupt the first
  // header name.
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      sawAnyChar = true;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      sawAnyChar = true;
      continue;
    }
    if (ch === "\r") continue;
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      sawAnyChar = false;
      continue;
    }
    field += ch;
    sawAnyChar = true;
  }

  // Flush the final record if the file did not end with a newline.
  if (field.length > 0 || row.length > 0 || sawAnyChar) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/** Drop rows that are entirely blank, which exports are full of. */
function isBlankRow(cells: string[]): boolean {
  return cells.every((c) => c.trim().length === 0);
}

export interface ParseOptions {
  /** Explicit mapping from the client, used when detection failed. */
  mapping?: ColumnMapping | null;
  /** Force a specific layout id instead of detecting. */
  layoutId?: string | null;
  /** Stop after this many data rows. Guards against a pathological file. */
  maxRows?: number;
  /**
   * Bulk direction applied to rows no explicit signal resolved. Defaults to
   * expense. The preview offers a toggle so a statement of incoming payments
   * can flip it.
   */
  assume?: Direction;
  /** Per-row direction overrides keyed by 1-based row number. */
  directionOverrides?: Record<number, Direction> | null;
}

export const DEFAULT_MAX_ROWS = 20000;

export class CsvParseError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CsvParseError";
    this.code = code;
  }
}

/**
 * Parse CSV text into intermediate rows.
 *
 * Throws CsvParseError only for input that cannot be parsed at all (empty, or no
 * header). Per-row problems become `issues` so one bad line never costs the user
 * the rest of the file.
 */
export function parseCsv(content: string, options: ParseOptions = {}): ParseResult {
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new CsvParseError("CSV_EMPTY", "That file appears to be empty.");
  }

  const records = readCsvRecords(content).filter((r) => !isBlankRow(r));
  if (records.length === 0) {
    throw new CsvParseError("CSV_NO_ROWS", "That file has no rows we can read.");
  }

  const headers = records[0].map((h) => h.trim());
  if (headers.filter((h) => h.length > 0).length === 0) {
    throw new CsvParseError("CSV_NO_HEADER", "That file has no header row.");
  }

  // Mapping precedence: explicit client mapping, then a forced layout, then
  // detection. A client mapping is trusted only for column *selection* — every
  // value still goes through the same date/amount parsers.
  let mapping: ColumnMapping;
  let layoutId: string;
  let layoutLabel: string | null;
  let ambiguous = false;
  let needsMapping = false;
  let missingRequired: string[] = [];

  if (options.mapping && Object.keys(options.mapping).length > 0) {
    mapping = options.mapping;
    layoutId = options.layoutId ?? "custom";
    layoutLabel = options.layoutId
      ? (layoutById(options.layoutId)?.label ?? options.layoutId)
      : "custom mapping";
    missingRequired = (["date", "description"] as const).filter(
      (f) => mapping[f] === undefined || headers.indexOf(mapping[f] as string) === -1,
    );
    needsMapping = missingRequired.length > 0;
  } else if (options.layoutId) {
    const layout = layoutById(options.layoutId);
    if (!layout) {
      throw new CsvParseError("CSV_UNKNOWN_LAYOUT", `Unknown CSV layout "${options.layoutId}".`);
    }
    mapping = mapHeadersFor(layout, headers);
    layoutId = layout.id;
    layoutLabel = layout.label;
    missingRequired = (["date", "description"] as const).filter((f) => mapping[f] === undefined);
    needsMapping = missingRequired.length > 0;
  } else {
    const detected = detectLayout(headers);
    layoutId = detected.layoutId;
    layoutLabel = detected.label;
    mapping = detected.mapping;
    ambiguous = detected.ambiguous;
    needsMapping = detected.layoutId === UNKNOWN_LAYOUT_ID;
    missingRequired = detected.missingRequired as string[];
  }

  if (needsMapping) {
    return {
      layoutId,
      layoutLabel,
      headers,
      mapping: {},
      ambiguous,
      needsMapping: true,
      missingRequired,
      rows: [],
      issues: [],
      totalRows: records.length - 1,
      assumedDirectionCount: 0,
    };
  }

  const dataRows = records.slice(1);
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  const assume: Direction = options.assume === "credit" ? "credit" : "debit";
  const overrides = options.directionOverrides ?? {};
  const rows: IntermediateRow[] = [];
  const issues: RowIssue[] = [];

  // Balance on the last row we accepted, used to derive direction for the next.
  // Reset to null whenever a row cannot be read, so we never derive a direction
  // from across a gap in the statement.
  let previousBalanceMinor: number | null = null;

  for (let i = 0; i < dataRows.length; i++) {
    if (rows.length >= maxRows) {
      issues.push({
        rowNumber: i + 2,
        reason: "ragged-row",
        detail: `Stopped after ${maxRows} rows.`,
      });
      break;
    }
    const cells = dataRows[i];
    const rowNumber = i + 2;

    // A row shorter than the header is usually a wrapped line in the export.
    if (cells.length < headers.length) {
      issues.push({
        rowNumber,
        reason: "ragged-row",
        detail: `Row has ${cells.length} cells but the header has ${headers.length}.`,
      });
      previousBalanceMinor = null;
      continue;
    }

    const cell = (field: keyof ColumnMapping): string => {
      const header = mapping[field];
      if (!header) return "";
      const idx = headers.indexOf(header);
      return idx === -1 ? "" : (cells[idx] ?? "");
    };

    const dateRaw = cell("date");
    const parsedDate = parseCsvDate(dateRaw);
    if (!parsedDate) {
      issues.push({
        rowNumber,
        reason: "unparseable-date",
        detail: dateRaw.trim().length === 0 ? "Date is empty." : `Could not read "${dateRaw}".`,
      });
      previousBalanceMinor = null;
      continue;
    }

    const description = cell("description").trim();
    if (description.length === 0) {
      issues.push({
        rowNumber,
        reason: "missing-description",
        detail: "Description is empty.",
      });
      previousBalanceMinor = null;
      continue;
    }

    const debit = cell("debit");
    const credit = cell("credit");
    const amountCell = cell("amount");

    if (debit.trim() && credit.trim()) {
      const d = resolveRowAmount({ debit });
      const c = resolveRowAmount({ credit });
      if (d && c) {
        issues.push({
          rowNumber,
          reason: "ambiguous-amount",
          detail: "Both Debit and Credit have a non-zero value.",
        });
        previousBalanceMinor = null;
        continue;
      }
    }

    const amount = resolveRowAmount({ debit, credit, amount: amountCell || null });
    if (!amount) {
      const anyValue = debit.trim() || credit.trim() || amountCell.trim();
      issues.push({
        rowNumber,
        reason: anyValue ? "unparseable-amount" : "zero-amount",
        detail: anyValue
          ? `Could not read the amount ("${(debit || credit || amountCell).trim()}").`
          : "Row has no amount.",
      });
      previousBalanceMinor = null;
      continue;
    }

    const balanceRaw = cell("balance");
    const balanceParsed = balanceRaw.trim() ? parseAmountCell(balanceRaw) : null;
    const balanceMinor = balanceParsed ? Math.abs(balanceParsed.minor) : null;

    // Direction. A debit/credit column already states it; anything else goes
    // through the precedence chain in ./direction.ts.
    const resolved = resolveDirection({
      type: cell("type"),
      description,
      amount: amount.parsed,
      previousBalanceMinor,
      balanceMinor,
      assume,
    });

    const override = overrides[rowNumber];
    const direction: Direction = override ?? resolved.direction;
    // A user override is not an assumption, so it is never flagged.
    const needsDirectionConfirmation = override ? false : resolved.needsConfirmation;
    const directionSource: DirectionSource = override ? "amount_sign" : resolved.source;

    previousBalanceMinor = balanceMinor;

    rows.push({
      rowNumber,
      date: parsedDate.iso,
      description,
      amountMinor: amount.minor,
      direction,
      directionSource,
      needsDirectionConfirmation,
      looksLikeRefund: resolved.looksLikeRefund,
      balanceMinor,
      reference: cell("reference").trim() || null,
      accountNumber: cell("accountNumber").trim() || null,
    });
  }

  return {
    layoutId,
    layoutLabel,
    headers,
    mapping,
    ambiguous,
    needsMapping: false,
    missingRequired: [],
    rows,
    issues,
    totalRows: dataRows.length,
    assumedDirectionCount: rows.filter((r) => r.needsDirectionConfirmation).length,
  };
}
