import { createHash } from "node:crypto";
import type { ProviderConfig } from "./providers";
import type { Logger } from "./log";
import { providerFetch } from "./provider-fetch";
import { usageIn } from "./credits";

/**
 * Zero-content relay: forwards the body to the provider and pipes the stream back.
 * Never logs or stores content. Computes SHA-256 of the exact upstream request/response bytes
 * (hashes only) so the client can check provider response signatures, and appends them as a
 * final SSE event `pai_receipt`.
 */
/**
 * `onUsage`: called exactly once however the response ends (finished, failed, or cancelled by the client), with the
 * token counts of its `usage` report (null if none arrived) and an estimate of the reply tokens already passed on.
 */
export interface RelayOpts {
  provider: ProviderConfig; body: Record<string, unknown>; log: Logger; route: string; fetchImpl?: typeof fetch; extraHeaders?: Record<string, string>;
  onUsage?: (u: { prompt: number; completion: number } | null, streamedTokens: number) => Promise<void>;
}

/** Wait for upstream headers. Non-streaming replies only arrive once the whole answer is generated, so they get longer. */
export const FIRST_BYTE_TIMEOUT_MS = { stream: 30_000, json: 120_000 };
/** Max silence between two upstream chunks, and the hard cap on the whole exchange. */
export const IDLE_TIMEOUT_MS = 30_000;
export const TOTAL_TIMEOUT_MS = 300_000;

/** Text of a streamed delta (answer or reasoning), still JSON-escaped: close enough to count its length. */
const DELTA_TEXT = /"(?:content|reasoning_content|reasoning)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;

export async function relay({ provider, body, log, route, fetchImpl = providerFetch(provider.id), extraHeaders = {}, onUsage }: RelayOpts): Promise<Response> {
  const started = Date.now();
  const reqText = JSON.stringify(body);
  const reqSha256 = createHash("sha256").update(reqText).digest("hex");
  const streaming = body.stream === true;
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), TOTAL_TIMEOUT_MS);
  let idle = setTimeout(() => abort.abort(), streaming ? FIRST_BYTE_TIMEOUT_MS.stream : FIRST_BYTE_TIMEOUT_MS.json);
  const stopTimers = () => { clearTimeout(idle); clearTimeout(deadline); };
  // Rejects once aborted, so a reader.read() that the upstream never answers is cut off too.
  const aborted = new Promise<never>((_, reject) => abort.signal.addEventListener("abort", () => reject(new Error("upstream timeout")), { once: true }));
  aborted.catch(() => {});
  let upstream: Response;
  try {
    // Raced against the abort so a fetch that ignores its signal cannot outlive the deadlines.
    upstream = await Promise.race([fetchImpl(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${provider.apiKey}` },
      body: reqText,
      signal: abort.signal,
    }), aborted]);
  } catch {
    stopTimers();
    const status = abort.signal.aborted ? 504 : 502;
    log({ route, provider: provider.id, event: status === 504 ? "upstream_timeout" : "upstream_unreachable", status, ms: Date.now() - started });
    return Response.json({ error: { message: status === 504 ? "provider timeout" : "provider unreachable" } }, { status, headers: extraHeaders });
  }
  clearTimeout(idle);
  if (!upstream.ok || !upstream.body) {
    stopTimers();
    log({ route, provider: provider.id, status: upstream.status, event: "upstream_error", ms: Date.now() - started });
    return Response.json({ error: { message: `provider error ${upstream.status}` } }, { status: 502, headers: extraHeaders });
  }
  const hash = createHash("sha256");
  let bytes = 0;
  let chatId = "";
  const dec = new TextDecoder();
  let head = "";
  // Only our server names events (`pai_receipt` here, `agent_tool`/`pai_usage` in lib/agent.ts): every upstream block
  // with an `event:` line is dropped, line by line across chunks. OpenAI-style streams send only unnamed `data:` blocks.
  const sse = new TextDecoder();
  let line = ""; let dropping = false; let droppedLogged = false;
  // The usage report comes last (final chunk, or the end of a JSON reply): only the tail is kept, in memory, never logged.
  const usageDec = new TextDecoder(); let tail = ""; let replyChars = 0; let settled = false;
  // A stopped stream is charged too, or a client could close it before the usage report and pay nothing.
  const settle = async () => {
    if (!onUsage || settled) return;
    settled = true;
    // Reply text, or the whole JSON body (bytes) for a non-streaming reply; estimateTokens counts 3 bytes a token.
    await onUsage(usageIn(tail + usageDec.decode()), Math.ceil((streaming ? replyChars : bytes) / 3)).catch(() => {});
  };
  const reader = upstream.body.getReader();
  const out = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      idle = setTimeout(() => abort.abort(), IDLE_TIMEOUT_MS);
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await Promise.race([reader.read(), aborted]); } catch {
        const timedOut = abort.signal.aborted;
        stopTimers(); abort.abort(); reader.cancel().catch(() => {});
        log({ route, provider: provider.id, event: timedOut ? "upstream_timeout" : "upstream_error", status: timedOut ? 504 : 502, ms: Date.now() - started, outputBytes: bytes });
        await settle();
        ctrl.error(new Error(timedOut ? "provider timeout" : "provider stream failed"));
        return;
      } finally { clearTimeout(idle); }
      const { value, done } = chunk;
      if (done) {
        stopTimers();
        const respSha256 = hash.digest("hex");
        if (streaming) {
          const receipt = { chat_id: chatId, provider: provider.id, model: body.model, req_sha256: reqSha256, resp_sha256: respSha256 };
          // The blank line ends whatever the upstream left open, so the receipt is an event of its own.
          ctrl.enqueue(new TextEncoder().encode(`${dropping ? "" : line}\n\nevent: pai_receipt\ndata: ${JSON.stringify(receipt)}\n\n`));
        }
        log({ route, provider: provider.id, model: String(body.model ?? ""), status: 200, ms: Date.now() - started, outputBytes: bytes });
        await settle();
        ctrl.close();
        return;
      }
      hash.update(value); bytes += value.length;
      if (onUsage) tail = (tail + usageDec.decode(value, { stream: true })).slice(-4096);
      if (!chatId && head.length < 4096) {
        head += dec.decode(value, { stream: true });
        const m = /"id"\s*:\s*"([^"]+)"/.exec(head); if (m) chatId = m[1];
      }
      if (!streaming) { ctrl.enqueue(value); return; }
      // SSE ends a line at CRLF, CR or LF; a trailing CR waits for the next chunk, which may start with its LF.
      const text = line + sse.decode(value, { stream: true });
      const cr = text.endsWith("\r");
      const lines = (cr ? text.slice(0, -1) : text).split(/\r\n|\r|\n/);
      line = (lines.pop() ?? "") + (cr ? "\r" : "");
      if (onUsage) for (const l of lines) for (const m of l.matchAll(DELTA_TEXT)) replyChars += m[1].length;
      const kept = lines.filter((l) => {
        const t = l.trim();
        if (t.startsWith("event:")) {
          dropping = true;
          // Once per request, no event name: a provider that names its own events (and loses them here) shows up in the logs.
          if (!droppedLogged) { droppedLogged = true; log({ route, provider: provider.id, event: "upstream_event_dropped" }); }
        }
        else if (t === "") dropping = false;
        return !dropping;
      });
      // Enqueued even when empty: a pull that enqueues nothing is not called again.
      ctrl.enqueue(new TextEncoder().encode(kept.length ? kept.join("\n") + "\n" : ""));
    },
    cancel() { stopTimers(); abort.abort(); reader.cancel().catch(() => {}); return settle(); },
  });
  return new Response(out, {
    headers: {
      ...extraHeaders,
      "Content-Type": streaming ? "text/event-stream" : "application/json",
      "Cache-Control": "no-store",
      "X-Provider": provider.id,
      "X-Request-Sha256": reqSha256,
    },
  });
}
