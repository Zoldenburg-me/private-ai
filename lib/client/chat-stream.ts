import { parseSseChunk, type Receipt, type ToolEvent } from "@/lib/sse";
import type { ChatMessage } from "@/lib/providers";
import { normalizeSigned, type Signed } from "@/lib/client/proof";

export interface StreamUpdate { text: string; receipt?: Receipt; remaining?: string | null; tools: ToolEvent[] }

/** Minimal shape of an assistant-ui ThreadMessage we need (kept structural so it is testable). */
export interface UiMessage { role: string; content: readonly { type: string; text?: string }[]; metadata?: { custom?: Record<string, unknown> } }

export type StoredMsg = ChatMessage & { signed?: Signed };

export function toChatMessages(msgs: readonly UiMessage[]): ChatMessage[] {
  return msgs
    .filter((m) => m.role === "user" || m.role === "assistant" || m.role === "system")
    .map((m) => ({ role: m.role as ChatMessage["role"], content: m.content.filter((p) => p.type === "text").map((p) => p.text ?? "").join("") }));
}

/** Like toChatMessages, but keeps each assistant reply's signature status for local history. */
export function toStoredMessages(msgs: readonly UiMessage[]): StoredMsg[] {
  const out: StoredMsg[] = [];
  for (const m of msgs) {
    const [chat] = toChatMessages([m]);
    if (!chat) continue;
    const signed = m.role === "assistant" ? normalizeSigned(m.metadata?.custom?.signed) : undefined;
    out.push(signed ? { ...chat, signed } : chat);
  }
  return out;
}

export interface StreamOpts {
  model: string;
  messages: ChatMessage[];
  persona?: { name: string; system_prompt: string };
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** Agent mode: /api/agent with web search; tool steps arrive in `tools`. */
  agent?: boolean;
}

/** Newest event per tool call id, in first-seen order. */
const mergeTools = (prev: ToolEvent[], next: ToolEvent[]) =>
  next.reduce((acc, e) => (acc.some((t) => t.id === e.id) ? acc.map((t) => (t.id === e.id ? e : t)) : [...acc, e]), prev);

/** Streams /api/chat (or /api/agent in agent mode). Yields the accumulated text; the last update carries the receipt. */
export async function* streamChat({ model, messages, persona, signal, fetchImpl = fetch, agent = false }: StreamOpts): AsyncGenerator<StreamUpdate> {
  const opts = { ...(persona ? { persona } : {}), ...(agent ? { web_search: true } : {}) };
  const res = await fetchImpl(agent ? "/api/agent" : "/api/chat", {
    method: "POST", signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, stream: true, messages, ...(Object.keys(opts).length ? { pai_options: opts } : {}) }),
  });
  let remaining = res.headers.get("x-usage-remaining-daily"); // /api/agent updates it in `pai_usage` after its last step
  if (!res.ok || !res.body) {
    const j = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(j.error?.message || `HTTP ${res.status}`);
  }
  const reader = res.body.getReader(); const dec = new TextDecoder();
  let buf = ""; let text = ""; let receipt: Receipt | undefined; let tools: ToolEvent[] = []; let finished = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const p = parseSseChunk(buf + dec.decode(value, { stream: true }));
    buf = p.rest; text += p.deltas.join(""); if (p.receipt) receipt = p.receipt; tools = mergeTools(tools, p.tools); finished ||= p.done; remaining = p.remaining ?? remaining;
    if (p.error) throw new Error(p.error);
    yield { text, remaining, tools };
  }
  const p = parseSseChunk(buf + "\n"); text += p.deltas.join(""); if (p.receipt) receipt = p.receipt; tools = mergeTools(tools, p.tools); remaining = p.remaining ?? remaining;
  if (p.error) throw new Error(p.error);
  // /api/agent always ends with [DONE] or agent_error: anything else is a cut connection, not an answer.
  if (agent && !(finished || p.done)) throw new Error("connection lost before the answer finished");
  yield { text, receipt, remaining, tools };
}
