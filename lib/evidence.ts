import { parseModelRef } from "./providers";
import { liveProviders } from "./provider-keys";
import { UPSTREAM_TIMEOUT_MS } from "./catalog";
import { getCatalog } from "./catalog-cache";
import { identityFrom } from "./session";
import { withStores } from "./store";
import { LIMITS, overLimit } from "./limits";

const fail = (status: number, message: string) => Response.json({ error: { message } }, { status, headers: { "Cache-Control": "no-store" } });

/**
 * Fetch attestation / signature evidence from the provider (NEAR-style endpoints). Content-free.
 * Each call spends the shared provider key, so it needs a session, a per-account limit and a
 * model from our catalog; upstream error bodies are never passed through.
 */
export const proxyEvidence = (kind: "attestation" | "signature", fetchImpl: typeof fetch = fetch) => withStores(async (req: Request): Promise<Response> => {
  const id = await identityFrom(req); if (!id) return fail(401, "missing or invalid session token");
  const limited = await overLimit(LIMITS.evidence, `evidence:${id}`) ?? await overLimit(LIMITS.evidenceAll, "evidence-all"); if (limited) return limited;
  const url = new URL(req.url);
  const ref = parseModelRef(url.searchParams.get("model") ?? "");
  if (!ref) return fail(400, "model=<provider>:<model> required");
  const p = (await liveProviders()).find((x) => x.id === ref.provider);
  if (!p) return fail(503, "provider not configured");
  const entry = (await getCatalog()).find((m) => m.provider === ref.provider && m.id === ref.model);
  if (!entry) return fail(400, "unknown model");
  if (entry.privacy === "anonymized") return fail(404, "no enclave evidence: anonymized models run at the model vendor");
  let target: string;
  if (kind === "attestation") {
    const nonce = url.searchParams.get("nonce") ?? "";
    if (!/^[0-9a-f]{64}$/i.test(nonce)) return fail(400, "nonce must be 32 bytes hex");
    target = `${p.baseUrl}/attestation/report?model=${encodeURIComponent(ref.model)}&nonce=${nonce}&signing_algo=ecdsa`;
  } else {
    const chatId = url.searchParams.get("chat_id") ?? "";
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(chatId)) return fail(400, "chat_id required");
    target = `${p.baseUrl}/signature/${chatId}?model=${encodeURIComponent(ref.model)}&signing_algo=ecdsa`;
  }
  let r: Response, text: string;
  try {
    r = await fetchImpl(target, { headers: { Authorization: `Bearer ${p.apiKey}` }, cache: "no-store", signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    text = await r.text();
  } catch {
    return fail(502, "evidence unavailable"); // unreachable or timed out
  }
  if (!r.ok) return fail(502, "evidence unavailable");
  return new Response(text, { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
});
