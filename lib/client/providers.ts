import type { ModelEntry } from "@/lib/catalog";
import { canonicalModelId } from "@/lib/provider-models";
import { CURATED, routesByPrice } from "@/lib/routing";

/**
 * Client-side provider allowlist: NEAR AI (TEE), Venice and Liquid (incognito: anonymized, non-TEE); "mock" is the dev/test enclave
 * (only served when the server runs with MOCK_PROVIDER=1). Adding an adapter later = add its id here
 * (and configure it server-side in lib/providers.ts).
 */
export const ENABLED_PROVIDERS = ["near", "venice", "liquid", "mock"] as const;

/** Providers whose attestation covers their gateway, not the model behind it (lib/providers.ts: privacy "tee-gateway"). */
export const GATEWAY_ONLY = new Set(["redpill"]);
export const PROVIDER_LABEL: Record<string, string> = { auto: "Auto · cheapest enclave", phala: "Phala Confidential AI", tinfoil: "Tinfoil", privatemode: "Privatemode", near: "NEAR AI Cloud", redpill: "RedPill", incognito: "Incognito", mock: "Mock enclave (dev)" };

/** Picker group: every gateway model (Venice, Liquid) goes to one Incognito group; the rest by provider. */
export const pickerGroup = (m: ModelEntry) => (m.incognito ? "incognito" : m.provider);

/** One-line explanation shown wherever an anonymized model is offered or selected. */
export const ANONYMIZED_NOTE = "No enclave: your prompt goes to the provider without your identity (no account, IP or session). PRIVATE models are run with zero data retention.";

export function visibleModels(all: ModelEntry[], enabled: readonly string[] = ENABLED_PROVIDERS): ModelEntry[] {
  return oneRowPerModel(all.filter((m) => enabled.includes(m.provider)));
}

/** Same model across gateways: the canonical id (Venice aliases mapped to Liquid's, any other id as is). */
const modelKey = (m: ModelEntry) => canonicalModelId(m.id);

/** Incognito shows each model once: a private (zero-retention) route replaces an anonymized one in place; otherwise the first listed stays. */
function oneRowPerModel(models: ModelEntry[]): ModelEntry[] {
  const out: ModelEntry[] = [];
  for (const m of models) {
    const i = pickerGroup(m) === "incognito" ? out.findIndex((x) => pickerGroup(x) === "incognito" && modelKey(x) === modelKey(m)) : -1;
    if (i < 0) out.push(m);
    else if (m.privacy === "private" && out[i].privacy !== "private") out[i] = m;
  }
  return out;
}

/** An "auto:<curated model>" picker entry; routes are its TEE providers' refs, cheapest first. */
export type AutoEntry = ModelEntry & { routes: string[] };

/**
 * Auto entries for the picker, built from the full catalog (Phala and Tinfoil included, though they are not
 * offered for manual picks). The chat page sends to the cheapest route whose proof holds, never to "auto:" itself.
 */
export function autoModels(all: ModelEntry[]): AutoEntry[] {
  return Object.keys(CURATED).flatMap((id) => {
    const routes = routesByPrice(all, id);
    return routes.length ? [{ id, provider: "auto", name: `Auto · ${routes[0].name.replace(/^[^:]+:\s*/, "")}`, privacy: "tee" as const, tee: true, e2ee: false, selectable: true, routes: routes.map((m) => `${m.provider}:${m.id}`) }] : [];
  });
}

/** The Auto entry `ref` selects, if any (checked, not cast: it must carry its routes). */
export const autoEntryOf = (models: ModelEntry[], ref: string): AutoEntry | undefined =>
  models.find((m): m is AutoEntry => m.provider === "auto" && `auto:${m.id}` === ref && Array.isArray((m as Partial<AutoEntry>).routes));

/** Auto's universal fallback: NEAR's default model, if NEAR offers one. */
export const nearDefault = (models: ModelEntry[]) => defaultModelRef(models.filter((m) => m.provider === "near")) || undefined;

export function defaultModelRef(models: ModelEntry[]): string {
  // Incognito models leave the enclave path, so they are only ever an explicit choice.
  const m = models.find((x) => x.selectable && x.tee);
  return m ? `${m.provider}:${m.id}` : "";
}
