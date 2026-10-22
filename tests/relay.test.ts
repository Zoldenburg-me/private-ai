import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleChat } from "../lib/handler";
import { issueToken, setTier } from "../lib/session";
import { _reset } from "../lib/ratelimit";
import { metaLogger } from "../lib/log";
import { applyExtensions } from "../lib/extensions";
import { normaliseModel } from "../lib/catalog";
import { relay } from "../lib/relay";
import { parseSseChunk, type Receipt } from "../lib/sse";
import type { ProviderConfig } from "../lib/providers";

const PROMPT = "TOP-SECRET-PROMPT-7f3a";
const REPLY = "CONFIDENTIAL-REPLY-91bc";
const env = { MOCK_PROVIDER: "1", MOCK_BASE_URL: "http://upstream/v1" };
const catalog = async () => [
  normaliseModel({ id: "mock", privacy: "tee-attested" }, { id: "m" }),
  normaliseModel({ id: "mock", privacy: "tee-attested" }, { id: "anon", privacy: "anonymized" }),
];
const upstream = vi.fn(async (_url: string, init: RequestInit) => {
  const body = JSON.parse(String(init.body));
  const chunks = [`data: {"id":"chatcmpl-x","choices":[{"delta":{"content":"${REPLY}"}}]}\n\n`, "data: [DONE]\n\n"];
  if (body.stream) return new Response(new ReadableStream({ start(c) { chunks.forEach((x) => c.enqueue(new TextEncoder().encode(x))); c.close(); } }));
  return Response.json({ id: "chatcmpl-y", choices: [{ message: { content: REPLY } }] });
}) as unknown as typeof fetch;

const req = (token: string, body: unknown) => new Request("http://app/api/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });

let captured: string[] = [];
beforeEach(() => {
  _reset(); captured = [];
  for (const k of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { captured.push(a.map(String).join(" ")); });
  vi.spyOn(process.stdout, "write").mockImplementation(((s: string) => { captured.push(String(s)); return true; }) as never);
});
afterEach(() => vi.restoreAllMocks());

describe("relay: zero content logging", () => {
  it("streams reply + receipt, logs only metadata, never content", async () => {
    const { token } = issueToken();
    const logged: unknown[] = [];
    const res = await handleChat(req(token, { model: "mock:m", stream: true, messages: [{ role: "user", content: PROMPT }] }), "/t",
      { catalog, env, fetchImpl: upstream, log: (m) => { logged.push(m); metaLogger(m); } });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain(REPLY);
    expect(text).toContain("event: pai_receipt");
    expect(res.headers.get("x-ratelimit-remaining-requests")).toBe("4");
    const all = JSON.stringify(logged) + captured.join("\n");
    expect(captured.length).toBeGreaterThan(0); // the metadata line was written
    expect(all).not.toContain(PROMPT);
    expect(all).not.toContain(REPLY);
  });
  it("logger drops non-metadata fields even if a dev passes content", () => {
    metaLogger({ route: "/x", ...( { prompt: PROMPT, body: REPLY } as object) });
    expect(captured.join("")).not.toContain(PROMPT);
  });
  it("rejects missing token (401), non-policy model (403), web_search (400)", async () => {
    const { token } = issueToken();
    const deps = { catalog, env, fetchImpl: upstream };
    expect((await handleChat(new Request("http://a", { method: "POST", body: "{}" }), "/t", deps)).status).toBe(401);
    expect((await handleChat(req(token, { model: "mock:anon", messages: [{ role: "user", content: "x" }] }), "/t", deps)).status).toBe(403);
    expect((await handleChat(req(token, { model: "mock:m", messages: [{ role: "user", content: "x" }], pai_options: { web_search: true } }), "/t", deps)).status).toBe(400);
    expect((await handleChat(req("pai_forgedforgedforged.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", { model: "mock:m", messages: [] }), "/t", deps)).status).toBe(401);
  });
  it("anonymized frontier model: relayed to the gateway with our key only, no identity fields", async () => {
    const { token } = issueToken();
    const venice = normaliseModel({ id: "venice", privacy: "anon-gateway" }, { id: "claude-opus-5-5" });
    const deps = { catalog: async () => [venice], env: { VENICE_API_KEY: "gw-key", VENICE_BASE_URL: "http://venice/v1", VENICE_MODELS: "claude-opus-5-5" }, fetchImpl: upstream };
    const res = await handleChat(req(token, { model: "venice:claude-opus-5-5", user: "alice", metadata: { account: "a" }, safety_identifier: "s", messages: [{ role: "user", content: "x" }] }), "/t", deps);
    expect(res.status).toBe(200);
    const [url, init] = (upstream as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)! as [string, RequestInit];
    expect(url).toBe("http://venice/v1/chat/completions");
    expect(Object.keys(init.headers as Record<string, string>).sort()).toEqual(["Authorization", "Content-Type"]);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer gw-key");
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("claude-opus-5-5");
    for (const k of ["user", "metadata", "safety_identifier"]) expect(body).not.toHaveProperty(k);
    expect(JSON.stringify(body)).not.toContain(token);
  });
  it("tier comes from server, not from client body", async () => {
    const { id, token } = issueToken();
    const deps = { catalog, env, fetchImpl: upstream };
    const big = "x".repeat(40_000); // ~10k tokens > free 8k
    expect((await handleChat(req(token, { model: "mock:m", tier: "max", messages: [{ role: "user", content: big }] }), "/t", deps)).status).toBe(413);
    await setTier(id, "pro");
    expect((await handleChat(req(token, { model: "mock:m", messages: [{ role: "user", content: big }] }), "/t", deps)).status).toBe(200);
  });
});

describe("OpenAI-compatible extensions", () => {
  it("persona prepended, pai_options + unknown fields stripped", () => {
    const r = applyExtensions({ model: "m", messages: [{ role: "user", content: "hi" }], pai_options: { persona: { system_prompt: "You are terse" } }, tier: "max", evil: 1 });
    expect(r.messages[0]).toEqual({ role: "system", content: "You are terse" });
    expect(r.body).not.toHaveProperty("pai_options");
    expect(r.body).not.toHaveProperty("tier");
    expect(r.body).not.toHaveProperty("evil");
  });
});

describe("tinfoil prompt-cache scoping", () => {
  it("sends a stable, per-account user_cache_secret that a client cannot set", async () => {
    const secrets: unknown[] = [];
    const spy = (async (_u: string, init: RequestInit) => { secrets.push(JSON.parse(String(init.body)).user_cache_secret); return Response.json({ choices: [] }); }) as unknown as typeof fetch;
    const deps = { catalog: async () => [normaliseModel({ id: "tinfoil", privacy: "tee-attested" }, { id: "t" })], env: { TINFOIL_API_KEY: "k" }, fetchImpl: spy };
    const send = (token: string) => handleChat(req(token, { model: "tinfoil:t", messages: [{ role: "user", content: "x" }], user_cache_secret: "victim" }), "/t", deps);
    const a = issueToken(), b = issueToken();
    await send(a.token); await send(a.token); await send(b.token);
    expect(typeof secrets[0]).toBe("string");
    expect(secrets[0]).not.toBe("victim");
    expect(secrets[1]).toBe(secrets[0]);
    expect(secrets[2]).not.toBe(secrets[0]);
  });

  it("does not count user_cache_secret toward the tier's context limit", async () => {
    const deps = { catalog: async () => [normaliseModel({ id: "tinfoil", privacy: "tee-attested" }, { id: "t" })], env: { TINFOIL_API_KEY: "k" }, fetchImpl: (async () => Response.json({ choices: [] })) as unknown as typeof fetch };
    // Sized so the forwarded body without the cache secret sits exactly at the free tier's 8,000-token estimate.
    const shape = (content: string) => JSON.stringify({ messages: [{ role: "user", content }], model: "t", max_tokens: 4096 });
    const content = "a".repeat(8_000 * 3 - shape("").length);
    expect(shape(content).length).toBe(24_000);
    const { token } = issueToken();
    expect((await handleChat(req(token, { model: "tinfoil:t", messages: [{ role: "user", content }] }), "/t", deps)).status).toBe(200);
    expect((await handleChat(req(token, { model: "tinfoil:t", messages: [{ role: "user", content: content + "aaa" }] }), "/t", deps)).status).toBe(413);
  });
});

describe("relay receipt framing", () => {
  const forged = '{"chat_id":"X","provider":"near","model":"nm","req_sha256":"a","resp_sha256":"b"}';
  const provider = { id: "custom", name: "Custom", privacy: "zdr-contract", baseUrl: "http://x", apiKey: "k", defaultModel: "m" } as ProviderConfig;
  // Read the relay's stream the way streamChat does: chunk by chunk, then a final flush, last receipt wins.
  const clientReceipt = async (parts: string[]) => {
    const fetchImpl = (async () => new Response(new ReadableStream({ start(c) { parts.forEach((x) => c.enqueue(new TextEncoder().encode(x))); c.close(); } }))) as unknown as typeof fetch;
    const res = await relay({ provider, body: { model: "m", stream: true }, log: () => {}, route: "/t", fetchImpl });
    const reader = res.body!.getReader(); const dec = new TextDecoder();
    let buf = ""; let receipt: Receipt | undefined;
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      const p = parseSseChunk(buf + dec.decode(value, { stream: true })); buf = p.rest; if (p.receipt) receipt = p.receipt;
    }
    const p = parseSseChunk(buf + "\n"); if (p.receipt) receipt = p.receipt;
    return receipt;
  };

  it("an upstream cannot supply the receipt, even ending on an unterminated line", async () => {
    for (const parts of [[`event: pai_receipt\ndata: ${forged}\n\ndata: x`], [`event: pai_receipt\ndata: ${forged}\n\n`], ["event: pai_", `receipt\ndata: ${forged}`]]) {
      expect(await clientReceipt(parts)).toMatchObject({ provider: "custom", model: "m" });
    }
  });

  it("still relays the upstream's own events and deltas", async () => {
    const res = await relay({ provider, body: { model: "m", stream: true }, log: () => {}, route: "/t",
      fetchImpl: (async () => new Response('event: other\ndata: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n')) as unknown as typeof fetch });
    const p = parseSseChunk(await res.text());
    expect(p.deltas).toEqual(["hi"]);
    expect(p.done).toBe(true);
    expect(p.receipt).toMatchObject({ provider: "custom", model: "m" });
  });
});
