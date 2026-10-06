// Server-side provider registry. Returns the concrete adapter for a provider
// id, or selects one by country.
//
// This is the only place that maps a provider id to an implementation. Callers
// ask for a provider; they never import an adapter directly, which is what
// keeps the rest of the codebase provider-agnostic (ARCHITECTURE.md §3).

import { demoProvider, DEMO_PROVIDER_ID } from "./demo/adapter.ts";
import { monoProvider, MONO_PROVIDER_ID } from "./mono/adapter.ts";
import { csvProvider, CSV_PROVIDER_ID } from "../csv/provider.ts";
import type { FinancialProvider } from "./types.ts";

const REGISTRY: Record<string, FinancialProvider> = {
  [DEMO_PROVIDER_ID]: demoProvider,
  [MONO_PROVIDER_ID]: monoProvider,
  [CSV_PROVIDER_ID]: csvProvider,
};

/**
 * Providers offered per ISO 3166-1 alpha-2 country, real providers first.
 * Mirrors `src/providers/registry.ts`; keep the two in sync.
 *
 * `csv` is not listed here: it is not chosen by country. The user opts into it
 * explicitly from Settings or the connect flow, because it is a manual import
 * rather than a country-level availability.
 */
export const PROVIDERS_BY_COUNTRY: Record<string, string[]> = {
  NG: [MONO_PROVIDER_ID, DEMO_PROVIDER_ID],
};

export function getProvider(id: string): FinancialProvider | null {
  return REGISTRY[id] ?? null;
}

/** The real (non-demo) provider for a country, or null if none is configured. */
export function getRealProviderForCountry(countryCode: string): FinancialProvider | null {
  const ids = PROVIDERS_BY_COUNTRY[countryCode.toUpperCase()] ?? [];
  for (const id of ids) {
    if (id === DEMO_PROVIDER_ID) continue;
    const provider = REGISTRY[id];
    if (provider) return provider;
  }
  return null;
}

export function isKnownProvider(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(REGISTRY, id);
}

export const KNOWN_PROVIDER_IDS = Object.keys(REGISTRY);

export { DEMO_PROVIDER_ID, MONO_PROVIDER_ID, CSV_PROVIDER_ID };
