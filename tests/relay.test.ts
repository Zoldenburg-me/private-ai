import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleChat } from "../lib/handler";
import { issueToken, setTier } from "../lib/session";
import { _reset } from "../lib/ratelimit";
import { metaLogger } from "../lib/log";
import { applyExtensions } from "../lib/extensions";
import { normaliseModel } from "../lib/catalog";

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
