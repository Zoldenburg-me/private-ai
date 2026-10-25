import { parseSseChunk, type Receipt, type ToolEvent } from "@/lib/sse";
import type { ChatMessage } from "@/lib/providers";
import { normalizeSigned, type Signed } from "@/lib/client/proof";

/** A failure at the model provider (relay 502/504, or an agent's "provider …" error), not our limits or session. */
export class ProviderFailure extends Error {}
const failure = (message: string, atProvider: boolean) => (atProvider ? new ProviderFailure(message) : new Error(message));
// Our server's own texts for a failure at the provider (lib/relay.ts, lib/agent.ts, lib/handler.ts).
const providerText = (m: string) => /^(provider |empty provider response$|model did not answer$)/.test(m);

/** `quota`: which daily quota the reply counted against ("standard" or "incognito"), from the server's headers. */
export interface StreamUpdate { text: string; receipt?: Receipt; remaining?: string | null; limit?: string | null; quota?: string | null; tools: ToolEvent[] }

type UiPart = { type: string; text?: string; image?: string };
/** Minimal shape of an assistant-ui ThreadMessage we need (kept structural so it is testable). */
export interface UiMessage { role: string; content: readonly UiPart[]; attachments?: readonly { name: string; content?: readonly UiPart[] }[]; metadata?: { custom?: Record<string, unknown> }; status?: { type: string; reason?: string } }

/** The incognito route an assistant reply came from (zero-retention or anonymized gateway); enclave replies have none. */
export type Incognito = "private" | "anonymized";
export const normalizeIncognito = (v: unknown): Incognito | undefined => (v === "private" || v === "anonymized" ? v : undefined);

export type StoredMsg = ChatMessage & { signed?: Signed; incognito?: Incognito };
/** What /api/chat receives: a user message with images carries OpenAI content parts. */
export type OutgoingMsg = Omit<ChatMessage, "content"> & { content: string | ({ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } })[] };

/** An error turn ("⚠️ …") is shown, but never sent back to the model or kept in history. */
const isChatRole = (m: UiMessage) => (m.role === "user" || m.role === "assistant" || m.role === "system") && m.status?.reason !== "error";
const textOfParts = (parts: readonly UiPart[]) => parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("");

/** Attached documents (already wrapped as text) come before what the user typed; images are listed separately. */
function split(m: UiMessage) {
  const files = m.attachments ?? [];
  const docs = files.map((a) => textOfParts(a.content ?? [])).filter(Boolean);
  const images = files.flatMap((a) => (a.content ?? []).filter((p) => p.type === "image" && p.image).map((p) => ({ name: a.name, url: p.image! })));
  return { text: [...docs, textOfParts(m.content)].filter(Boolean).join("\n\n"), images };
}

const withNames = (text: string, images: { name: string }[]) => [...images.map((i) => `[image: ${i.name}]`), text].filter(Boolean).join("\n\n");

/**
 * Images go only with the newest user message, and only when the model reads them; earlier ones become their
 * names, as in stored history. So a chat survives a switch to a text-only model, and old photos do not fill the body cap.
 */
export function toChatMessages(msgs: readonly UiMessage[], { images: send = true } = {}): OutgoingMsg[] {
  const chat = msgs.filter(isChatRole);
  const newest = chat.findLastIndex((m) => m.role === "user");
  const out = chat.map((m, i): OutgoingMsg => {
    const { text, images } = split(m);
    const role = m.role as ChatMessage["role"];
    if (!images.length) return { role, content: text };
    if (i !== newest || !send) return { role, content: withNames(text, images) };
    return { role, content: [...(text ? [{ type: "text" as const, text }] : []), ...images.map((i) => ({ type: "image_url" as const, image_url: { url: i.url } }))] };
  });
  // A user message left unanswered (its error turn is dropped) joins the next one, so roles still alternate. Only the newest can carry parts.
  return out.reduce<OutgoingMsg[]>((acc, m) => {
    const prev = acc.at(-1);
    if (prev?.role !== "user" || m.role !== "user" || typeof prev.content !== "string") { acc.push(m); return acc; }
    acc[acc.length - 1] = { role: "user", content: typeof m.content === "string" ? [prev.content, m.content].filter(Boolean).join("\n\n") : [...(prev.content ? [{ type: "text" as const, text: prev.content }] : []), ...m.content] };
    return acc;
  }, []);
}

/** The newest user message carries an image (to refuse it up front for a model that does not read images). */
export const newestHasImage = (msgs: readonly UiMessage[]) =>
  split(msgs.filter((m) => m.role === "user").at(-1) ?? { role: "user", content: [] }).images.length > 0;

const unescapeName = (n: string) => n.replaceAll("&quot;", "\"").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
const STORED_FILE = /^(?:\[image: ([^\]\n]*)\]|<document name="([^"]*)">\n[\s\S]*?\n<\/document>)(?:\n\n|$)/;

/** A stored user message split back into its files' names and the typed text, so a reloaded chat shows chips, not raw documents. */
export function storedView(content: string): { files: { name: string; type: "image" | "document" }[]; text: string } {
  const files: { name: string; type: "image" | "document" }[] = [];
  let rest = content;
  for (let m = STORED_FILE.exec(rest); m; m = STORED_FILE.exec(rest)) {
    files.push(m[1] !== undefined ? { name: m[1], type: "image" } : { name: unescapeName(m[2]), type: "document" });
    rest = rest.slice(m[0].length);
  }
  return { files, text: rest };
}

/**
 * Like toChatMessages, but for local history: keeps each assistant reply's signature status and incognito route, and
 * replaces images with their names.
 * shortcut: images are not in history (localStorage holds ~5 MB), so a reloaded chat no longer shows them to the model; move history to IndexedDB if that matters.
 */
export function toStoredMessages(msgs: readonly UiMessage[]): StoredMsg[] {
  return msgs.filter(isChatRole).map((m) => {
    const { text, images } = split(m);
    const content = withNames(text, images);
    const signed = m.role === "assistant" ? normalizeSigned(m.metadata?.custom?.signed) : undefined;
    const incognito = m.role === "assistant" ? normalizeIncognito(m.metadata?.custom?.incognito) : undefined;
    return { role: m.role as ChatMessage["role"], content, ...(signed ? { signed } : {}), ...(incognito ? { incognito } : {}) };
  });
}

export interface StreamOpts {
  model: string;
  messages: OutgoingMsg[];
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
  const limit = res.headers.get("x-usage-limit-daily");
  const quota = res.headers.get("x-usage-quota");
  if (!res.ok || !res.body) {
    if (remaining != null) yield { text: "", remaining, limit, quota, tools: [] }; // a refused request still reports its quota
    const j = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    const message = j.error?.message || `HTTP ${res.status}`;
    // Our relay's own text too: a 502 from the tunnel while the app is down is not the provider's fault.
    throw failure(message, [502, 503, 504].includes(res.status) && providerText(message));
  }
  const reader = res.body.getReader(); const dec = new TextDecoder();
  let buf = ""; let text = ""; let receipt: Receipt | undefined; let tools: ToolEvent[] = []; let finished = false;
  for (;;) {
    // A stream that breaks here stays a plain error: the browser cannot tell the relay's failure from the user's own network.
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = dec.decode(value, { stream: true });
    // A generated image is one multi-MB line: parse only once a line ends, not the growing line on every chunk.
    if (!chunk.includes("\n")) { buf += chunk; continue; }
    const p = parseSseChunk(buf + chunk);
    buf = p.rest; text += p.deltas.join(""); if (p.receipt) receipt = p.receipt; tools = mergeTools(tools, p.tools); finished ||= p.done; remaining = p.remaining ?? remaining;
    if (p.error) throw failure(p.error, agent && providerText(p.error)); // only /api/agent writes agent_error; a relayed provider could fake it
    yield { text, remaining, limit, quota, tools };
  }
  const p = parseSseChunk(buf + "\n"); text += p.deltas.join(""); if (p.receipt) receipt = p.receipt; tools = mergeTools(tools, p.tools); remaining = p.remaining ?? remaining;
  if (p.error) throw failure(p.error, agent && providerText(p.error));
  // /api/agent always ends with [DONE] or agent_error: anything else is a cut connection, not an answer.
  if (agent && !(finished || p.done)) throw new Error("connection lost before the answer finished");
  yield { text, receipt, remaining, limit, quota, tools };
}
