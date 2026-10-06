import { Link, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import Constants from "expo-constants";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ChevronRight, CircleUser, CreditCard, Info, LogOut, Shield, Upload } from "lucide-react-native";
import { Avatar } from "../src/components/Avatar";
import { Button } from "../src/components/Button";
import { Card } from "../src/components/Card";
import { EmptyState } from "../src/components/EmptyState";
import { ErrorState } from "../src/components/ErrorState";
import { LoadingState } from "../src/components/LoadingState";
import { PillNav, pillNavClearance } from "../src/components/PillNav";
import { ScreenScaffold } from "../src/components/ScreenScaffold";
import { Text } from "../src/components/Text";
import {
  pickAvatarImage,
  removeAvatarObjects,
  uploadAvatarImage,
} from "../src/lib/avatar";
import {
  disconnectConnection,
  getAccounts,
  getCurrentConnection,
  getProfile,
  needsReauth,
  setAvatarUrl,
  type BankAccount,
  type UserProfile,
} from "../src/lib/db";
import { useSession } from "../src/lib/session";
import { CSV_IMPORT_ENABLED, MONO_ENABLED } from "../src/lib/flags";
import { colors } from "../src/theme/colors";
import { radius } from "../src/theme/radius";
import { spacing } from "../src/theme/spacing";

const PILL_ROUTES = {
  home: "/home",
  activity: "/activity",
  budget: "/budget",
  insights: "/insights",
} as const;

function SettingRow({
  icon,
  label,
  hint,
  onPress,
  testID,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  onPress?: () => void;
  testID?: string;
}) {
  const content = (
    <>
      {icon}
      <View style={{ flex: 1, marginLeft: spacing.md }}>
        <Text role="body" color="ink" style={{ fontWeight: "500" }} numberOfLines={1}>
          {label}
        </Text>
        {hint ? (
          <Text role="small" color="ink" style={{ opacity: 0.6 }}>
            {hint}
          </Text>
        ) : null}
      </View>
      <ChevronRight size={20} color={colors.ink} strokeWidth={1.5} />
    </>
  );
  const style = {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    paddingVertical: spacing.sm,
    // design.md §10: settings rows are press targets — 44×44 minimum.
    // alignItems keeps content vertically centered in the taller row.
    minHeight: 44,
  };
  if (!onPress) {
    return (
      <View testID={testID} style={style}>
        {content}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      testID={testID}
      style={style}
    >
      {content}
    </Pressable>
  );
}

export default function SettingsScreen() {
  const { session, signOut } = useSession();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [reauthRequired, setReauthRequired] = useState(false);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [busy, setBusy] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    // Phase 11: read the connection regardless of status, so a connection the
    // bank has marked reauth_required is visible instead of silently absent.
    const connection = await getCurrentConnection();
    const list = connection ? await getAccounts() : [];
    const userProfile = await getProfile();
    return { connection, list, userProfile };
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { connection, list, userProfile } = await fetchData();
      setConnectionId(connection?.id ?? null);
      setReauthRequired(needsReauth(connection));
      setAccounts(list);
      setProfile(userProfile);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load settings.");
    } finally {
      setLoading(false);
    }
  }, [fetchData]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const { connection, list, userProfile } = await fetchData();
        if (!active) return;
        setConnectionId(connection?.id ?? null);
        setReauthRequired(needsReauth(connection));
        setAccounts(list);
        setProfile(userProfile);
      } catch (e) {
        if (!active) return;
        setError(e instanceof Error ? e.message : "Could not load settings.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [fetchData]);

  const disconnect = async () => {
    if (!connectionId) return;
    setBusy(true);
    setError(null);
    try {
      await disconnectConnection(connectionId);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Disconnect failed.");
    } finally {
      setBusy(false);
    }
  };

  const out = async () => {
    await signOut();
    router.replace("/welcome");
  };

  const changePhoto = async () => {
    if (photoBusy) return;
    setPhotoError(null);
    try {
      const localUri = await pickAvatarImage();
      if (!localUri) return;
      if (!profile) {
        setPhotoError("Please sign in and try again.");
        return;
      }
      setPhotoBusy(true);
      const publicUrl = await uploadAvatarImage(profile.id, localUri);
      await setAvatarUrl(publicUrl);
      await refresh();
    } catch (e) {
      setPhotoError(e instanceof Error ? e.message : "Photo update failed.");
    } finally {
      setPhotoBusy(false);
    }
  };

  const removePhoto = async () => {
    if (photoBusy || !profile) return;
    setPhotoError(null);
    setPhotoBusy(true);
    try {
      await removeAvatarObjects(profile.id);
      await setAvatarUrl(null);
      await refresh();
    } catch (e) {
      setPhotoError(e instanceof Error ? e.message : "Photo removal failed.");
    } finally {
      setPhotoBusy(false);
    }
  };

  const version = Constants.expoConfig?.version ?? "0.1.0";

  if (loading) {
    return (
      <ScreenScaffold titleFirst="Your" titleSecond="Settings" testID="settings">
        <LoadingState variant="row-list" testID="settings-loading" />
      </ScreenScaffold>
    );
  }

  if (error) {
    return (
      <ScreenScaffold titleFirst="Your" titleSecond="Settings" testID="settings">
        <ErrorState message={error} onRetry={refresh} testID="settings-error" />
      </ScreenScaffold>
    );
  }

  return (
    <ScreenScaffold titleFirst="Your" titleSecond="Settings" scroll={false} testID="settings">
      <View style={{ flex: 1 }}>
        {/* Phase 10A.5: content scrolls so the sign-out row stays
          reachable above the pill nav on short screens; the bottom
          padding is the measured pill clearance, not a guess. */}
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: pillNavClearance(insets.bottom) }}
          testID="settings-scroll"
        >
          <Text role="small" color="ink" style={{ fontWeight: "600", marginTop: spacing.md }}>
            Profile
          </Text>
          <Card variant="paper" compact testID="settings-profile-photo">
            <View style={{ flexDirection: "row", alignItems: "center" }}>
              <Avatar
                displayName={session?.user.email ?? "Signed in"}
                size={64}
                uri={profile?.avatar_url ?? undefined}
                testID="settings-avatar"
              />
              <View style={{ flex: 1, marginLeft: spacing.md }}>
                <Button
                  title={photoBusy ? "Working..." : "Change photo"}
                  variant="secondary"
                  onPress={changePhoto}
                  disabled={photoBusy}
                  loading={photoBusy}
                  testID="settings-photo-change"
                />
                {profile?.avatar_url ? (
                  <View style={{ marginTop: spacing.sm }}>
                    <Button
                      title="Remove"
                      variant="ghost"
                      onPress={removePhoto}
                      disabled={photoBusy}
                      testID="settings-photo-remove"
                    />
                  </View>
                ) : null}
              </View>
            </View>
            {photoError ? (
              <Text
                role="body"
                color="ink"
                style={{ marginTop: spacing.sm }}
                testID="settings-photo-error"
              >
                {photoError}
              </Text>
            ) : null}
          </Card>
          <Text role="small" color="ink" style={{ fontWeight: "600", marginTop: spacing.md }}>
            Account
          </Text>
          <Card variant="paper" compact testID="settings-account">
            <SettingRow
              icon={<CircleUser size={20} color={colors.ink} strokeWidth={1.5} />}
              label={session?.user.email ?? "Signed in"}
              hint={
                accounts.length > 0
                  ? `${accounts.length} connected account${accounts.length === 1 ? "" : "s"}`
                  : "No connected accounts"
              }
              testID="settings-profile"
            />
            {connectionId ? (
              <SettingRow
                icon={<CircleUser size={20} color={colors.ink} strokeWidth={1.5} />}
                label={busy ? "Disconnecting..." : "Disconnect demo accounts"}
                onPress={busy ? undefined : disconnect}
                testID="settings-disconnect"
              />
            ) : null}
          </Card>
          {/* Phase 12: CSV import entry point. */}
          {CSV_IMPORT_ENABLED ? (
            <Card variant="paper" testID="settings-import">
              <SettingRow
                icon={<Upload size={20} color={colors.ink} strokeWidth={1.5} />}
                label="Import a bank CSV"
                hint="Add transactions from a statement export"
                onPress={() => router.push("/import-csv")}
                testID="settings-import-csv"
              />
            </Card>
          ) : null}
          {/* Phase 11: the bank has lapsed its consent. Say so plainly and
              offer the reconnect path, rather than leaving the account listed
              as if it were still live. */}
          {reauthRequired ? (
            <Card variant="paper" testID="settings-reauth">
              <Text role="body" color="ink" style={{ fontWeight: "600" }}>
                Reconnect your bank
              </Text>
              <Text role="small" color="ink" style={{ marginTop: spacing.xs, opacity: 0.7 }}>
                Your bank needs you to approve access again before we can keep
                your transactions up to date.
              </Text>
              {MONO_ENABLED ? (
                <View style={{ marginTop: spacing.md }}>
                  <Button
                    title="Reconnect"
                    variant="secondary"
                    onPress={() => router.push("/connect-bank")}
                    testID="settings-reconnect"
                  />
                </View>
              ) : null}
            </Card>
          ) : null}
          <Text role="small" color="ink" style={{ fontWeight: "600", marginTop: spacing.md }}>
            Privacy
          </Text>
          <Card variant="paper" compact testID="settings-privacy">
            <Link href="/privacy" testID="settings-privacy-link">
              <SettingRow
                icon={<Shield size={20} color={colors.ink} strokeWidth={1.5} />}
                label="What Reconcile can see"
              />
            </Link>
          </Card>
          <Text role="small" color="ink" style={{ fontWeight: "600", marginTop: spacing.md }}>
            Subscription
          </Text>
          <Card variant="paper" compact testID="settings-subscription">
            <SettingRow
              icon={<CreditCard size={20} color={colors.ink} strokeWidth={1.5} />}
              label="Reconcile Pro"
              hint="Coming soon"
              testID="settings-pro"
            />
          </Card>
          <Text role="small" color="ink" style={{ fontWeight: "600", marginTop: spacing.md }}>
            About
          </Text>
          <Card variant="paper" compact testID="settings-about">
            <SettingRow
              icon={<Info size={20} color={colors.ink} strokeWidth={1.5} />}
              label={`Version ${version}`}
              testID="settings-version"
            />
            <Link
              href="https://github.com/onyebuchidaniel60/Reconcile"
              testID="settings-opensource"
              style={{ paddingVertical: spacing.lg }}
            >
              <Text role="body" color="ink">
                Open source
              </Text>
            </Link>
            <Link
              href="https://github.com/onyebuchidaniel60/Reconcile/issues"
              testID="settings-issues"
              style={{ paddingVertical: spacing.lg }}
            >
              <Text role="body" color="ink">
                Report an issue
              </Text>
            </Link>
          </Card>
          <View style={{ marginTop: spacing.md }}>
            <Card variant="coral" compact testID="settings-signout-card">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Sign out"
                onPress={out}
                testID="settings-signout"
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  borderRadius: radius.chip,
                  minHeight: 44,
                }}
              >
                <LogOut size={20} color={colors.ink} strokeWidth={1.5} />
                <Text
                  role="body"
                  color="ink"
                  style={{ fontWeight: "600", marginLeft: spacing.md }}
                >
                  Sign out
                </Text>
              </Pressable>
            </Card>
          </View>
          {accounts.length === 0 && !connectionId ? (
            <EmptyState
              message="No banks connected. Demo data is available from Demo Mode."
              testID="settings-empty"
            />
          ) : null}
        </ScrollView>
        <PillNav
          active={null}
          onNavigate={(route) => router.push(PILL_ROUTES[route])}
          testID="settings-pill"
        />
      </View>
    </ScreenScaffold>
  );
}
