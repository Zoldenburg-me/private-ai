import { createHash } from "node:crypto";
import type { ProviderConfig } from "./providers";
import type { Logger } from "./log";
import { tinfoilFetch } from "./tinfoil";

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

export async function relay({ provider, body, log, route, fetchImpl = provider.id === "tinfoil" ? tinfoilFetch : fetch, extraHeaders = {} }: RelayOpts): Promise<Response> {
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
          ctrl.enqueue(new TextEncoder().encode(`event: pai_receipt\ndata: ${JSON.stringify(receipt)}\n\n`));
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
      ctrl.enqueue(value);
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
