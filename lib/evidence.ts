import { loadProviders, parseModelRef } from "./providers";
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
  const p = loadProviders().find((x) => x.id === ref.provider);
  if (!p) return fail(503, "provider not configured");
  if (!(await getCatalog()).some((m) => m.provider === ref.provider && m.id === ref.model)) return fail(400, "unknown model");
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
  const r = await fetchImpl(target, { headers: { Authorization: `Bearer ${p.apiKey}` }, cache: "no-store" });
  if (!r.ok) return fail(502, "evidence unavailable");
  return new Response(await r.text(), { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
});
