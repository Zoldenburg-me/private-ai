import { APIError } from "openai";
import { PrivatemodeAI } from "privatemode-ai";
import { VERIFY_FAIL_CACHE_MS } from "./tinfoil";

/** One client per API origin and key: each holds its own verified attestation and encryption secret. */
const clients = new Map<string, PrivatemodeAI>();
/** A passing verify() per client, kept until a request through that client fails; see privatemodeVerified. */
const verified = new Map<string, Promise<unknown>>();
let failedAt = -Infinity;

/** The SDK's apiBaseURL is the origin without /v1 (its default is https://api.privatemode.ai). */
const apiOrigin = (url: string) => url.replace(/\/v1(\/.*)?$/, "");

// The relay owns retries and timeouts; an SDK retry would send the prompt twice.
function clientFor(id: string, apiBaseURL: string, apiKey: string): PrivatemodeAI {
  let client = clients.get(id);
  if (!client) clients.set(id, (client = new PrivatemodeAI({ apiKey, apiBaseURL, enableWasmLogging: false, openAIOptions: { maxRetries: 0 } })));
  return client;
}

/** Passes the stream through unbuffered; an error mid-stream (after the first chunk) drops the cached pass. */
function dropPassOnStreamError(res: Response, id: string): Response {
  if (!res.body) return res;
  const reader = res.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(c) {
      try {
        const { done, value } = await reader.read();
        if (done) c.close(); else c.enqueue(value);
      } catch (e) { verified.delete(id); c.error(e); }
    },
    cancel: (reason) => reader.cancel(reason),
  });
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

/**
 * fetch for the Privatemode provider: the Privatemode SDK (Wasm, in this process) verifies the deployment's
 * attestation before the first request and encrypts request and response end to end, so no local
 * privatemode-proxy is needed. A failed attestation sends nothing and throws; the next request attests again.
 * The SDK talks to the configured base URL's origin; it gets the path after `/v1` (its own base URL adds `/v1`
 * back, see tests/privatemode-sdk-paths.test.ts). The key comes from the Authorization header.
 */
export const privatemodeFetch: typeof fetch = async (input, init) => {
  const req = new Request(input, init);
  const apiKey = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const url = new URL(req.url);
  const origin = apiOrigin(url.origin + url.pathname);
  const id = `${origin} ${apiKey}`;
  const client = clientFor(id, origin, apiKey);
  const path = url.pathname.replace(/^.*?\/v1(?=\/)/, "");
  try {
    const res = req.method === "GET" ? await client.get(path, { signal: req.signal }).asResponse()
      : await client.post(path, { body: await req.json(), signal: req.signal }).asResponse();
    return dropPassOnStreamError(res, id);
  } catch (e) {
    // The SDK throws on HTTP errors; hand them back as responses so callers see the status like any other provider.
    if (e instanceof APIError && e.status) return Response.json(e.error ?? {}, { status: e.status });
    // Attestation or transport failed: the next proof check must attest again rather than reuse the old pass.
    verified.delete(id);
    throw e;
  }
};

/**
 * Whether the Privatemode SDK on this server holds a verified attestation of the deployment at this base URL,
 * for this key. A pass is reused until a request fails; a failure is remembered for VERIFY_FAIL_CACHE_MS.
 */
export async function privatemodeVerified(baseUrl: string, apiKey: string, now = Date.now()): Promise<boolean> {
  if (now - failedAt < VERIFY_FAIL_CACHE_MS) return false;
  const origin = apiOrigin(baseUrl);
  const id = `${origin} ${apiKey}`;
  let check = verified.get(id);
  if (!check) verified.set(id, (check = clientFor(id, origin, apiKey).verify()));
  try { await check; return true; } catch { verified.delete(id); failedAt = now; return false; }
}
