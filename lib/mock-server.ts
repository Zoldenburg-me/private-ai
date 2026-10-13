import { createHash, randomBytes } from "node:crypto";
import { mockReport, mockSign, mockAddress } from "./mock-tee";

/** DEV/TEST ONLY mock enclave provider (enabled with MOCK_PROVIDER=1). Keeps hashes only, never content. */
// globalThis: Next bundles each route separately, so module-level state isn't shared across routes.
const g = globalThis as unknown as { __paiMockReceipts?: Map<string, string> };
const receipts = (g.__paiMockReceipts ??= new Map<string, string>());
export const mockEnabled = () => process.env.MOCK_PROVIDER === "1";
const off = () => Response.json({ error: "mock disabled" }, { status: 404 });

export function mockModels() {
  if (!mockEnabled()) return off();
  return Response.json({ data: [
    { id: "mock-tee-small", name: "Mock TEE Small", context_length: 32000 },
    { id: "mock-e2ee", name: "Mock E2EE", capabilities: { e2ee: true } },
    { id: "mock-anon-frontier", name: "Mock anonymised frontier", privacy: "anonymized" },
  ] });
}

export async function mockChat(req: Request) {
  if (!mockEnabled()) return off();
  const raw = await req.text();
  const body = JSON.parse(raw) as { stream?: boolean; messages: { content: string }[] };
  const id = "chatcmpl-" + randomBytes(8).toString("hex");
  const words = ["This", " is", " a", " mock", " enclave", " reply", "."];
  const reqHash = createHash("sha256").update(raw).digest("hex");
  if (!body.stream) {
    const out = JSON.stringify({ id, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: words.join("") }, finish_reason: "stop" }] });
    receipts.set(id, `${reqHash}:${createHash("sha256").update(out).digest("hex")}`);
    return new Response(out, { headers: { "Content-Type": "application/json" } });
  }
  const chunks = words.map((w) => `data: ${JSON.stringify({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: w } }] })}\n\n`);
  chunks.push("data: [DONE]\n\n");
  const full = chunks.join("");
  receipts.set(id, `${reqHash}:${createHash("sha256").update(full).digest("hex")}`);
  const enc = new TextEncoder();
  return new Response(new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); } }), { headers: { "Content-Type": "text/event-stream" } });
}

export function mockAttestation(req: Request) {
  if (!mockEnabled()) return off();
  const u = new URL(req.url);
  const nonce = u.searchParams.get("nonce") ?? "";
  const debug = u.searchParams.get("model") === "mock-debug";
  const r = mockReport(nonce, { debug });
  return Response.json({ gateway_attestation: r, model_attestations: [r] });
}

export function mockSignature(id: string) {
  if (!mockEnabled()) return off();
  const text = receipts.get(id);
  if (!text) return Response.json({ error: "unknown chat id" }, { status: 404 });
  return Response.json({ text, signature: mockSign(text), signing_address: mockAddress(), signing_algo: "ecdsa" });
}
