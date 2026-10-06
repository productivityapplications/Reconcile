import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Button } from "../src/components/Button";
import { Card } from "../src/components/Card";
import { FormScaffold } from "../src/components/FormScaffold";
import { Text } from "../src/components/Text";
import {
  connectDemo,
  getAccounts,
  getActiveConnection,
  syncConnection,
  type BankAccount,
} from "../src/lib/db";
import { CSV_IMPORT_ENABLED, MONO_ENABLED } from "../src/lib/flags";
import { spacing } from "../src/theme/spacing";

export default function DemoScreen() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [syncInfo, setSyncInfo] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    const connection = await getActiveConnection();
    const list = connection ? await getAccounts() : [];
    return { connection, list };
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { connection, list } = await fetchData();
      setConnectionId(connection?.id ?? null);
      setAccounts(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load demo state.");
    } finally {
      setLoading(false);
    }
  }, [fetchData]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const { connection, list } = await fetchData();
        if (!active) return;
        setConnectionId(connection?.id ?? null);
        setAccounts(list);
      } catch (e) {
        if (!active) return;
        setError(e instanceof Error ? e.message : "Could not load demo state.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [fetchData]);

  const enter = async () => {
    setBusy(true);
    setError(null);
    setSyncInfo(null);
    try {
      const { connection } = await connectDemo();
      const result = await syncConnection(connection.id, "initial");
      setSyncInfo(`Synced ${result.seen} transactions, added ${result.added}.`);
      router.replace("/home");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Demo setup failed.");
    } finally {
      setBusy(false);
    }
  };

  const syncNow = async () => {
    if (!connectionId) return;
    setBusy(true);
    setError(null);
    try {
      const result = await syncConnection(connectionId, "manual");
      setSyncInfo(
        `Synced ${result.seen} transactions, added ${result.added}. ` +
          `${result.internal_transfer_pairs} internal transfer pair(s) detected.`,
      );
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sync failed.");
    } finally {
      setBusy(false);
    }
  };

  const connected = connectionId !== null;

  return (
    <FormScaffold
      titleFirst="Try"
      titleSecond="Demo."
      subtitle={
        connected
          ? "Demo data is synthetic. No real bank is connected."
          : "See Reconcile with sample Nigerian bank data. No real accounts connected."
      }
      ctaTitle={connected ? "Continue to Home" : "Enter Demo Mode"}
      onCta={connected ? () => router.push("/home") : enter}
      ctaDisabled={busy || loading}
      ctaLoading={busy}
      testID="demo"
    >
      <Card variant="mist" testID="demo-includes">
        <Text role="small" color="ink" style={{ fontWeight: "600" }}>
          Demo includes
        </Text>
        <Text role="body" color="ink" style={{ marginTop: spacing.sm }}>
          GTBank, UBA, and Sterling accounts with around 55 sample transactions.
        </Text>
      </Card>
      {connected ? (
        <View style={{ marginTop: spacing.md }}>
          <Text role="small" color="ink" style={{ fontWeight: "600" }}>
            Demo accounts:
          </Text>
          {accounts.length === 0 ? (
            <Text role="body" color="ink">
              No accounts yet.
            </Text>
          ) : null}
          {accounts.map((a) => (
            <Text key={a.id} role="body" color="ink">
              {a.display_name} {a.masked_account_number}
            </Text>
          ))}
          {syncInfo ? (
            <Text role="body" color="ink" style={{ marginTop: spacing.sm }}>
              {syncInfo}
            </Text>
          ) : null}
          {error ? (
            <Text role="body" color="ink" style={{ marginTop: spacing.sm }}>
              {error}
            </Text>
          ) : null}
          <View style={{ marginTop: spacing.md }}>
            <Button
              title={busy ? "Syncing..." : "Sync now"}
              variant="secondary"
              onPress={syncNow}
              disabled={busy}
              loading={busy}
              testID="demo-sync"
            />
          </View>
        </View>
      ) : null}
      {!connected && error ? (
        <Text role="body" color="ink" style={{ marginTop: spacing.md }}>
          {error}
        </Text>
      ) : null}
      {loading ? (
        <Text role="body" color="ink" style={{ marginTop: spacing.md }}>
          Loading demo state...
        </Text>
      ) : null}
      <View style={{ marginTop: spacing.md }}>
        <Button
          title="Connect a real bank"
          variant="ghost"
          disabled={!MONO_ENABLED}
          onPress={MONO_ENABLED ? () => router.push("/connect-bank") : undefined}
          accessibilityLabel={
            MONO_ENABLED
              ? "Connect a real bank"
              : "Connect a real bank, coming soon"
          }
          testID="demo-connect"
        />
        <Text role="small" color="ink" style={{ opacity: 0.6, textAlign: "center" }}>
          {MONO_ENABLED ? "Powered by Mono" : "Coming soon"}
        </Text>
      </View>
      {/* Phase 12: CSV import is the primary data path while Mono live keys are
          pending, so it is offered alongside the hosted connection. */}
      {CSV_IMPORT_ENABLED ? (
        <View style={{ marginTop: spacing.sm }}>
          <Button
            title="Import a bank CSV"
            variant="ghost"
            onPress={() => router.push("/import-csv")}
            accessibilityLabel="Import a bank CSV"
            testID="demo-import-csv"
          />
        </View>
      ) : null}
    </FormScaffold>
  );
}
