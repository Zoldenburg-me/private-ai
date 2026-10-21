import { APIError } from "openai";
import { PrivatemodeAI } from "privatemode-ai";
import { VERIFY_FAIL_CACHE_MS } from "./tinfoil";

/** One client per API key: each holds its own verified attestation and encryption secret. */
const clients = new Map<string, PrivatemodeAI>();
/** A passing verify() per key, kept until a request through that client fails; see privatemodeVerified. */
const verified = new Map<string, Promise<unknown>>();
let failedAt = -Infinity;

// The relay owns retries and timeouts; an SDK retry would send the prompt twice.
const clientFor = (apiKey: string) =>
  clients.get(apiKey) ?? clients.set(apiKey, new PrivatemodeAI({ apiKey, enableWasmLogging: false, openAIOptions: { maxRetries: 0 } })).get(apiKey)!;

/**
 * fetch for the Privatemode provider: the Privatemode SDK (Wasm, in this process) verifies the deployment's
 * attestation before the first request and encrypts request and response end to end, so no local
 * privatemode-proxy is needed. A failed attestation sends nothing and throws; the next request attests again.
 * The path after `/v1` of the configured base URL is sent; the key comes from the Authorization header.
 */
export const privatemodeFetch: typeof fetch = async (input, init) => {
  const req = new Request(input, init);
  const apiKey = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const client = clientFor(apiKey);
  const path = new URL(req.url).pathname.replace(/^.*?\/v1(?=\/)/, "");
  try {
    if (req.method === "GET") return await client.get(path, { signal: req.signal }).asResponse();
    return await client.post(path, { body: await req.json(), signal: req.signal }).asResponse();
  } catch (e) {
    // The SDK throws on HTTP errors; hand them back as responses so callers see the status like any other provider.
    if (e instanceof APIError && e.status) return Response.json(e.error ?? {}, { status: e.status });
    // Attestation or transport failed: the next proof check must attest again rather than reuse the old pass.
    verified.delete(apiKey);
    throw e;
  }
};

/**
 * Whether the Privatemode SDK on this server holds a verified attestation of the deployment for this key.
 * A pass is reused until a request fails; a failure is remembered for VERIFY_FAIL_CACHE_MS.
 */
export async function privatemodeVerified(apiKey: string, now = Date.now()): Promise<boolean> {
  if (now - failedAt < VERIFY_FAIL_CACHE_MS) return false;
  let check = verified.get(apiKey);
  if (!check) verified.set(apiKey, (check = clientFor(apiKey).verify()));
  try { await check; return true; } catch { verified.delete(apiKey); failedAt = now; return false; }
}
