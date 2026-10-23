import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleAgent, handleChat } from "../lib/handler";
import { issueToken, setTier } from "../lib/session";
import { _reset, usage } from "../lib/ratelimit";
import { normaliseModel } from "../lib/catalog";
import { parseSseChunk } from "../lib/sse";
import { createHash } from "node:crypto";
import { MAX_SEARCHES_PER_RUN } from "../lib/agent";
import { FIRST_BYTE_TIMEOUT_MS, IDLE_TIMEOUT_MS } from "../lib/relay";
import { GET as sessionGET } from "../app/api/session/route";

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
    expect(out.tools[1]).toMatchObject({ id: "call_1_0", name: "web_search", query: QUERY, results: [{ title: "T1", url: "https://example.org/a" }] });
    expect(out.receipt).toMatchObject({ chat_id: "c2", provider: "mock", model: "m" });

    expect(u.model).toHaveLength(2);
    expect(u.model[0].tools).toEqual([expect.objectContaining({ type: "function", function: expect.objectContaining({ name: "web_search" }) })]);
    const msgs = u.model[1].messages as { role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string }[];
    expect(msgs[0].role).toBe("system"); // untrusted-tool-output rule comes first
    expect(msgs.at(-2)).toMatchObject({ role: "assistant", tool_calls: [{ id: "call_1_0", type: "function", function: { name: "web_search", arguments: `{"query": "${QUERY}"}` } }] });
    expect(msgs.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call_1_0" });
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

  it("pairs two parallel calls, and ids stay unique across steps even when the provider reuses them", async () => {
    const { id, token } = issueToken(); await setTier(id, "pro");
    const two = (id: string) => sse([{ id, choices: [{ delta: { tool_calls: [
      { index: 0, id: "dup", function: { name: "web_search", arguments: '{"query":"a"}' } },
      { index: 1, id: "dup", function: { name: "web_search", arguments: '{"query":"b"}' } },
    ] }, finish_reason: "tool_calls" }] }]);
    const u = upstream((n) => (n <= 2 ? two(`c${n}`) : answerStream("c3")));
    const out = await events(await handleAgent(req(token, ask), "/api/agent", { catalog, env, fetchImpl: u.fetchImpl }));
    expect(new Set(out.tools.map((t) => t.id))).toEqual(new Set(["call_1_0", "call_1_1", "call_2_0", "call_2_1"]));
    const msgs = u.model[2].messages as { role: string; tool_calls?: { id: string }[]; tool_call_id?: string }[];
    const callIds = msgs.flatMap((m) => m.tool_calls?.map((c) => c.id) ?? []);
    expect(msgs.filter((m) => m.role === "tool").map((m) => m.tool_call_id)).toEqual(callIds);
    expect(u.searches).toHaveLength(4);
  });

  it("an empty upstream answer and an unreachable provider are errors with our own text, never the transport's", async () => {
    const { token } = issueToken();
    const empty = upstream(() => sse([{ id: "c", choices: [{ delta: {}, finish_reason: "stop" }] }]));
    expect((await events(await handleAgent(req(token, ask), "/api/agent", { catalog, env, fetchImpl: empty.fetchImpl }))).error).toBe("empty provider response");
    const down = (async () => { throw new Error("connect ECONNREFUSED 10.0.0.5:443"); }) as unknown as typeof fetch;
    expect((await events(await handleAgent(req(token, ask), "/api/agent", { catalog, env, fetchImpl: down }))).error).toBe("provider unreachable");
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

describe("agent limits, receipts and timeouts", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it("a model stream cut before [DONE] or a finish_reason is an error, not a finished answer", async () => {
    const { token } = issueToken();
    const cut = () => new Response('data: {"id":"c","choices":[{"delta":{"content":"The result is"}}]}\n\n');
    const out = await events(await handleAgent(req(token, ask), "/api/agent", { catalog, env, fetchImpl: upstream(cut).fetchImpl }));
    expect(out.error).toBe("provider stream ended early");
    expect(out.receipt).toBeUndefined();
  });

  it("a tool call on the tool-less last step is an error, not an empty answer", async () => {
    const { token } = issueToken(); // free: 3 steps
    const u = upstream((n) => toolCallStream(`c${n}`));
    const out = await events(await handleAgent(req(token, ask), "/api/agent", { catalog, env, fetchImpl: u.fetchImpl }));
    expect(u.model).toHaveLength(3);
    expect(out.error).toBe("model did not answer");
    expect(out.receipt).toBeUndefined();
  });

  it("a model that rejects tool calls answers without search, as one message", async () => {
    const { token } = issueToken(); // free: 20 a day
    const u = upstream((n) => (n === 1 ? new Response("tools not supported", { status: 400 }) : answerStream("c2")));
    const res = await handleAgent(req(token, ask), "/api/agent", { catalog, env, fetchImpl: u.fetchImpl });
    const p = parseSseChunk((await res.text()) + "\n");
    expect(p.deltas.join("")).toBe("Answer [1]");
    expect(u.model).toHaveLength(2);
    expect(u.model[1].tools).toBeUndefined();
    expect(p.remaining).toBe("19");
  });

  it("a mid-run failure still reports the allowance the run used", async () => {
    const { token } = issueToken();
    const u = upstream((n) => (n === 1 ? toolCallStream("c1") : new Response("boom", { status: 500 })));
    const p = parseSseChunk((await (await handleAgent(req(token, ask), "/api/agent", { catalog, env, fetchImpl: u.fetchImpl })).text()) + "\n");
    expect(p.error).toBe("provider error 500");
    expect(p.remaining).toBe("18");
  });

  it("reports the daily allowance left after the last step, not after the first", async () => {
    const { token } = issueToken(); // free: 20 a day
    const u = upstream((n) => (n === 1 ? toolCallStream("c1") : answerStream("c2")));
    const res = await handleAgent(req(token, ask), "/api/agent", { catalog, env, fetchImpl: u.fetchImpl });
    expect(res.headers.get("x-usage-remaining-daily")).toBe("19");
    expect(parseSseChunk((await res.text()) + "\n").remaining).toBe("18");
  });

  it("the first step's context check counts the agent's system prompt and tool definition", async () => {
    const { token } = issueToken(); // free: 8,000 tokens
    const u = upstream(() => answerStream("c"));
    // Fits the cap on its own (about 7,970 tokens), not with the agent's additions.
    const near = { ...ask, messages: [{ role: "user", content: "x".repeat(23_800) }] };
    expect((await handleChat(req(token, { ...near, pai_options: undefined }), "/api/chat", { catalog, env, fetchImpl: u.fetchImpl })).status).toBe(200);
    expect((await handleAgent(req(token, near), "/api/agent", { catalog, env, fetchImpl: u.fetchImpl })).status).toBe(413);
  });

  it("drops search results that point at IP literals or local-network names", async () => {
    const { token } = issueToken();
    const urls = ["https://example.org/a", "http://192.168.1.1/admin", "http://2130706433/", "http://[::1]/", "http://localhost:8080/", "http://router/", "http://nas.local/", "http://db.internal/", "http://localhost../", "http://nas.local../", "http://box.tail1.ts.net/"];
    const brave = () => Response.json({ web: { results: urls.map((url) => ({ title: "t", url, description: "d" })) } });
    const u = upstream((n) => (n === 1 ? toolCallStream("c1") : answerStream("c2")), brave);
    const out = await events(await handleAgent(req(token, ask), "/api/agent", { catalog, env, fetchImpl: u.fetchImpl }));
    expect(out.tools.at(-1)!.results!.map((r) => r.url)).toEqual(["https://example.org/a"]);
    expect(String((u.model[1].messages as { content: string }[]).at(-1)!.content)).not.toContain("192.168");
  });

  it(`stops calling the search provider after ${MAX_SEARCHES_PER_RUN} searches in one run, whatever the tier allows`, async () => {
    const { id, token } = issueToken(); await setTier(id, "max");
    const two = (cid: string) => sse([{ id: cid, choices: [{ delta: { tool_calls: [
      { index: 0, function: { name: "web_search", arguments: '{"query":"a"}' } }, { index: 1, function: { name: "web_search", arguments: '{"query":"b"}' } },
    ] }, finish_reason: "tool_calls" }] }]);
    const u = upstream((n, body) => (body.tools ? two(`c${n}`) : answerStream(`c${n}`)));
    const out = await events(await handleAgent(req(token, ask), "/api/agent", { catalog, env, fetchImpl: u.fetchImpl }));
    expect(u.searches).toHaveLength(MAX_SEARCHES_PER_RUN);
    expect(out.tools.filter((t) => t.status === "error").length).toBeGreaterThan(0);
    expect(out.text).toBe("Answer [1]");
  });

  it("the receipt hashes are the exact bytes sent to and received from the answering step", async () => {
    const { token } = issueToken();
    const sent: string[] = []; const received: string[] = [];
    const answer = 'data: {"id":"c2","choices":[{"delta":{"content":"Answer"}}]}\n\ndata: [DONE]\n\n';
    const u = upstream((n) => (n === 1 ? toolCallStream("c1") : new Response(answer)));
    const fetchImpl = (async (url: string, init: RequestInit) => {
      if (!url.startsWith("https://api.search.brave.com/")) { sent.push(String(init.body)); received.push(answer); }
      return u.fetchImpl(url, init);
    }) as unknown as typeof fetch;
    const out = await events(await handleAgent(req(token, ask), "/api/agent", { catalog, env, fetchImpl }));
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    expect(out.receipt).toMatchObject({ chat_id: "c2", req_sha256: sha(sent.at(-1)!), resp_sha256: sha(received.at(-1)!) });
  });

  it("text from a step that ends in tool calls is never shown under the answering step's receipt", async () => {
    const { token } = issueToken();
    const PREAMBLE = "Unverified step-1 preamble. ";
    const answer = 'data: {"id":"c2","choices":[{"delta":{"content":"Final answer."}}]}\n\ndata: [DONE]\n\n';
    const u = upstream((n) => (n === 1
      ? sse([{ id: "c1", choices: [{ delta: { content: PREAMBLE } }] },
        { id: "c1", choices: [{ delta: { tool_calls: [{ index: 0, id: "x", function: { name: "web_search", arguments: `{"query":"${QUERY}"}` } }] }, finish_reason: "tool_calls" }] }])
      : new Response(answer)));
    const out = await events(await handleAgent(req(token, ask), "/api/agent", { catalog, env, fetchImpl: u.fetchImpl }));
    expect(out.text).toBe(PREAMBLE + "Final answer."); // still streamed live
    expect(out.receipt).toBeUndefined(); // step 2's receipt does not cover the preamble, so the reply carries none
    // The model still sees its own preamble in the next step.
    expect((u.model[1].messages as { role: string; content: string }[]).at(-2)).toMatchObject({ role: "assistant", content: PREAMBLE });
  });

  it("a step that answers without tool calls is shown in full under its receipt", async () => {
    const { token } = issueToken();
    const u = upstream(() => answerStream("c1"));
    const out = await events(await handleAgent(req(token, ask), "/api/agent", { catalog, env, fetchImpl: u.fetchImpl }));
    expect(u.model).toHaveLength(1);
    expect(u.model[0].tools).toBeDefined();
    expect(out.text).toBe("Answer [1]");
    expect(out.receipt).toMatchObject({ chat_id: "c1" });
  });

  it("a preamble before the forced tool-less last step also leaves the reply without a receipt", async () => {
    const { token } = issueToken(); // free: 3 steps
    const u = upstream((n, body) => (body.tools
      ? sse([{ id: `c${n}`, choices: [{ delta: { content: "Searching. " } }] },
        { id: `c${n}`, choices: [{ delta: { tool_calls: [{ index: 0, id: "x", function: { name: "web_search", arguments: `{"query":"${QUERY}"}` } }] }, finish_reason: "tool_calls" }] }])
      : answerStream(`c${n}`)));
    const out = await events(await handleAgent(req(token, ask), "/api/agent", { catalog, env, fetchImpl: u.fetchImpl }));
    expect(u.model).toHaveLength(3);
    expect(out.text).toBe("Searching. Searching. Answer [1]");
    expect(out.receipt).toBeUndefined();
  });

  it("a model that rejects tool calls gets the receipt of the step that answered", async () => {
    const { token } = issueToken();
    const u = upstream((n) => (n === 1 ? new Response("tools not supported", { status: 400 }) : answerStream("c2")));
    const out = await events(await handleAgent(req(token, ask), "/api/agent", { catalog, env, fetchImpl: u.fetchImpl }));
    expect(out.text).toBe("Answer [1]");
    expect(out.receipt).toMatchObject({ chat_id: "c2", req_sha256: createHash("sha256").update(JSON.stringify(u.model[1])).digest("hex") });
  });

  it("a provider that never answers times out after the first-byte limit", async () => {
    vi.useFakeTimers();
    const { token } = issueToken();
    const hang = (() => new Promise(() => {})) as unknown as typeof fetch;
    const logged: { event?: string }[] = [];
    const res = await handleAgent(req(token, ask), "/api/agent", { catalog, env, fetchImpl: hang, log: (m) => logged.push(m) });
    const out = events(res);
    await vi.advanceTimersByTimeAsync(FIRST_BYTE_TIMEOUT_MS.stream + 1);
    expect((await out).error).toBe("provider timeout");
    expect(logged.map((m) => m.event)).toContain("upstream_timeout");
  });

  it("a stream that goes silent times out after the idle limit", async () => {
    vi.useFakeTimers();
    const { token } = issueToken();
    const silent = (async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"id":"c","choices":[{"delta":{"content":"par"}}]}\n\n')); } }))) as unknown as typeof fetch;
    const res = await handleAgent(req(token, ask), "/api/agent", { catalog, env, fetchImpl: silent });
    const out = events(res);
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS + 1);
    const r = await out;
    expect(r.text).toBe("par");
    expect(r.error).toBe("provider timeout");
  });

  it("under the invite gate a signed-out visitor gets signup_required, and the session hides the toggle", async () => {
    vi.stubEnv("INVITE_ONLY", "1"); vi.stubEnv("BRAVE_SEARCH_API_KEY", "k"); vi.stubEnv("MOCK_PROVIDER", "");
    const { token } = issueToken();
    const res = await handleAgent(req(token, ask), "/api/agent", { catalog, env, fetchImpl: upstream(() => answerStream("c")).fetchImpl });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("signup_required");
    const s = await (await sessionGET(new Request("http://app/api/session"))).json();
    expect(s.features).toEqual({ webSearch: false });
    vi.stubEnv("INVITE_ONLY", "");
    expect((await (await sessionGET(new Request("http://app/api/session"))).json()).features).toEqual({ webSearch: true });
  });
});

describe("agent mode on an incognito model", () => {
  it("every step counts against the incognito quota, not the TEE one", async () => {
    const { id, token } = issueToken();
    const kimi = normaliseModel({ id: "venice", privacy: "anon-gateway" }, { id: "kimi-k3", model_spec: { privacy: "private" } });
    const u = upstream((n) => (n === 1 ? toolCallStream("c1") : answerStream("c2")));
    const res = await handleAgent(req(token, { ...ask, model: "venice:kimi-k3" }), "/api/agent",
      { catalog: async () => [kimi], env: { ...env, VENICE_API_KEY: "k", VENICE_BASE_URL: "http://upstream/v1" }, fetchImpl: u.fetchImpl, log: () => {} });
    expect(res.headers.get("x-usage-limit-daily")).toBe("50");
    expect(res.headers.get("x-usage-remaining-daily")).toBe("49");
    expect(parseSseChunk((await res.text()) + "\n").remaining).toBe("48");
    expect((await usage(id, "free")).usedToday).toBe(0);
  });
});
