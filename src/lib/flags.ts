// Client-side feature flags.
//
// IMPORTANT (see src/lib/env.ts:3-7): each key must be read as a direct
// `process.env.EXPO_PUBLIC_*` member expression. Expo's babel plugin inlines
// exactly that shape into production bundles; a whole-object read arrives empty
// on web.

/**
 * Phase 11: the real-bank (Mono) connect path.
 *
 * Default OFF. With this off the Connect Bank flow keeps using the demo
 * provider and every Mono route refuses. Turning it on exposes the Mono
 * Connect widget; the server gate (`FEATURE_MONO` Edge secret) must be
 * enabled too or the Edge Functions will refuse independently.
 */
export const MONO_ENABLED = process.env.EXPO_PUBLIC_FEATURE_MONO === "true";

/**
 * The Mono Connect widget's public key. Safe in the client: it is a publishable
 * identifier, not the server secret. Empty means no public key is configured.
 */
export const MONO_PUBLIC_KEY =
  process.env.EXPO_PUBLIC_MONO_PUBLIC_KEY ?? "";

/**
 * Phase 12: CSV import, the primary data path while Mono live keys are
 * pending. Default ON — a user with no provider access can still get real
 * transactions in.
 */
export const CSV_IMPORT_ENABLED = process.env.EXPO_PUBLIC_FEATURE_CSV_IMPORT !== "false";
