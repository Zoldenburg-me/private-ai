import type { ModelEntry } from "@/lib/catalog";

/**
 * Client-side provider allowlist. Launch scope is NEAR AI only; "mock" is the dev/test enclave
 * (only served when the server runs with MOCK_PROVIDER=1). Adding an adapter later = add its id here
 * (and configure it server-side in lib/providers.ts).
 */
export const ENABLED_PROVIDERS = ["near", "mock"] as const;

export const PROVIDER_LABEL: Record<string, string> = { near: "NEAR AI Cloud", mock: "Mock enclave (dev)" };

export function visibleModels(all: ModelEntry[], enabled: readonly string[] = ENABLED_PROVIDERS): ModelEntry[] {
  return all.filter((m) => enabled.includes(m.provider));
}

export function defaultModelRef(models: ModelEntry[]): string {
  const m = models.find((x) => x.selectable);
  return m ? `${m.provider}:${m.id}` : "";
}
