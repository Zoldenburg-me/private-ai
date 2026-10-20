import { fallbackModels, fetchProviderModels, type ModelEntry } from "./catalog";
import type { ProviderConfig } from "./providers";
import { keyGeneration, liveProviders } from "./provider-keys";

const TTL_MS = 60_000;
/** A provider whose /models keeps failing keeps its last good list this long, then drops to its fallback. */
export const STALE_MAX_MS = 5 * 60_000;

let cache: { until: number; data: ModelEntry[]; gen: number } | null = null;
let inflight: { p: Promise<ModelEntry[]>; gen: number } | null = null;
let lastOkAt = new Map<string, number>();
/** Per provider, the key its models were listed with: a stored key id, or "env". */
let keyTag = new Map<string, string>();

/** A provider's models plus how long they may be served: stale entries only until STALE_MAX_MS after the last success. */
async function providerModels(p: ProviderConfig, previous: ModelEntry[], okAt: number | undefined): Promise<{ models: ModelEntry[]; until: number; ok: boolean }> {
  const fresh = Date.now() + TTL_MS;
  try {
    return { models: await fetchProviderModels(p), until: fresh, ok: true };
  } catch {
    const staleUntil = (okAt ?? -Infinity) + STALE_MAX_MS;
    const stale = Date.now() <= staleUntil ? previous.filter((m) => m.provider === p.id) : [];
    return { ...(stale.length ? { models: stale, until: Math.min(fresh, staleUntil) } : { models: fallbackModels(p), until: fresh }), ok: false };
  }
}

/**
 * One refresh at a time; a failing provider serves its stale entries for at most STALE_MAX_MS, cache hits included.
 * A provider whose key changed (stored key id, or "env") gets no stale fallback from its old key's list; others keep theirs.
 * A load only commits (cache, key tags, success times) if no key changed while it ran, so a slow old-key load cannot win.
 */
export async function getCatalog(): Promise<ModelEntry[]> {
  // A cache hit does not touch Postgres, so /api/models can answer from this cache for up to TTL_MS during an outage.
  // That is not the memory fallback the fail-closed invariant forbids: the catalog holds only public model ids from the
  // providers, no stored account data, and every route that reads or writes stored data (chat, session, billing,
  // account, admin) still hits the store per request and returns 503. A refresh during an outage throws once the
  // provider-key cache (CACHE_MS in lib/provider-keys.ts) has also expired, and the model routes then give 503 (withStores).
  if (cache && Date.now() < cache.until && cache.gen === keyGeneration()) return cache.data;
  if (!inflight || inflight.gen !== keyGeneration()) {
    const gen = keyGeneration();
    const previous = cache?.data ?? [];
    const p: Promise<ModelEntry[]> = liveProviders().then(async (all) => {
      const parts = await Promise.all(all.map((x) => {
        const tag = x.keyId ?? "env";
        const sameKey = (keyTag.get(x.id) ?? tag) === tag;
        return providerModels(x, sameKey ? previous : [], sameKey ? lastOkAt.get(x.id) : undefined).then((r) => ({ ...r, id: x.id, tag, sameKey }));
      }));
      const data = parts.flatMap((x) => x.models);
      if (gen === keyGeneration()) {
        for (const x of parts) {
          keyTag.set(x.id, x.tag);
          if (x.ok) lastOkAt.set(x.id, Date.now()); else if (!x.sameKey) lastOkAt.delete(x.id);
        }
        cache = { until: Math.min(...parts.map((x) => x.until), Date.now() + TTL_MS), data, gen };
      }
      return data;
    }).finally(() => { if (inflight?.p === p) inflight = null; });
    inflight = { p, gen };
  }
  return inflight.p;
}
export function _clearCatalog() { cache = null; inflight = null; lastOkAt = new Map(); keyTag = new Map(); }
