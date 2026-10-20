import type { ModelEntry } from "@/lib/catalog";

/**
 * Client-side provider allowlist: NEAR AI (TEE), Venice (anonymized frontier models); "mock" is the dev/test enclave
 * (only served when the server runs with MOCK_PROVIDER=1). Adding an adapter later = add its id here
 * (and configure it server-side in lib/providers.ts).
 */
export const ENABLED_PROVIDERS = ["near", "venice", "mock"] as const;

export const PROVIDER_LABEL: Record<string, string> = { near: "NEAR AI Cloud", venice: "Frontier · anonymized", mock: "Mock enclave (dev)" };

/** One-line explanation shown wherever an anonymized model is offered or selected. */
export const ANONYMIZED_NOTE = "Your prompt leaves the enclave path and goes to the model vendor without your identity (no account, IP or session).";

export function visibleModels(all: ModelEntry[], enabled: readonly string[] = ENABLED_PROVIDERS): ModelEntry[] {
  return all.filter((m) => enabled.includes(m.provider));
}

export function defaultModelRef(models: ModelEntry[]): string {
  // Anonymized models leave the enclave path, so they are only ever an explicit choice.
  const m = models.find((x) => x.selectable && x.privacy !== "anonymized");
  return m ? `${m.provider}:${m.id}` : "";
}
