// Type-only: the chat page imports this file, and catalog.ts pulls in the server-side Tinfoil SDK.
import type { ModelEntry } from "./catalog";

/**
 * The curated open-weight line-up: public model id -> the same weights' id at each TEE provider.
 * Only the same model and version counts (Phala's DeepSeek V4 Flash 0731 is not V4.1 Flash).
 */
export const CURATED: Record<string, Record<string, string>> = {
  // Not Phala: it serves Kimi K3 through Chutes, whose attestation format this app cannot check (seen 2026-10-21).
  "kimi-k3": { near: "moonshotai/kimi-k3", tinfoil: "kimi-k3" },
  "glm-5.3": { phala: "z-ai/glm-5.3", tinfoil: "glm-5-3" },
  "deepseek-v4.1-flash": { near: "deepseek/deepseek-v4.1-flash", tinfoil: "deepseek-v4-1-flash" },
  "qwen3.8-27b": { near: "Qwen/Qwen3.8-27B", phala: "qwen/qwen3.8-27b" },
};

/** Blended USD per 1M tokens at 3 input : 1 output, the ratio Artificial Analysis prices by. Unpriced sorts last. */
const blended = (m: ModelEntry) => (m.price ? (3 * m.price.in + m.price.out) / 4 : Infinity);

/** Every TEE-attested catalog entry serving a curated model, cheapest first; empty if none serves it now. */
export function routesByPrice(catalog: ModelEntry[], model: string): ModelEntry[] {
  // hasOwnProperty: "__proto__" or "constructor" from a request must not resolve to an object.
  if (!Object.prototype.hasOwnProperty.call(CURATED, model)) return [];
  return Object.entries(CURATED[model])
    .map(([provider, id]) => catalog.find((m) => m.provider === provider && m.id === id && m.selectable))
    .filter((m): m is ModelEntry => !!m?.tee)
    .sort((a, b) => blended(a) - blended(b));
}

/** The cheapest TEE-attested catalog entry for a curated model, or undefined if no TEE provider serves it now. */
export const cheapestRoute = (catalog: ModelEntry[], model: string): ModelEntry | undefined => routesByPrice(catalog, model)[0];
