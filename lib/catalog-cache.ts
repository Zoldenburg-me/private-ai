import { fetchCatalog, type ModelEntry } from "./catalog";
import { loadProviders } from "./providers";

let cache: { at: number; data: ModelEntry[] } | null = null;
export async function getCatalog(): Promise<ModelEntry[]> {
  if (cache && Date.now() - cache.at < 60_000) return cache.data;
  const data = await fetchCatalog(loadProviders());
  cache = { at: Date.now(), data };
  return data;
}
export function _clearCatalog() { cache = null; }
