import type { ProviderConfig } from "./providers";
import type { ToolEvent } from "./sse";
import { publicHttpUrl, queryOf, SEARCH_RESULTS } from "./web-search";

/**
 * NEAR AI Cloud's built-in web search (docs.near.ai/cloud/guides/web-search). NEAR's inference proxy runs the search
 * loop inside the model's CVM: only the query leaves it, to Brave, and our server never runs the search. The stream
 * carries each iteration's `delta.tool_calls` (the query) and `finish_reason: "tool_calls"`, then a
 * `delta.nearai_tool_result`, then the next iteration; only `[DONE]` ends the answer. The proxy signs every byte it sends.
 */
export const NEAR_SEARCH_TOOL = { type: "web_context_search" } as const;

/** NEAR's proxy waits this long for Brave (WEB_CONTEXT_SEARCH_TIMEOUT_SECS) and sends nothing meanwhile. */
export const NEAR_SEARCH_TIMEOUT_MS = 30_000;

/** Every NEAR model we offer is attested (lib/catalog.ts), so every one searches in its enclave. */
export const searchesInEnclave = (p: Pick<ProviderConfig, "id">) => p.id === "near";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const MAX_ARGS_CHARS = 4_000;

/** Turns one NEAR stream's search chunks into our `agent_tool` events, with our own ids. */
export class NearSearchSteps {
  private calls: { upstream: string; args: string }[] = []; // this iteration's calls, by index
  private ids = new Map<string, { id: string; query?: string }>(); // announced searches awaiting their result, oldest first
  private n = 0;
  constructor(private readonly step: number) {}

  /** One `delta.tool_calls` entry: arguments arrive in pieces, keyed by index. */
  toolDelta(t: unknown): void {
    if (!isObj(t)) return;
    const i = typeof t.index === "number" ? t.index : 0;
    if (!Number.isInteger(i) || i < 0 || i >= 8) return; // NEAR runs at most 8 calls per iteration
    const c = (this.calls[i] ??= { upstream: "", args: "" });
    if (typeof t.id === "string" && !c.upstream) c.upstream = t.id.slice(0, 128);
    const f = isObj(t.function) ? t.function : {};
    if (typeof f.arguments === "string" && c.args.length < MAX_ARGS_CHARS) c.args += f.arguments;
  }

  /** `finish_reason: "tool_calls"`: the queries are complete and NEAR is searching now. */
  iterationEnd(): ToolEvent[] {
    const running = this.calls.filter(Boolean).map((c) => {
      const id = `call_${this.step}_${this.n++}`;
      const query = queryOf(c.args) ?? undefined;
      this.ids.set(c.upstream && !this.ids.has(c.upstream) ? c.upstream : `#${id}`, { id, query });
      return { id, name: "web_search", status: "running" as const, ...(query ? { query } : {}) };
    });
    this.calls = [];
    return running;
  }

  /**
   * A `delta.nearai_tool_result` for a search announced (and counted) before, else null; each is answered once.
   * A result without an id takes the oldest open search: NEAR answers its calls in order.
   * Only titles and links go on: the page text stays in the stream NEAR signed.
   */
  result(r: unknown): ToolEvent | null {
    if (!isObj(r)) return null;
    const key = typeof r.tool_call_id === "string" && r.tool_call_id ? r.tool_call_id : this.ids.keys().next().value;
    const known = key === undefined ? undefined : this.ids.get(key);
    if (!known) return null;
    this.ids.delete(key!);
    const { id, query } = known;
    const q = query ? { query } : {};
    if (r.status !== "ok") return { id, name: "web_search", status: "error", ...q };
    return { id, name: "web_search", status: "done", ...q, results: sourcesOf(typeof r.output === "string" ? r.output : "") };
  }

  /** The answer is complete: a search NEAR never answered is shown as failed, not left running. */
  close(): ToolEvent[] {
    const open = [...this.ids.values()].map(({ id, query }) => ({ id, name: "web_search", status: "error" as const, ...(query ? { query } : {}) }));
    this.ids = new Map();
    return open;
  }
}

/**
 * NEAR formats each source as "[n] title\nurl\nsnippets", numbered from 1; keeps the public http(s) links.
 * shortcut: page text could still forge a "[n]" header with the right next number; upgrade if NEAR adds structured sources.
 */
export function sourcesOf(output: string): { title: string; url: string }[] {
  let next = 1;
  return [...output.matchAll(/^\[(\d+)\] (.*)\n(\S+)$/gm)]
    .filter((m) => Number(m[1]) === next && (next++, true)) // a "[n]" out of sequence is page text
    .filter((m) => m[3].length <= 2_000 && publicHttpUrl(m[3]))
    .slice(0, SEARCH_RESULTS)
    .map((m) => ({ title: m[2].slice(0, 200), url: m[3] }));
}
