import { createHash, randomBytes } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import { mockReport, mockSign, mockAddress, mockEd25519Report, mockEd25519Pub, MOCK_ED25519_SEED } from "./mock-tee";
import { mapReplyFields, mapRequestFields, openField, sealField } from "./client/e2e/near";

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

const HEX32 = /^[0-9a-f]{64}$/i;

/**
 * NEAR E2EE v2 as the model enclave does it: opens the request fields with the mock's Ed25519 key and
 * returns a sealer for reply fields. Stricter than NEAR (which passes plaintext tool fields through), so
 * tests catch a field the client forgot to seal. Null: not an E2EE request. A Response: refused.
 */
function mockE2e(req: Request, raw: string): { seal: <T extends object>(o: T) => T } | Response | null {
  const h = (k: string) => req.headers.get(k);
  if (!h("x-signing-algo") && !h("x-client-pub-key")) return null;
  const bad = (error: string) => Response.json({ error }, { status: 400 });
  const client = h("x-client-pub-key") ?? "";
  if (h("x-signing-algo") !== "ed25519" || !HEX32.test(client)) return bad("E2EE needs X-Signing-Algo ed25519 and an Ed25519 X-Client-Pub-Key");
  if (h("x-encryption-version") !== "2") return bad("mock speaks E2EE version 2 only");
  const pinned = h("x-model-pub-key");
  if (pinned && pinned.toLowerCase() !== mockEd25519Pub()) return bad("no backend with that model key");
  try {
    mapRequestFields(JSON.parse(raw), (s) => openField(s, MOCK_ED25519_SEED));
  } catch {
    return bad("Decryption failed");
  }
  return { seal: (o) => mapReplyFields(o, (s) => sealField(s, client)) };
}

export async function mockChat(req: Request) {
  if (!mockEnabled()) return off();
  const raw = await req.text();
  const e2e = mockE2e(req, raw);
  if (e2e instanceof Response) return e2e;
  const seal = e2e?.seal ?? (<T extends object>(o: T) => o);
  const body = JSON.parse(raw) as { stream?: boolean; messages: { role?: string; content: string }[]; tools?: unknown[] };
  const id = "chatcmpl-" + randomBytes(8).toString("hex");
  const words = ["This", " is", " a", " mock", " enclave", " reply", "."];
  // Agent mode: call web_search once, then answer (a fixed query, so no prompt content is echoed).
  if (body.stream && body.tools?.length && body.messages.at(-1)?.role !== "tool") {
    const call = { index: 0, id: "call_mock", type: "function", function: { name: "web_search", arguments: '{"query":"mock search"}' } };
    const out = [`data: ${JSON.stringify(seal({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [call] }, finish_reason: "tool_calls" }] }))}\n\n`, "data: [DONE]\n\n"].join("");
    return new Response(out, { headers: { "Content-Type": "text/event-stream" } });
  }
  const reqHash = createHash("sha256").update(raw).digest("hex");
  if (!body.stream) {
    const out = JSON.stringify(seal({ id, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: words.join("") }, finish_reason: "stop" }] }));
    receipts.set(id, `${reqHash}:${createHash("sha256").update(out).digest("hex")}`);
    return new Response(out, { headers: { "Content-Type": "application/json" } });
  }
  const chunks = words.map((w) => `data: ${JSON.stringify(seal({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: w } }] }))}\n\n`);
  // NEAR ends an E2EE stream with plaintext usage, so the relay can still bill.
  if (e2e) chunks.push(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: words.length, total_tokens: 1 + words.length } })}\n\n`);
  chunks.push("data: [DONE]\n\n");
  const full = chunks.join("");
  receipts.set(id, `${reqHash}:${createHash("sha256").update(full).digest("hex")}`);
  const enc = new TextEncoder();
  return new Response(new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); } }), { headers: { "Content-Type": "text/event-stream" } });
}

/** Brave-shaped search results for agent mode in dev/e2e. */
export function mockSearch() {
  if (!mockEnabled()) return off();
  return Response.json({ web: { results: [{ title: "Mock result", url: "https://example.org/mock", description: "A mock search snippet." }] } });
}

/** OpenAI-shaped image for agent mode in dev/e2e: a 64x64 gradient PNG, stored uncompressed so it passes the placeholder size check. */
export function mockImage() {
  if (!mockEnabled()) return off();
  const chunk = (type: string, data: Buffer) => {
    const td = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(64, 0); ihdr.writeUInt32BE(64, 4); ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const rows = Buffer.concat(Array.from({ length: 64 }, (_, y) => Buffer.from([0, ...Array.from({ length: 64 }, (_, x) => [x * 4, y * 4, 160]).flat()])));
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows, { level: 0 })), chunk("IEND", Buffer.alloc(0))]);
  return Response.json({ data: [{ b64_json: png.toString("base64") }] });
}

export function mockAttestation(req: Request) {
  if (!mockEnabled()) return off();
  const u = new URL(req.url);
  const nonce = u.searchParams.get("nonce") ?? "";
  const debug = u.searchParams.get("model") === "mock-debug";
  if (u.searchParams.get("signing_algo") === "ed25519") {
    if (!HEX32.test(nonce)) return Response.json({ error: "nonce must be 32 bytes of hex" }, { status: 400 });
    const r = mockEd25519Report(nonce.toLowerCase(), { debug });
    return Response.json({ gateway_attestation: r, model_attestations: [r] });
  }
  const r = mockReport(nonce, { debug });
  return Response.json({ gateway_attestation: r, model_attestations: [r] });
}

export function mockSignature(id: string) {
  if (!mockEnabled()) return off();
  const text = receipts.get(id);
  if (!text) return Response.json({ error: "unknown chat id" }, { status: 404 });
  return Response.json({ text, signature: mockSign(text), signing_address: mockAddress(), signing_algo: "ecdsa" });
}
