import { createHash } from "node:crypto";
import type { ProviderConfig } from "./providers";
import type { Logger } from "./log";
import { providerFetch } from "./provider-fetch";

/**
 * Zero-content relay: forwards the body to the provider and pipes the stream back.
 * Never logs or stores content. Computes SHA-256 of the exact upstream request/response bytes
 * (hashes only) so the client can check provider response signatures, and appends them as a
 * final SSE event `pai_receipt`.
 */
export interface RelayOpts { provider: ProviderConfig; body: Record<string, unknown>; log: Logger; route: string; fetchImpl?: typeof fetch; extraHeaders?: Record<string, string> }

/** Wait for upstream headers. Non-streaming replies only arrive once the whole answer is generated, so they get longer. */
export const FIRST_BYTE_TIMEOUT_MS = { stream: 30_000, json: 120_000 };
/** Max silence between two upstream chunks, and the hard cap on the whole exchange. */
export const IDLE_TIMEOUT_MS = 30_000;
export const TOTAL_TIMEOUT_MS = 300_000;

export async function relay({ provider, body, log, route, fetchImpl = providerFetch(provider.id), extraHeaders = {} }: RelayOpts): Promise<Response> {
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
  // Only the relay writes `pai_receipt`: upstream blocks of that event are dropped, line by line across chunks.
  const sse = new TextDecoder();
  let line = ""; let dropping = false;
  const reader = upstream.body.getReader();
  const out = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      idle = setTimeout(() => abort.abort(), IDLE_TIMEOUT_MS);
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await Promise.race([reader.read(), aborted]); } catch {
        const timedOut = abort.signal.aborted;
        stopTimers(); abort.abort(); reader.cancel().catch(() => {});
        log({ route, provider: provider.id, event: timedOut ? "upstream_timeout" : "upstream_error", status: timedOut ? 504 : 502, ms: Date.now() - started, outputBytes: bytes });
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
        ctrl.close();
        return;
      }
      hash.update(value); bytes += value.length;
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
      const kept = lines.filter((l) => {
        const t = l.trim();
        if (t.startsWith("event:")) dropping = t.slice(6).trim() === "pai_receipt";
        else if (t === "") dropping = false;
        return !dropping;
      });
      // Enqueued even when empty: a pull that enqueues nothing is not called again.
      ctrl.enqueue(new TextEncoder().encode(kept.length ? kept.join("\n") + "\n" : ""));
    },
    cancel() { stopTimers(); abort.abort(); reader.cancel().catch(() => {}); },
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
