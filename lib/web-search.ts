/**
 * Web search for the agent (lib/agent.ts), via the Brave Search API. Only the model's query string
 * leaves the server: no account id, session, IP or user agent. Off unless BRAVE_SEARCH_API_KEY is set
 * (or, in dev/e2e only, MOCK_PROVIDER=1, which then uses the mock search; production refuses MOCK_PROVIDER at boot).
 */
type Env = Record<string, string | undefined>;

export const SEARCH_TIMEOUT_MS = 10_000;
export const SEARCH_RESULTS = 5;
const MAX_QUERY_CHARS = 400;
const MAX_URL_CHARS = 2_000;
const BRAVE_URL = "https://api.search.brave.com/res/v1/web/search";

export interface SearchResult { title: string; url: string; snippet: string }

/**
 * A link we may show and feed back: http(s) to a public DNS name. IP literals (any range, also the decimal and
 * hex forms URL normalises), localhost, single-label and local-only names could point a click at the user's own network.
 */
export function publicHttpUrl(u: string): boolean {
  let h: string;
  try { const url = new URL(u); if (url.protocol !== "http:" && url.protocol !== "https:") return false; h = url.hostname.toLowerCase().replace(/\.+$/, ""); } catch { return false; }
  if (!h.includes(".") || h.startsWith("[") || /^[\d.]+$/.test(h)) return false;
  return !/(^|\.)(localhost|localdomain|local|internal|lan|arpa|intranet|corp|home|test|ts\.net)$/.test(h);
}

export const searchConfigured = (env: Env) => !!env.BRAVE_SEARCH_API_KEY || env.MOCK_PROVIDER === "1";

/** The tool definition offered to the model (OpenAI function-calling format). */
export const WEB_SEARCH_TOOL = {
  type: "function",
  function: {
    name: "web_search",
    description: "Search the web for current information. Returns titles, URLs and short snippets.",
    parameters: { type: "object", properties: { query: { type: "string", description: "Search query" } }, required: ["query"] },
  },
} as const;

/** Parses the model's arguments; null when they are not a JSON object with a non-empty string query. */
export function queryOf(args: string): string | null {
  try {
    const q = (JSON.parse(args) as { query?: unknown }).query;
    return typeof q === "string" && q.trim() ? q.trim().slice(0, MAX_QUERY_CHARS) : null;
  } catch { return null; }
}

export async function webSearch(query: string, env: Env, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<SearchResult[]> {
  const base = env.BRAVE_SEARCH_API_KEY ? BRAVE_URL : `${env.MOCK_BASE_URL || "http://127.0.0.1:3000/api/mock/v1"}/search`;
  const url = `${base}?${new URLSearchParams({ q: query, count: String(SEARCH_RESULTS) })}`;
  const res = await fetchImpl(url, {
    headers: { Accept: "application/json", "X-Subscription-Token": env.BRAVE_SEARCH_API_KEY ?? "" },
    redirect: "error", // never forward the API key to another host
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(SEARCH_TIMEOUT_MS)]) : AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!res.ok) throw Object.assign(new Error(`search provider error ${res.status}`), { status: res.status });
  const j = (await res.json()) as { web?: { results?: { title?: unknown; url?: unknown; description?: unknown }[] } };
  return (j.web?.results ?? [])
    .filter((r) => typeof r.url === "string" && r.url.length <= MAX_URL_CHARS && publicHttpUrl(r.url))
    .slice(0, SEARCH_RESULTS)
    .map((r) => ({ title: String(r.title ?? "").slice(0, 200), url: String(r.url), snippet: String(r.description ?? "").slice(0, 500) }));
}
