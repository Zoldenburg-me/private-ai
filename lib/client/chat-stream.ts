import { parseSseChunk, type Receipt } from "@/lib/sse";
import type { ChatMessage } from "@/lib/providers";
import { normalizeSigned, type Signed } from "@/lib/client/proof";

export interface StreamUpdate { text: string; receipt?: Receipt; remaining?: string | null }

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
}

/** Streams /api/chat (server relay -> NEAR AI). Yields the accumulated text; the last update carries the receipt. */
export async function* streamChat({ model, messages, persona, signal, fetchImpl = fetch }: StreamOpts): AsyncGenerator<StreamUpdate> {
  const res = await fetchImpl("/api/chat", {
    method: "POST", signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, stream: true, messages, ...(persona ? { pai_options: { persona } } : {}) }),
  });
  const remaining = res.headers.get("x-usage-remaining-daily");
  if (!res.ok || !res.body) {
    const j = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(j.error?.message || `HTTP ${res.status}`);
  }
  const reader = res.body.getReader(); const dec = new TextDecoder();
  let buf = ""; let text = ""; let receipt: Receipt | undefined;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const p = parseSseChunk(buf + dec.decode(value, { stream: true }));
    buf = p.rest; text += p.deltas.join(""); if (p.receipt) receipt = p.receipt;
    yield { text, remaining };
  }
  const p = parseSseChunk(buf + "\n"); text += p.deltas.join(""); if (p.receipt) receipt = p.receipt;
  yield { text, receipt, remaining };
}
