import { createHash } from "node:crypto";
import type { ProviderConfig } from "./providers";
import type { Logger } from "./log";

/**
 * Zero-content relay: forwards the body to the provider and pipes the stream back.
 * Never logs or stores content. Computes SHA-256 of the exact upstream request/response bytes
 * (hashes only) so the client can check provider response signatures, and appends them as a
 * final SSE event `pai_receipt`.
 */
export interface RelayOpts { provider: ProviderConfig; body: Record<string, unknown>; log: Logger; route: string; fetchImpl?: typeof fetch; extraHeaders?: Record<string, string> }

export async function relay({ provider, body, log, route, fetchImpl = fetch, extraHeaders = {} }: RelayOpts): Promise<Response> {
  const started = Date.now();
  const reqText = JSON.stringify(body);
  const reqSha256 = createHash("sha256").update(reqText).digest("hex");
  let upstream: Response;
  try {
    upstream = await fetchImpl(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${provider.apiKey}` },
      body: reqText,
    });
  } catch {
    log({ route, provider: provider.id, event: "upstream_unreachable", status: 502, ms: Date.now() - started });
    return Response.json({ error: { message: "provider unreachable" } }, { status: 502, headers: extraHeaders });
  }
  if (!upstream.ok || !upstream.body) {
    log({ route, provider: provider.id, status: upstream.status, event: "upstream_error", ms: Date.now() - started });
    return Response.json({ error: { message: `provider error ${upstream.status}` } }, { status: 502, headers: extraHeaders });
  }
  const streaming = body.stream === true;
  const hash = createHash("sha256");
  let bytes = 0;
  let chatId = "";
  const dec = new TextDecoder();
  let head = "";
  const reader = upstream.body.getReader();
  const out = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      const { value, done } = await reader.read();
      if (done) {
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
    cancel() { reader.cancel().catch(() => {}); },
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
