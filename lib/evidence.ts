import { loadProviders, parseModelRef } from "./providers";

/** Fetch attestation / signature evidence from the provider (NEAR-style endpoints). Content-free. */
export async function proxyEvidence(kind: "attestation" | "signature", url: URL, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const ref = parseModelRef(url.searchParams.get("model") ?? "");
  if (!ref) return Response.json({ error: "model=<provider>:<model> required" }, { status: 400 });
  const p = loadProviders().find((x) => x.id === ref.provider);
  if (!p) return Response.json({ error: "provider not configured" }, { status: 503 });
  let target: string;
  if (kind === "attestation") {
    const nonce = url.searchParams.get("nonce") ?? "";
    if (!/^[0-9a-f]{64}$/i.test(nonce)) return Response.json({ error: "nonce must be 32 bytes hex" }, { status: 400 });
    target = `${p.baseUrl}/attestation/report?model=${encodeURIComponent(ref.model)}&nonce=${nonce}&signing_algo=ecdsa`;
  } else {
    const chatId = url.searchParams.get("chat_id") ?? "";
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(chatId)) return Response.json({ error: "chat_id required" }, { status: 400 });
    target = `${p.baseUrl}/signature/${chatId}?model=${encodeURIComponent(ref.model)}&signing_algo=ecdsa`;
  }
  const r = await fetchImpl(target, { headers: { Authorization: `Bearer ${p.apiKey}` }, cache: "no-store" });
  return new Response(await r.text(), { status: r.ok ? 200 : 502, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
