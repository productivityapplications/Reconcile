// CSV import — Phase 12.
//
// Flow: choose a file -> read it in the client -> preview (server-side parse,
// nothing written) -> optionally map columns -> commit -> summary.
//
// The file's contents travel to the Edge Function in the request body and are
// never stored. No bank credentials are read or accepted: a statement export
// never contains them, and there is no field for them.
//
// The screen never claims to know which bank a file came from. Parsing is
// layout-based, so the preview says which columns it recognised and the user
// supplies the account name. That keeps the screen honest: it states what the
// parser actually resolved.
//
// Column mapping, when shown, is a plain list of the file's real headers with
// one choice per role, using the existing Chip primitive. No new primitives or
// organisms are introduced.

import { useRouter } from "expo-router";
import * as DocumentPicker from "expo-document-picker";
import { useCallback, useMemo, useState } from "react";
import { View } from "react-native";
import { Button } from "../src/components/Button";
import { Card } from "../src/components/Card";
import { Chip } from "../src/components/Chip";
import { Divider } from "../src/components/Divider";
import { Input } from "../src/components/Input";
import { ScreenScaffold } from "../src/components/ScreenScaffold";
import { Text } from "../src/components/Text";
import { TransactionRow } from "../src/components/TransactionRow";
import {
  importCsv,
  previewCsv,
  type CsvColumnMapping,
  type CsvImportResult,
  type CsvPreviewResult,
  type CsvSampleRow,
} from "../src/lib/db";
import { CSV_IMPORT_ENABLED } from "../src/lib/flags";
import { spacing } from "../src/theme/spacing";

type Step = "pick" | "preview" | "mapping" | "done";
type Direction = "debit" | "credit";

/** Roles the mapping UI can set, in the order they are shown. */
const ROLES: { key: keyof CsvColumnMapping; label: string; hint: string }[] = [
  { key: "date", label: "Date", hint: "Required." },
  { key: "description", label: "Description", hint: "Required." },
  { key: "debit", label: "Debit", hint: "Money out." },
  { key: "credit", label: "Credit", hint: "Money in." },
  { key: "amount", label: "Amount", hint: "Use instead of Debit/Credit." },
];

/**
 * Why a row's direction is what it is, in the user's terms.
 *
 * "expense"/"income" would be enough to render the row, but the user needs to
 * know which rows to trust: a direction read straight out of the file is a fact,
 * while one inferred from the balance is a judgement worth checking.
 */
function sourceNote(row: CsvSampleRow): string | null {
  if (!row.needsDirectionConfirmation) return null;
  if (row.directionSource === "balance") return "from balance";
  if (row.directionSource === "assumed") {
    return row.direction === "debit" ? "assumed expense" : "assumed income";
  }
  return null;
}

export default function ImportCsvScreen() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("pick");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [csvContent, setCsvContent] = useState("");
  const [accountLabel, setAccountLabel] = useState("");
  const [preview, setPreview] = useState<CsvPreviewResult | null>(null);
  const [result, setResult] = useState<CsvImportResult | null>(null);
  const [mapping, setMapping] = useState<CsvColumnMapping>({});
  /** Bulk direction for rows nothing resolved. Defaults to expense. */
  const [assume, setAssume] = useState<Direction>("debit");
  /** Per-row decisions from tapping a preview row. */
  const [overrides, setOverrides] = useState<Record<number, Direction>>({});

  const headers = useMemo(() => preview?.headers ?? [], [preview]);

  /** Sample rows with the user's overrides and bulk choice applied. */
  const rows = useMemo<CsvSampleRow[]>(() => {
    const sample = preview?.sample ?? [];
    return sample.map((row) => {
      const override = overrides[row.rowNumber];
      if (!override) return row;
      return { ...row, direction: override, needsDirectionConfirmation: false };
    });
  }, [overrides, preview]);

  // ---- file selection ---------------------------------------------------

  const onPicked = useCallback(
    async (name: string, content: string, label?: string) => {
      setError(null);
      setFileName(name);
      setCsvContent(content);
      setBusy(true);
      try {
        const previewed = await previewCsv({
          fileName: name,
          csvContent: content,
          accountLabel: label?.trim() || undefined,
        });
        setPreview(previewed);
        setAssume("debit");
        setOverrides({});
        if (previewed.needsMapping) {
          // Prefill from the file's own header names so the common case needs one
          // tap rather than a full manual mapping.
          setMapping(suggestFromHeaders(previewed.headers ?? []));
          setStep("mapping");
        } else {
          setStep("preview");
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not read that file.");
        setStep("pick");
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const pickFile = useCallback(async () => {
    setError(null);
    try {
      const picked = await DocumentPicker.getDocumentAsync({
        type: ["text/csv", "text/comma-separated-values", "text/plain", "*/*"],
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (picked.canceled || !picked.assets?.[0]) return;
      const asset = picked.assets[0];
      const content = await readAssetText(asset);
      await onPicked(asset.name ?? "statement.csv", content, accountLabel);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open that file.");
    }
  }, [accountLabel, onPicked]);

  // ---- actions ----------------------------------------------------------

  /**
   * Re-preview, passing the mapping this time.
   *
   * The mapping has to be included, otherwise the server recognises nothing
   * again and the screen loops on the mapping step forever.
   */
  const retryPreview = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const previewed = await previewCsv({
        fileName,
        csvContent,
        accountLabel: accountLabel.trim() || undefined,
        mapping,
        assume,
      });
      setPreview(previewed);
      setAssume("debit");
      setOverrides({});
      setStep(previewed.needsMapping ? "mapping" : "preview");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read that file.");
    } finally {
      setBusy(false);
    }
  }, [accountLabel, assume, csvContent, fileName, mapping]);

  const commit = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const imported = await importCsv({
        fileName,
        csvContent,
        accountLabel: accountLabel.trim() || undefined,
        mapping,
        assume,
        directionOverrides: overrides,
      });
      setResult(imported);
      setStep("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not import that file.");
    } finally {
      setBusy(false);
    }
  }, [accountLabel, assume, csvContent, fileName, mapping, overrides]);

  const startOver = useCallback(() => {
    setStep("pick");
    setFileName("");
    setCsvContent("");
    setPreview(null);
    setResult(null);
    setMapping({});
    setAssume("debit");
    setOverrides({});
    setError(null);
  }, []);

  /** Tap a preview row to flip its direction. */
  const flipRow = useCallback((rowNumber: number, current: string) => {
    setOverrides((existing) => ({
      ...existing,
      [rowNumber]: current === "credit" ? "debit" : "credit",
    }));
  }, []);

  /**
   * Rows no signal resolved, so the bulk choice actually applies to them.
   *
   * Counted separately from the weak-signal total on purpose: the bulk choice
   * must not move a row the balance already proved, so the toggle is only
   * offered when there are genuinely signal-less rows to apply it to.
   */
  const defaultedCount = useMemo(
    () => rows.filter((r) => r.directionSource === "assumed").length,
    [rows],
  );

  /**
   * Every row whose direction is not a stated fact: balance-derived ones and
   * defaulted ones. These are the rows worth the user's attention, and the
   * per-row tap override is available on all of them.
   */
  const weakCount = useMemo(
    () => rows.filter((r) => r.needsDirectionConfirmation).length,
    [rows],
  );

  if (!CSV_IMPORT_ENABLED) {
    return (
      <ScreenScaffold
        titleFirst="Import"
        titleSecond="a CSV."
        onBack={() => router.back()}
        testID="import-csv"
      >
        <Card variant="paper" testID="import-csv-disabled">
          <Text role="body" color="ink">
            CSV import is not available in this build.
          </Text>
        </Card>
      </ScreenScaffold>
    );
  }

  return (
    <ScreenScaffold
      titleFirst="Import"
      titleSecond="a CSV."
      onBack={() => router.back()}
      testID="import-csv"
    >
      {error ? (
        <View style={{ marginBottom: spacing.md }}>
          <Card variant="paper" testID="import-csv-error">
            <Text role="body" color="ink">
              {error}
            </Text>
            <View style={{ marginTop: spacing.md }}>
              <Button
                title="Try another file"
                variant="secondary"
                onPress={startOver}
                testID="import-csv-retry"
              />
            </View>
          </Card>
        </View>
      ) : null}

      {/* ---- pick ------------------------------------------------------ */}
      {step === "pick" ? (
        <View>
          <Card variant="paper" testID="import-csv-pick">
            <Text role="body" color="ink">
              Choose a statement CSV exported from your bank. Reconcile reads
              the date, description and amounts, and never sees your bank
              password.
            </Text>
            <View style={{ marginTop: spacing.lg }}>
              <Input
                label="Account name"
                value={accountLabel}
                onChangeText={setAccountLabel}
                placeholder={defaultLabelFor(fileName) || "e.g. GTBank Personal"}
                testID="import-csv-label"
              />
            </View>
            <View style={{ marginTop: spacing.lg }}>
              <Button
                title={busy ? "Reading..." : "Choose a CSV file"}
                onPress={pickFile}
                disabled={busy}
                loading={busy}
                testID="import-csv-choose"
              />
            </View>
            <View style={{ marginTop: spacing.md }}>
              <Text role="small" color="ink" style={{ opacity: 0.7 }}>
                The name you give here is how this account appears in Reconcile.
                We read the columns and amounts, never your bank password.
              </Text>
            </View>
          </Card>
          <View style={{ marginTop: spacing.md }}>
            <Text role="small" color="ink" style={{ opacity: 0.7 }}>
              Imports are limited to 10 files an hour. Re-importing the same
              file adds nothing new.
            </Text>
          </View>
        </View>
      ) : null}

      {/* ---- preview --------------------------------------------------- */}
      {step === "preview" && preview ? (
        <View testID="import-csv-preview">
          <Card variant="paper" testID="import-csv-summary">
            <Text role="body" color="ink" style={{ fontWeight: "600" }}>
              {preview.layoutLabel
                ? `Columns read: ${preview.layoutLabel}`
                : "Columns read"}
            </Text>
            <View style={{ marginTop: spacing.xs }}>
              <Text role="small" color="ink" style={{ opacity: 0.7 }}>
                We do not detect which bank this is from. Name the account
                below and we will use that.
              </Text>
            </View>
            <Divider style={{ marginVertical: spacing.sm }} />
            <SummaryRow label="Rows in file" value={String(preview.totalRows ?? 0)} />
            <SummaryRow label="Will be added" value={String(preview.added ?? 0)} />
            <SummaryRow label="Already imported" value={String(preview.duplicates ?? 0)} />
            {(preview.issueCount ?? 0) > 0 ? (
              <SummaryRow label="Rows we skipped" value={String(preview.issueCount)} />
            ) : null}
          </Card>

          {preview.ambiguousLayout ? (
            <View style={{ marginTop: spacing.md }}>
              <Text role="small" color="ink" style={{ opacity: 0.7 }}>
                This header row matches more than one layout we know. The columns
                are read the same way either way.
              </Text>
            </View>
          ) : null}

          {(preview.issueCount ?? 0) > 0 ? (
            <View style={{ marginTop: spacing.md }}>
              {preview.issues?.slice(0, 3).map((i) => (
                <Text key={`${i.rowNumber}-${i.reason}`} role="small" color="ink" style={{ opacity: 0.7 }}>
                  {`Line ${i.rowNumber}: ${i.detail}`}
                </Text>
              ))}
            </View>
          ) : null}

          {/* Rows whose direction we had to work out. Shown first, because
              these are the rows the user should look at before importing. */}
          {weakCount > 0 ? (
            <View style={{ marginTop: spacing.lg }} testID="import-csv-assumed">
              <Text
                role="small"
                color="ink"
                style={{ fontWeight: "600", marginBottom: spacing.xs }}
              >
                {weakCount} row{weakCount === 1 ? "" : "s"} we had to work out
              </Text>
              <Text role="small" color="ink" style={{ opacity: 0.7 }}>
                This file does not always say whether money came in or went out.
                We read it from the running balance where we can, and otherwise
                assume money out. Tap any row to change it.
              </Text>
              {defaultedCount > 0 ? (
                <>
                  <Text
                    role="small"
                    color="ink"
                    style={{ marginTop: spacing.md, fontWeight: "600" }}
                  >
                    For the {defaultedCount} row
                    {defaultedCount === 1 ? "" : "s"} with no direction signal:
                  </Text>
                  <Text
                    role="small"
                    color="ink"
                    style={{ marginTop: spacing.xxs, opacity: 0.7 }}
                  >
                    This applies only to those rows. Rows taken from the balance
                    or a DR/CR marker keep their direction.
                  </Text>
                </>
              ) : null}
              <View
                style={{
                  flexDirection: "row",
                  gap: spacing.sm,
                  marginTop: spacing.xs,
                }}
              >
                <Button
                  title="Treat as expense"
                  variant={assume === "debit" ? "primary" : "secondary"}
                  onPress={() => setAssume("debit")}
                  testID="import-csv-assume-debit"
                />
                <Button
                  title="Treat as income"
                  variant={assume === "credit" ? "primary" : "secondary"}
                  onPress={() => setAssume("credit")}
                  testID="import-csv-assume-credit"
                />
              </View>
            </View>
          ) : null}

          {rows.length > 0 ? (
            <View style={{ marginTop: spacing.lg }} testID="import-csv-sample">
              <Text
                role="small"
                color="ink"
                style={{ fontWeight: "600", marginBottom: spacing.xs }}
              >
                First rows
              </Text>
              {weakCount > 0 ? (
                <Text
                  role="small"
                  color="ink"
                  style={{ opacity: 0.7, marginBottom: spacing.xs }}
                >
                  Tap any row to switch money in or money out.
                </Text>
              ) : null}
              {rows.map((row) => {
                const note = sourceNote(row);
                return (
                  <View key={row.rowNumber}>
                    <TransactionRow
                      merchant={row.description}
                      date={row.date}
                      amount={row.amountMinor}
                      currency="NGN"
                      category={row.direction === "credit" ? "Income" : "Shopping"}
                      direction={row.direction === "credit" ? "income" : "expense"}
                      surface="light"
                      onPress={() => flipRow(row.rowNumber, row.direction)}
                      testID={`import-csv-sample-${row.rowNumber}`}
                    />
                    {note ? (
                      <Text
                        role="small"
                        color="ink"
                        style={{ opacity: 0.6, marginBottom: spacing.xs }}
                      >
                        {note}
                      </Text>
                    ) : null}
                  </View>
                );
              })}
            </View>
          ) : null}

          <View style={{ marginTop: spacing.lg, gap: spacing.sm }}>
            <Input
              label="Account name"
              value={accountLabel}
              onChangeText={setAccountLabel}
              placeholder={defaultLabelFor(fileName) || "e.g. GTBank Personal"}
              testID="import-csv-preview-label"
            />
            <Button
              title={
                (preview.added ?? 0) === 0
                  ? "Nothing new to add"
                  : `Import ${preview.added} transaction${preview.added === 1 ? "" : "s"}`
              }
              onPress={commit}
              disabled={busy || (preview.added ?? 0) === 0}
              loading={busy}
              testID="import-csv-commit"
            />
            <Button
              title="Choose a different file"
              variant="ghost"
              onPress={startOver}
              testID="import-csv-again"
            />
          </View>
        </View>
      ) : null}

      {/* ---- column mapping -------------------------------------------- */}
      {step === "mapping" && preview ? (
        <View testID="import-csv-mapping">
          <Card variant="paper" testID="import-csv-mapping-card">
            <Text role="body" color="ink" style={{ fontWeight: "600" }}>
              Map the columns
            </Text>
            <Text role="small" color="ink" style={{ marginTop: spacing.xs, opacity: 0.7 }}>
              These column names are not one we recognise. Tell us which is which
              and we will read the file.
            </Text>
          </Card>

          {ROLES.map((role) => (
            <View key={role.key} style={{ marginTop: spacing.md }}>
              <Text role="small" color="ink" style={{ fontWeight: "600" }}>
                {role.label}
              </Text>
              <Text
                role="small"
                color="ink"
                style={{ opacity: 0.6, marginTop: spacing.xxs }}
              >
                {role.hint}
              </Text>
              <View
                style={{
                  flexDirection: "row",
                  flexWrap: "wrap",
                  marginTop: spacing.xs,
                  gap: spacing.xs,
                }}
              >
                {headers.map((header) => {
                  const selected = mapping[role.key] === header;
                  return (
                    <Chip
                      key={`${role.key}-${header}`}
                      label={header || "(blank)"}
                      selected={selected}
                      onPress={() =>
                        setMapping((current) => {
                          const next = { ...current };
                          if (selected) {
                            delete next[role.key];
                          } else {
                            next[role.key] = header;
                          }
                          // Choosing a single Amount column clears the pair, and
                          // vice versa, so the server never sees both.
                          if (role.key === "amount" && !selected) {
                            delete next.debit;
                            delete next.credit;
                          }
                          if (
                            (role.key === "debit" || role.key === "credit") &&
                            !selected
                          ) {
                            delete next.amount;
                          }
                          return next;
                        })
                      }
                      testID={`import-csv-map-${role.key}-${header}`}
                    />
                  );
                })}
              </View>
            </View>
          ))}

          <View style={{ marginTop: spacing.lg, gap: spacing.sm }}>
            <Input
              label="Account name"
              value={accountLabel}
              onChangeText={setAccountLabel}
              placeholder={defaultLabelFor(fileName) || "e.g. GTBank Personal"}
              testID="import-csv-mapping-label"
            />
            <Button
              title="Check the file"
              onPress={retryPreview}
              disabled={busy}
              loading={busy}
              testID="import-csv-map-continue"
            />
            <Button
              title="Cancel"
              variant="ghost"
              onPress={startOver}
              testID="import-csv-map-cancel"
            />
          </View>
        </View>
      ) : null}

      {/* ---- done ------------------------------------------------------- */}
      {step === "done" && result ? (
        <View testID="import-csv-done">
          <Card variant="paper" testID="import-csv-done-card">
            <Text role="body" color="ink" style={{ fontWeight: "600" }}>
              Imported {result.added} transaction{result.added === 1 ? "" : "s"}
            </Text>
            <Divider style={{ marginVertical: spacing.sm }} />
            <SummaryRow label="Account" value={result.accountLabel} />
            <SummaryRow label="Rows read" value={String(result.parsed)} />
            {result.skipped > 0 ? (
              <SummaryRow label="Already had" value={String(result.skipped)} />
            ) : null}
            {result.rejected > 0 ? (
              <SummaryRow label="Skipped" value={String(result.rejected)} />
            ) : null}
          </Card>
          <View style={{ marginTop: spacing.lg, gap: spacing.sm }}>
            <Button
              title="View in Activity"
              onPress={() => router.replace("/activity")}
              testID="import-csv-activity"
            />
            <Button
              title="Import another file"
              variant="ghost"
              onPress={startOver}
              testID="import-csv-another"
            />
          </View>
        </View>
      ) : null}
    </ScreenScaffold>
  );
}

// -------------------------------------------------------------- helpers

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <View
      style={{
        flexDirection: "row",
        justifyContent: "space-between",
        paddingVertical: spacing.xxs,
      }}
    >
      <Text role="body" color="ink" style={{ opacity: 0.7 }}>
        {label}
      </Text>
      <Text role="body" color="ink" style={{ fontWeight: "600" }}>
        {value}
      </Text>
    </View>
  );
}

/**
 * Mirror of the server's `suggestMapping`, kept tiny and local so the mapping
 * screen can fill itself in without a round trip. The server still validates
 * whatever the user confirms, so a wrong guess here costs one correction rather
 * than a wrong import.
 */
function suggestFromHeaders(headers: string[]): CsvColumnMapping {
  const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");
  const find = (patterns: RegExp[]): string | undefined => {
    for (const pattern of patterns) {
      const hit = headers.find((h) => pattern.test(norm(h)));
      if (hit) return hit;
    }
    return undefined;
  };

  const mapping: CsvColumnMapping = {};
  const date = find([/^transactiondate$/, /^valuedate$/, /^date$/, /date$/, /time/]);
  if (date) mapping.date = date;
  const description = find([
    /^description$/,
    /^narration$/,
    /^narrative$/,
    /^details$/,
    /^particulars$/,
    /^memo$/,
    /narrat/,
    /descript/,
  ]);
  if (description) mapping.description = description;
  const debit = find([/^debit$/, /debit/, /withdraw/, /paidout/, /^moneyout$/, /moneyout/]);
  if (debit) mapping.debit = debit;
  const credit = find([/^credit$/, /credit/, /deposit/, /paidin/, /^moneyin$/, /moneyin/]);
  if (credit) mapping.credit = credit;
  if (!debit && !credit) {
    const amount = find([/^amount$/, /^transactionamount$/, /amount/, /^value$/]);
    if (amount) mapping.amount = amount;
  }
  return mapping;
}

function defaultLabelFor(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ").trim();
  return cleaned;
}

/**
 * Read a picked file.
 *
 * `expo-file-system` is not a dependency of this app, so on native the asset is
 * read via fetch over its content URI, which the document picker provides and
 * which works for local files. On web the picker hands back a real `File`.
 */
async function readAssetText(asset: DocumentPicker.DocumentPickerAsset): Promise<string> {
  const file = (asset as { file?: File }).file;
  if (file && typeof file.text === "function") return await file.text();
  if (asset.uri) {
    const response = await fetch(asset.uri);
    if (!response.ok) throw new Error("We could not read that file.");
    return await response.text();
  }
  throw new Error("We could not read that file.");
}

