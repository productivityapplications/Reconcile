// Client-side provider registry: country code -> the providers available there.
//
// Metadata only. The client never instantiates a provider or calls a provider
// API; it calls Edge Functions, which hold the provider abstraction server-side
// (`supabase/functions/_shared/providers/registry.ts`). This registry exists so
// the UI can answer "which banks can I connect here?" and render the right
// connect flow.
//
// Keep in sync with the server registry — same provider ids, same countries.

import {
  CSV_CAPABILITIES,
  DEMO_CAPABILITIES,
  MONO_CAPABILITIES,
  type ProviderId,
} from "./capabilities";
import type { ProviderCapabilities } from "./types";

export interface ProviderDescriptor {
  id: ProviderId;
  /** Human name for the UI. */
  displayName: string;
  capabilities: ProviderCapabilities;
  /**
   * Whether this provider requires server work to open its connect UI
   * (a connect-session call) versus being a one-tap local fixture.
   */
  requiresConnectSession: boolean;
}

const REGISTRY: Record<ProviderId, ProviderDescriptor> = {
  demo: {
    id: "demo",
    displayName: "Demo Mode",
    capabilities: DEMO_CAPABILITIES,
    requiresConnectSession: false,
  },
  mono: {
    id: "mono",
    displayName: "Mono",
    capabilities: MONO_CAPABILITIES,
    requiresConnectSession: true,
  },
  /**
   * CSV import (Phase 12). Not chosen by country — the user opts in from
   * Settings or the connect flow, because it is a manual import rather than a
   * country-level availability. It needs no hosted connect session: the file
   * arrives in one request.
   */
  csv: {
    id: "csv",
    displayName: "Import CSV",
    capabilities: CSV_CAPABILITIES,
    requiresConnectSession: false,
  },
};

/**
 * Provider availability by ISO 3166-1 alpha-2 country code.
 *
 * The demo provider is offered everywhere because it is a local fixture with
 * no jurisdiction. Real providers are listed only for countries where they
 * are actually offered.
 */
export const PROVIDERS_BY_COUNTRY: Record<string, ProviderId[]> = {
  NG: ["mono", "demo"],
};

/** Providers available in a country, demo last. Unknown country -> demo only. */
export function providersForCountry(countryCode: string): ProviderDescriptor[] {
  const key = countryCode.toUpperCase();
  const ids = PROVIDERS_BY_COUNTRY[key] ?? ["demo"];
  return ids
    .map((id) => REGISTRY[id])
    .filter((d): d is ProviderDescriptor => d !== undefined);
}

/** Look up one provider by id. Null when unknown. */
export function getProvider(id: string): ProviderDescriptor | null {
  return REGISTRY[id as ProviderId] ?? null;
}

/** True when the country has at least one non-demo provider. */
export function hasRealProvider(countryCode: string): boolean {
  return providersForCountry(countryCode).some((p) => p.id !== "demo");
}

export type { ProviderId };
