import type { ModelEntry } from "@/lib/catalog";
import { CURATED, routesByPrice } from "@/lib/routing";

/**
 * Client-side provider allowlist: NEAR AI (TEE), Venice (anonymized frontier models); "mock" is the dev/test enclave
 * (only served when the server runs with MOCK_PROVIDER=1). Adding an adapter later = add its id here
 * (and configure it server-side in lib/providers.ts).
 */
export const ENABLED_PROVIDERS = ["near", "venice", "mock"] as const;

/** Providers whose attestation covers their gateway, not the model behind it (lib/providers.ts: privacy "tee-gateway"). */
export const GATEWAY_ONLY = new Set(["redpill"]);
export const PROVIDER_LABEL: Record<string, string> = { auto: "Auto · cheapest enclave", phala: "Phala Confidential AI", tinfoil: "Tinfoil", near: "NEAR AI Cloud", redpill: "RedPill", venice: "Frontier · anonymized", mock: "Mock enclave (dev)" };

/** One-line explanation shown wherever an anonymized model is offered or selected. */
export const ANONYMIZED_NOTE = "Your prompt leaves the enclave path and goes to the model vendor without your identity (no account, IP or session).";

export function visibleModels(all: ModelEntry[], enabled: readonly string[] = ENABLED_PROVIDERS): ModelEntry[] {
  return all.filter((m) => enabled.includes(m.provider));
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

export function defaultModelRef(models: ModelEntry[]): string {
  // Anonymized models leave the enclave path, so they are only ever an explicit choice.
  const m = models.find((x) => x.selectable && x.privacy !== "anonymized");
  return m ? `${m.provider}:${m.id}` : "";
}
