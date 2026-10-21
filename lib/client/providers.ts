import type { ModelEntry } from "@/lib/catalog";

/**
 * Client-side provider allowlist: NEAR AI (TEE), Venice and Liquid (incognito: anonymized, non-TEE); "mock" is the dev/test enclave
 * (only served when the server runs with MOCK_PROVIDER=1). Adding an adapter later = add its id here
 * (and configure it server-side in lib/providers.ts).
 */
export const ENABLED_PROVIDERS = ["near", "venice", "liquid", "mock"] as const;

export const PROVIDER_LABEL: Record<string, string> = { near: "NEAR AI Cloud", incognito: "Incognito", mock: "Mock enclave (dev)" };

/** Picker group: every selectable non-TEE model goes to one Incognito group, whatever its provider; the rest by provider. */
export const pickerGroup = (m: ModelEntry) => (!m.tee && m.selectable ? "incognito" : m.provider);

/** One-line explanation shown wherever an anonymized model is offered or selected. */
export const ANONYMIZED_NOTE = "No enclave: your prompt goes to the provider without your identity (no account, IP or session). PRIVATE models are run with zero data retention.";

export function visibleModels(all: ModelEntry[], enabled: readonly string[] = ENABLED_PROVIDERS): ModelEntry[] {
  return oneRowPerModel(all.filter((m) => enabled.includes(m.provider)));
}

/** Incognito shows each model once: a private (zero-retention) route replaces an anonymized one in place; otherwise the first listed stays. */
function oneRowPerModel(models: ModelEntry[]): ModelEntry[] {
  const out: ModelEntry[] = [];
  for (const m of models) {
    const i = pickerGroup(m) === "incognito" ? out.findIndex((x) => pickerGroup(x) === "incognito" && x.name === m.name) : -1;
    if (i < 0) out.push(m);
    else if (m.privacy === "private" && out[i].privacy !== "private") out[i] = m;
  }
  return out;
}

export function defaultModelRef(models: ModelEntry[]): string {
  // Incognito models leave the enclave path, so they are only ever an explicit choice.
  const m = models.find((x) => x.selectable && x.tee);
  return m ? `${m.provider}:${m.id}` : "";
}
