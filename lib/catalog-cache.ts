import { fallbackModels, fetchProviderModels, type ModelEntry } from "./catalog";
import { loadProviders, type ProviderConfig } from "./providers";

const TTL_MS = 60_000;
/** A provider whose /models keeps failing keeps its last good list this long, then drops to its fallback. */
export const STALE_MAX_MS = 5 * 60_000;

let cache: { until: number; data: ModelEntry[] } | null = null;
let inflight: Promise<ModelEntry[]> | null = null;
let lastOkAt = new Map<string, number>();

/** A provider's models plus how long they may be served: stale entries only until STALE_MAX_MS after the last success. */
async function providerModels(p: ProviderConfig, previous: ModelEntry[]): Promise<{ models: ModelEntry[]; until: number }> {
  const fresh = Date.now() + TTL_MS;
  try {
    const models = await fetchProviderModels(p);
    lastOkAt.set(p.id, Date.now());
    return { models, until: fresh };
  } catch {
    const staleUntil = (lastOkAt.get(p.id) ?? -Infinity) + STALE_MAX_MS;
    const stale = Date.now() <= staleUntil ? previous.filter((m) => m.provider === p.id) : [];
    return stale.length ? { models: stale, until: Math.min(fresh, staleUntil) } : { models: fallbackModels(p), until: fresh };
  }
}

/** One refresh at a time; a failing provider serves its stale entries for at most STALE_MAX_MS, cache hits included. */
export async function getCatalog(): Promise<ModelEntry[]> {
  if (cache && Date.now() < cache.until) return cache.data;
  if (!inflight) {
    const previous = cache?.data ?? [];
    const p: Promise<ModelEntry[]> = Promise.all(loadProviders().map((x) => providerModels(x, previous)))
      .then((parts) => {
        const data = parts.flatMap((x) => x.models);
        cache = { until: Math.min(...parts.map((x) => x.until), Date.now() + TTL_MS), data };
        return data;
      })
      .finally(() => { if (inflight === p) inflight = null; });
    inflight = p;
  }
  return inflight;
}
export function _clearCatalog() { cache = null; inflight = null; lastOkAt = new Map(); }
