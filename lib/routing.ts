import { findSelectable, type ModelEntry } from "./catalog";

/**
 * The curated open-weight line-up: public model id -> the same weights' id at each TEE provider.
 * Only the same model and version counts (Phala's DeepSeek V4 Flash 0731 is not V4.1 Flash).
 */
export const CURATED: Record<string, Record<string, string>> = {
  "kimi-k3": { near: "moonshotai/kimi-k3", phala: "moonshotai/kimi-k3", tinfoil: "kimi-k3" },
  "glm-5.3": { phala: "z-ai/glm-5.3", tinfoil: "glm-5-3" },
  "deepseek-v4.1-flash": { near: "deepseek/deepseek-v4.1-flash", tinfoil: "deepseek-v4-1-flash" },
  "qwen3.8-27b": { near: "Qwen/Qwen3.8-27B", phala: "qwen/qwen3.8-27b" },
};

/** Blended USD per 1M tokens at 3 input : 1 output, the ratio Artificial Analysis prices by. Unpriced sorts last. */
const blended = (m: ModelEntry) => (m.price ? (3 * m.price.in + m.price.out) / 4 : Infinity);

/** The cheapest TEE-attested catalog entry for a curated model, or undefined if no TEE provider serves it now. */
export function cheapestRoute(catalog: ModelEntry[], model: string): ModelEntry | undefined {
  // hasOwnProperty: "__proto__" or "constructor" from a request must not resolve to an object.
  if (!Object.prototype.hasOwnProperty.call(CURATED, model)) return undefined;
  return Object.entries(CURATED[model])
    .map(([provider, id]) => findSelectable(catalog, provider, id))
    .filter((m): m is ModelEntry => !!m?.tee)
    .sort((a, b) => blended(a) - blended(b))[0];
}
