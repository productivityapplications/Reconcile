import {
  Inter_300Light,
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  Inter_800ExtraBold,
  useFonts,
} from "@expo-google-fonts/inter";
import { Stack, useRouter, useSegments } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { Text, View } from "react-native";
import { ErrorBoundary } from "../src/components/ErrorBoundary";
import { SessionProvider, useSession } from "../src/lib/session";

void SplashScreen.preventAutoHideAsync();

const PUBLIC_ROUTES = ["welcome", "privacy", "country", "signup", "signin"];

function AuthGate({ children }: { children: React.ReactNode }) {
  const { configured, session, loading } = useSession();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (loading || !configured) return;
    const root: string = segments[0] ?? "";
    const isPublic = PUBLIC_ROUTES.includes(root) || root === "";
    if (!session && !isPublic) {
      router.replace("/welcome");
    } else if (session && (root === "" || PUBLIC_ROUTES.includes(root))) {
      router.replace("/demo");
    }
  }, [loading, configured, session, segments, router]);

  if (!configured) {
    return (
      <View>
        <Text>Configuration missing</Text>
        <Text>Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY.</Text>
      </View>
    );
  }
  if (loading) {
    return (
      <View>
        <Text>Loading...</Text>
      </View>
    );
  }
  return <>{children}</>;
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_300Light,
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    Inter_800ExtraBold,
  });

  useEffect(() => {
    if (fontsLoaded || fontError) {
      void SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  // Phase 3 loads Inter without restyling any screen; the demo renders in
  // the system font until Inter arrives, then swaps. Font failure falls
  // through to the system stack rather than blocking the app.
  if (!fontsLoaded && !fontError) {
    return null;
  }
  return (
    <ErrorBoundary>
      <SessionProvider>
        <AuthGate>
          <StatusBar style="auto" />
          <Stack>
            <Stack.Screen name="index" options={{ title: "Reconcile" }} />
            <Stack.Screen name="welcome" options={{ title: "Welcome" }} />
            <Stack.Screen name="privacy" options={{ title: "Privacy" }} />
            <Stack.Screen name="country" options={{ title: "Country" }} />
            <Stack.Screen name="signup" options={{ title: "Sign up" }} />
            <Stack.Screen name="signin" options={{ title: "Sign in" }} />
            <Stack.Screen name="demo" options={{ title: "Demo Mode" }} />
      <Stack.Screen name="connect-bank" options={{ title: "Connect a bank" }} />
      <Stack.Screen name="import-csv" options={{ title: "Import a CSV" }} />
            {/* Phase 10A.5: Home and Review render their own header rows
              inside DarkScreenScaffold (avatar/actions/greeting); the
              native Stack header would paint a light bar above the ink
              surface, so it stays hidden on these two routes only. */}
            <Stack.Screen
              name="home"
              options={{ title: "Home", headerShown: false }}
            />
            <Stack.Screen
              name="review"
              options={{ title: "Review", headerShown: false }}
            />
            <Stack.Screen
              name="transaction/[id]"
              options={{ title: "Transaction" }}
            />
            <Stack.Screen name="activity" options={{ title: "Activity" }} />
            <Stack.Screen name="budget-setup" options={{ title: "Budget setup" }} />
            <Stack.Screen name="budget" options={{ title: "Budget" }} />
            <Stack.Screen name="insights" options={{ title: "Insights" }} />
            <Stack.Screen name="ask" options={{ title: "Ask Reconcile" }} />
            <Stack.Screen name="settings" options={{ title: "Settings" }} />
            <Stack.Screen name="offline" options={{ title: "Offline" }} />
          </Stack>
        </AuthGate>
      </SessionProvider>
    </ErrorBoundary>
  );
}
