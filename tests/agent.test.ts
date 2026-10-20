import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleAgent, handleChat } from "../lib/handler";
import { issueToken } from "../lib/session";
import { _reset } from "../lib/ratelimit";
import { normaliseModel } from "../lib/catalog";
import { parseSseChunk } from "../lib/sse";

const PROMPT = "SECRET-QUESTION-5d1e";
const QUERY = "SECRET-QUERY-a71c";
const SNIPPET = "SECRET-SNIPPET-0b9f";
const env = { MOCK_PROVIDER: "1", MOCK_BASE_URL: "http://upstream/v1", BRAVE_SEARCH_API_KEY: "brave-key" };
const catalog = async () => [normaliseModel({ id: "mock", privacy: "tee-attested" }, { id: "m" })];
const enc = new TextEncoder();
const sse = (events: unknown[]) => new Response(new ReadableStream({ start(c) {
  for (const e of events) c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
  c.enqueue(enc.encode("data: [DONE]\n\n")); c.close();
} }));
// Phala-style: arguments arrive in pieces, keyed by index; id and name only on the first piece.
const toolCallStream = (id: string) => sse([
  { id, choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "web_search", arguments: "" } }] } }] },
  { id, choices: [{ delta: { tool_calls: [{ index: 0, id: null, function: { name: null, arguments: `{"query": ` } }] } }] },
  { id, choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: `"${QUERY}"}` } }] }, finish_reason: "tool_calls" }] },
]);
const answerStream = (id: string) => sse([{ id, choices: [{ delta: { content: "Answer [1]" } }] }, { id, choices: [{ delta: {}, finish_reason: "stop" }] }]);
const braveOk = () => Response.json({ web: { results: [{ title: "T1", url: "https://example.org/a", description: SNIPPET }] } });

const req = (token: string, body: unknown) => new Request("http://app/api/agent", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
const ask = { model: "mock:m", stream: true, messages: [{ role: "user", content: PROMPT }], pai_options: { web_search: true } };

/** Upstream mock: model calls by URL, search by Brave URL. `script` returns the model reply for call n. */
function upstream(script: (n: number, body: Record<string, unknown>) => Response, search: () => Response = braveOk) {
  const model: Record<string, unknown>[] = []; const searches: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    if (url.startsWith("https://api.search.brave.com/")) { searches.push({ url, init }); return search(); }
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    model.push(body);
    return script(model.length, body);
  }) as unknown as typeof fetch;
  return { fetchImpl, model, searches };
}

async function events(res: Response) {
  const p = parseSseChunk((await res.text()) + "\n");
  return { text: p.deltas.join(""), tools: p.tools, receipt: p.receipt, error: p.error };
}

beforeEach(() => { _reset(); });
afterEach(() => vi.restoreAllMocks());

describe("agent loop", () => {
  it("runs search, feeds results back, streams tool steps, answer and receipt; logs no content", async () => {
    const { token } = issueToken();
    const u = upstream((n) => (n === 1 ? toolCallStream("c1") : answerStream("c2")));
    const logged: unknown[] = [];
    const res = await handleAgent(req(token, ask), "/api/agent", { catalog, env, fetchImpl: u.fetchImpl, log: (m) => logged.push(m) });
    expect(res.status).toBe(200);
    const out = await events(res);
    expect(out.text).toBe("Answer [1]");
    expect(out.tools.map((t) => t.status)).toEqual(["running", "done"]);
    expect(out.tools[1]).toMatchObject({ id: "call_1", name: "web_search", query: QUERY, results: [{ title: "T1", url: "https://example.org/a" }] });
    expect(out.receipt).toMatchObject({ chat_id: "c2", provider: "mock", model: "m" });

    expect(u.model).toHaveLength(2);
    expect(u.model[0].tools).toEqual([expect.objectContaining({ type: "function", function: expect.objectContaining({ name: "web_search" }) })]);
    const msgs = u.model[1].messages as { role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string }[];
    expect(msgs[0].role).toBe("system"); // untrusted-tool-output rule comes first
    expect(msgs.at(-2)).toMatchObject({ role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "web_search", arguments: `{"query": "${QUERY}"}` } }] });
    expect(msgs.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call_1" });
    expect(msgs.at(-1)!.content).toContain(SNIPPET);

    const all = JSON.stringify(logged);
    for (const s of [PROMPT, QUERY, SNIPPET]) expect(all).not.toContain(s);
    expect(logged).toContainEqual(expect.objectContaining({ event: "tool_call", tool: "web_search", status: 200 }));
  });

  it("sends the search provider only the query: no identity, no session", async () => {
    const { token } = issueToken();
    const u = upstream((n) => (n === 1 ? toolCallStream("c1") : answerStream("c2")));
    await (await handleAgent(req(token, ask), "/api/agent", { catalog, env, fetchImpl: u.fetchImpl })).text();
    expect(u.searches).toHaveLength(1);
    const url = new URL(u.searches[0].url);
    expect([...url.searchParams.keys()].sort()).toEqual(["count", "q"]);
    expect(url.searchParams.get("q")).toBe(QUERY);
    expect(Object.keys(u.searches[0].init.headers as Record<string, string>).sort()).toEqual(["Accept", "X-Subscription-Token"]);
    expect(JSON.stringify(u.searches[0])).not.toContain(token);
  });

  it("a failed search goes back to the model as a tool error and the run still answers", async () => {
    const { token } = issueToken();
    const u = upstream((n) => (n === 1 ? toolCallStream("c1") : answerStream("c2")), () => new Response("down", { status: 500 }));
    const out = await events(await handleAgent(req(token, ask), "/api/agent", { catalog, env, fetchImpl: u.fetchImpl }));
    expect(out.tools.at(-1)).toMatchObject({ status: "error" });
    expect(out.text).toBe("Answer [1]");
    const msgs = u.model[1].messages as { role: string; content: string }[];
    expect(msgs.at(-1)!.content).toMatch(/error/i);
  });

  it("stops at the tier's step limit: the last step offers no tools, so the model must answer", async () => {
    const { token } = issueToken(); // free tier
    const u = upstream((n, body) => (body.tools ? toolCallStream(`c${n}`) : answerStream(`c${n}`)));
    const out = await events(await handleAgent(req(token, ask), "/api/agent", { catalog, env, fetchImpl: u.fetchImpl }));
    expect(u.model).toHaveLength(3);
    expect(u.model[2]).not.toHaveProperty("tools");
    expect(out.text).toBe("Answer [1]");
  });

  it("each step counts against the rate limit", async () => {
    const { token } = issueToken(); // free: 5 requests per minute
    const u = upstream((n) => (n % 2 === 1 ? toolCallStream(`c${n}`) : answerStream(`c${n}`)));
    const deps = { catalog, env, fetchImpl: u.fetchImpl };
    for (let i = 0; i < 2; i++) await (await handleAgent(req(token, ask), "/api/agent", deps)).text(); // 4 steps
    const third = await handleAgent(req(token, ask), "/api/agent", deps); // step 5 allowed, step 6 gated
    const out = await events(third);
    expect(u.model).toHaveLength(5);
    expect(out.error).toMatch(/rate limit/);
  });

  it("an upstream failure mid-run reaches the client as agent_error, not a broken stream", async () => {
    const { token } = issueToken();
    const u = upstream((n) => (n === 1 ? toolCallStream("c1") : new Response("boom", { status: 500 })));
    const logged: { event?: string }[] = [];
    const out = await events(await handleAgent(req(token, ask), "/api/agent", { catalog, env, fetchImpl: u.fetchImpl, log: (m) => logged.push(m) }));
    expect(out.error).toBe("provider error 500");
    expect(logged.map((m) => m.event)).toContain("agent_error");
  });

  it("a client disconnect stops the run without logging a timeout", async () => {
    const { token } = issueToken();
    let release!: () => void;
    const slow = new Promise<void>((r) => { release = r; });
    const u = upstream(() => new Response(new ReadableStream({ async pull(c) { await slow; c.close(); } })));
    const logged: { event?: string }[] = [];
    const res = await handleAgent(req(token, ask), "/api/agent", { catalog, env, fetchImpl: u.fetchImpl, log: (m) => logged.push(m) });
    await res.body!.cancel();
    release(); await new Promise((r) => setTimeout(r, 10));
    expect(logged.map((m) => m.event)).not.toContain("upstream_timeout");
  });

  it("rejects client-supplied tools, and web_search when no search key is configured", async () => {
    const { token } = issueToken();
    const u = upstream(() => answerStream("c"));
    const deps = { catalog, env, fetchImpl: u.fetchImpl };
    expect((await handleAgent(req(token, { ...ask, tools: [{ type: "function", function: { name: "x" } }] }), "/api/agent", deps)).status).toBe(400);
    expect((await handleAgent(req(token, ask), "/api/agent", { ...deps, env: { BRAVE_SEARCH_API_KEY: "" } })).status).toBe(503);
    expect(u.model).toHaveLength(0);
  });

  it("the plain chat route still refuses web_search", async () => {
    const { token } = issueToken();
    const u = upstream(() => answerStream("c"));
    expect((await handleChat(req(token, ask), "/api/chat", { catalog, env, fetchImpl: u.fetchImpl })).status).toBe(400);
  });
});
