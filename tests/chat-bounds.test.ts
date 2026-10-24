import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleChat, MAX_BODY_BYTES, BODY_READ_TIMEOUT_MS } from "../lib/handler";
import { issueToken, setTier } from "../lib/session";
import { _reset } from "../lib/ratelimit";
import { applyExtensions, MAX_IMAGE_URL, MAX_MESSAGES, MAX_STOP } from "../lib/extensions";
import { normaliseModel } from "../lib/catalog";
import { getCatalog, _clearCatalog, STALE_MAX_MS } from "../lib/catalog-cache";
import { relay, FIRST_BYTE_TIMEOUT_MS, IDLE_TIMEOUT_MS, TOTAL_TIMEOUT_MS } from "../lib/relay";
import { TIERS, DEFAULT_OUTPUT_TOKENS, estimateTokens, estimateBodyTokens, IMAGE_TOKENS } from "../lib/tiers";

const env = { MOCK_PROVIDER: "1", MOCK_BASE_URL: "http://upstream/v1" };
const catalog = async () => [
  normaliseModel({ id: "mock", privacy: "tee-attested" }, { id: "m" }),
  normaliseModel({ id: "mock", privacy: "tee-attested" }, { id: "vl", input_modalities: ["text", "image"], output_modalities: ["text"] }),
];
let sent: Record<string, unknown>[] = [];
const upstream = vi.fn(async (_url: string, init: RequestInit) => {
  sent.push(JSON.parse(String(init.body)));
  return Response.json({ id: "chatcmpl-y", choices: [{ message: { content: "ok" } }] });
}) as unknown as typeof fetch;
const deps = { catalog, env, fetchImpl: upstream, log: () => {} };
const req = (token: string, body: unknown) =>
  new Request("http://app/api/chat", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
const streamReq = (token: string, body: ReadableStream<Uint8Array>) =>
  new Request("http://app/api/chat", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body, duplex: "half" } as RequestInit);
const user = (content: unknown = "hi") => ({ role: "user", content });
const enc = (s: string) => new TextEncoder().encode(s);
const errorOf = async (r: Response) => ((await r.json()) as { error: { message: string } }).error.message;

beforeEach(() => { _reset(); sent = []; });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("H1: forwarded body is bounded", () => {
  it("drops n; rejects tools and tool_choice with 400", async () => {
    const { token } = issueToken();
    expect((await handleChat(req(token, { model: "mock:m", messages: [user()], n: 128 }), "/t", deps)).status).toBe(200);
    expect(sent[0]).not.toHaveProperty("n");
    for (const extra of [{ tools: [{ type: "function" }] }, { tool_choice: "auto" }]) {
      const r = await handleChat(req(token, { model: "mock:m", messages: [user()], ...extra }), "/t", deps);
      expect(r.status).toBe(400);
      expect(await errorOf(r)).toMatch(/tools are not supported/);
    }
    expect(sent).toHaveLength(1);
  });

  it("clamps max_tokens to the tier cap, defaults it separately, and ignores invalid values", async () => {
    const { id, token } = issueToken();
    await setTier(id, "pro");
    const cap = TIERS.pro.maxOutputTokens;
    const cases: [Record<string, unknown>, number][] = [
      [{ max_tokens: 1_000_000 }, cap],
      [{ max_completion_tokens: 1_000_000 }, cap],
      [{}, DEFAULT_OUTPUT_TOKENS],
      [{ max_tokens: 100 }, 100],
      [{ max_tokens: 100.7 }, 100],
      [{ max_tokens: 0 }, DEFAULT_OUTPUT_TOKENS],
      [{ max_tokens: -5 }, DEFAULT_OUTPUT_TOKENS],
      [{ max_tokens: "100" }, DEFAULT_OUTPUT_TOKENS],
      [{ max_tokens: null }, DEFAULT_OUTPUT_TOKENS],
      [{ max_tokens: 0.5 }, DEFAULT_OUTPUT_TOKENS],
      [{ max_completion_tokens: 0, max_tokens: 50 }, 50],
      [{ max_completion_tokens: 70, max_tokens: 50 }, 70],
    ];
    for (const [extra] of cases) await handleChat(req(token, { model: "mock:m", messages: [user()], ...extra }), "/t", deps);
    expect(sent.map((b) => b.max_tokens ?? b.max_completion_tokens)).toEqual(cases.map(([, want]) => want));
    // Exactly one limit field goes upstream: the one the client used (max_tokens when it sent neither).
    expect(sent.map((b) => Object.keys(b).filter((k) => k.startsWith("max_")))).toEqual(
      cases.map(([extra]) => [extra.max_completion_tokens != null ? "max_completion_tokens" : "max_tokens"]));
    expect(DEFAULT_OUTPUT_TOKENS).toBeLessThan(cap);
    expect(TIERS.free.maxOutputTokens).toBeLessThanOrEqual(cap);
  });

  it("counts the whole forwarded body, not just message content, against the context limit", async () => {
    const { token } = issueToken();
    const big = "x".repeat(40_000);
    const res = await handleChat(req(token, { model: "mock:m", messages: [user()], response_format: { type: "json_schema", json_schema: { description: big } } }), "/t", deps);
    expect(res.status).toBe(413);
    expect(sent).toHaveLength(0);
  });

  it("estimates tokens conservatively for non-Latin text", () => {
    expect(estimateTokens("日本語のテキスト")).toBeGreaterThanOrEqual(8); // 8 chars, 24 UTF-8 bytes
    expect(estimateTokens("abcdef")).toBe(2);
  });

  it("rejects malformed messages and disallowed parts with 400 instead of a 500", async () => {
    const { token } = issueToken();
    const bad = [
      [null], [user(), null], [{ role: "evil", content: "x" }], [{ role: "user" }], [user(42)], [user(null)],
      [user([null])], [user([{ text: "no type" }])], [user([{ type: "text", text: 1 }])],
      [user([{ type: "image_url", image_url: { url: "https://example.com/a.png" } }])],
      [user([{ type: "image_url", image_url: { url: "data:text/html;base64,AAAA" } }])],
      [user([{ type: "image_url", image_url: { url: "data:image/svg+xml;base64,AAAA" } }])],
      [user([{ type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(MAX_IMAGE_URL)}` } }])],
      [{ role: "system", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] }],
      [{ role: "assistant", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] }], "nope",
    ];
    for (const messages of bad) expect((await handleChat(req(token, { model: "mock:m", messages }), "/t", deps)).status).toBe(400);
    expect((await handleChat(req(token, "null"), "/t", deps)).status).toBe(400);
    expect((await handleChat(req(token, "[]"), "/t", deps)).status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it("forwards inline images on user messages and counts each at a flat rate, not by its bytes", async () => {
    const { token } = issueToken();
    const url = `data:image/jpeg;base64,${"A".repeat(1_000_000)}`; // ~333k tokens if counted by bytes
    const messages = [user([{ type: "text", text: "what is this?" }, { type: "image_url", image_url: { url, detail: "high" } }])];
    expect((await handleChat(req(token, { model: "mock:vl", messages }), "/t", deps)).status).toBe(200);
    expect((sent[0].messages as { content: unknown }[])[0].content).toEqual([{ type: "text", text: "what is this?" }, { type: "image_url", image_url: { url } }]);
    expect(estimateBodyTokens({ messages })).toBe(estimateTokens(JSON.stringify({ messages: [user([{ type: "text", text: "what is this?" }, { type: "image_url" }])] })) + IMAGE_TOKENS);
  });

  it("rejects images for a model whose input modalities do not include image", async () => {
    const { token } = issueToken();
    const messages = [user([{ type: "text", text: "what is this?" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }])];
    const r = await handleChat(req(token, { model: "mock:m", messages }), "/t", deps);
    expect(r.status).toBe(400);
    expect(await errorOf(r)).toMatch(/does not read images/);
    expect(sent).toHaveLength(0);
  });

  const call = { id: "c1", type: "function", function: { name: "lookup", arguments: "{}" } };
  it("accepts SDK shapes and forwards only known fields, keeping tool-call links", () => {
    const r = applyExtensions({ model: "m", messages: [
      { role: "developer", content: "be brief" },
      { role: "user", content: [{ type: "text", text: "hi", cache_control: { x: 1 } }], name: "me" },
      { role: "assistant", content: null, tool_calls: [{ ...call, extra: 1 }] },
      { role: "tool", content: "r", tool_call_id: "c1", junk: true },
    ] });
    expect(r.error).toBeUndefined();
    expect(r.body.messages).toEqual([
      { role: "developer", content: "be brief" },
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: "", tool_calls: [call] },
      { role: "tool", content: "r", tool_call_id: "c1" },
    ]);
  });

  it("rejects tool results that do not link to an earlier call, and malformed tool calls", () => {
    const asst = { role: "assistant", content: null, tool_calls: [call] };
    for (const messages of [
      [{ role: "tool", content: "r" }],
      [{ role: "tool", content: "r", tool_call_id: "c1" }],
      [asst, { role: "tool", content: "r", tool_call_id: "c2" }],
      [{ role: "assistant", content: null, tool_calls: [{ id: "c1" }] }],
      [{ role: "assistant", content: null, tool_calls: [] }],
    ]) expect(applyExtensions({ messages }).error).toMatch(/tool/);
  });

  it("forwards a tool-call continuation end to end", async () => {
    const { token } = issueToken();
    const messages = [user(), { role: "assistant", content: null, tool_calls: [call] }, { role: "tool", content: "42", tool_call_id: "c1" }];
    expect((await handleChat(req(token, { model: "mock:m", messages }), "/t", deps)).status).toBe(200);
    expect(sent[0].messages).toEqual([{ role: "user", content: "hi" }, { role: "assistant", content: "", tool_calls: [call] }, { role: "tool", content: "42", tool_call_id: "c1" }]);
  });

  it("validates stop as at most 4 short strings", () => {
    const m = [user()];
    expect(applyExtensions({ messages: m, stop: "END" }).error).toBeUndefined();
    expect(applyExtensions({ messages: m, stop: Array(MAX_STOP).fill("x") }).error).toBeUndefined();
    expect(applyExtensions({ messages: m, stop: Array(MAX_STOP + 1).fill("x") }).error).toMatch(/stop/);
    expect(applyExtensions({ messages: m, stop: "x".repeat(101) }).error).toMatch(/stop/);
    expect(applyExtensions({ messages: m, stop: [1] }).error).toMatch(/stop/);
  });

  it("caps the message count", () => {
    expect(applyExtensions({ messages: Array.from({ length: MAX_MESSAGES + 1 }, () => user()) }).error).toMatch(/too many/);
    expect(applyExtensions({ messages: Array.from({ length: MAX_MESSAGES }, () => user()) }).error).toBeUndefined();
  });

  it("reads a body of exactly MAX_BODY_BYTES and rejects one byte more with 413, also without Content-Length", async () => {
    const { token } = issueToken();
    const head = '{"model":"mock:m","messages":[{"role":"user","content":"', tail = '"}]}';
    const exact = head + "x".repeat(MAX_BODY_BYTES - head.length - tail.length) + tail;
    expect(exact.length).toBe(MAX_BODY_BYTES);
    const atCap = await handleChat(req(token, exact), "/t", deps);
    expect(await errorOf(atCap)).toBe("context too long for tier"); // body was read; the tier gate rejects it
    const over = exact.replace(head, head + "x");
    const r = await handleChat(req(token, over), "/t", deps);
    expect(r.status).toBe(413);
    expect(await errorOf(r)).toBe("request body too large");
    const chunked = streamReq(token, new ReadableStream({ start(c) { c.enqueue(enc(over)); c.close(); } }));
    expect(chunked.headers.get("content-length")).toBeNull();
    expect((await handleChat(chunked, "/t", deps)).status).toBe(413);
    expect(sent).toHaveLength(0);
  });

  it("answers 400 when the client aborts the upload and 408 when it stalls", async () => {
    const { token } = issueToken();
    const aborted = streamReq(token, new ReadableStream({ pull(c) { c.error(new Error("client gone")); } }));
    expect((await handleChat(aborted, "/t", deps)).status).toBe(400);
    vi.useFakeTimers();
    const stalled = handleChat(streamReq(token, new ReadableStream({ start(c) { c.enqueue(enc("{")); } })), "/t", deps);
    await vi.advanceTimersByTimeAsync(BODY_READ_TIMEOUT_MS);
    expect((await stalled).status).toBe(408);
  });
});

describe("M2: upstream timeouts", () => {
  const provider = { id: "mock", name: "m", privacy: "tee-attested" as const, baseUrl: "http://u", apiKey: "k", defaultModel: "" };
  const hang = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_, rej) => {
    init.signal?.addEventListener("abort", () => rej(init.signal!.reason));
  })) as unknown as typeof fetch;
  /** Upstream SSE that sends a chunk every `every` ms, `count` times; it ignores the abort signal like a stuck socket. */
  const ticking = (every: number, count = Infinity) => (async () => {
    let i = 0;
    return new Response(new ReadableStream({
      async pull(c) {
        if (i >= count) { c.close(); return; }
        await new Promise((r) => setTimeout(r, every));
        c.enqueue(enc(`data: {"id":"chat-${i++}"}\n\n`));
      },
    }));
  }) as unknown as typeof fetch;
  const stall = (async () => {
    let sentOne = false;
    return new Response(new ReadableStream({ pull(c) { if (!sentOne) { sentOne = true; c.enqueue(enc("data: {}\n\n")); return; } return new Promise(() => {}); } }));
  }) as unknown as typeof fetch;
  const run = (fetchImpl: typeof fetch, stream = true) => relay({ provider, body: { model: "m", stream }, log: () => {}, route: "/t", fetchImpl });
  const settle = (r: Response) => r.text().then((text) => ({ text, error: null as unknown }), (error: unknown) => ({ text: "", error }));

  it("502 when the provider is unreachable, 504 when it sends no headers in time", async () => {
    expect((await run((async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch)).status).toBe(502);
    vi.useFakeTimers();
    const p = run(hang);
    await vi.advanceTimersByTimeAsync(FIRST_BYTE_TIMEOUT_MS.stream);
    expect((await p).status).toBe(504);
  });

  it("504 even when the fetch ignores its abort signal and never settles", async () => {
    vi.useFakeTimers();
    const p = run((() => new Promise(() => {})) as unknown as typeof fetch);
    await vi.advanceTimersByTimeAsync(FIRST_BYTE_TIMEOUT_MS.stream);
    expect((await p).status).toBe(504);
  });

  it("gives non-streaming requests the longer first-byte window", async () => {
    vi.useFakeTimers();
    let done = false;
    const p = run(hang, false).then((r) => { done = true; return r; });
    await vi.advanceTimersByTimeAsync(FIRST_BYTE_TIMEOUT_MS.stream + 1_000);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(FIRST_BYTE_TIMEOUT_MS.json);
    expect((await p).status).toBe(504);
  });

  it("keeps a live stream open past the first-byte window", async () => {
    vi.useFakeTimers();
    const res = await run(ticking(20_000, 4));
    const out = settle(res);
    await vi.advanceTimersByTimeAsync(100_000);
    const { text, error } = await out;
    expect(error).toBeNull();
    expect(text).toContain("chat-3");
    expect(text).toContain("event: pai_receipt");
  });

  it("aborts a stream that goes idle", async () => {
    vi.useFakeTimers();
    const out = settle(await run(stall));
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS);
    expect((await out).error).toBeInstanceOf(Error);
  });

  it("aborts a slow-drip stream at the overall deadline", async () => {
    vi.useFakeTimers();
    const out = settle(await run(ticking(IDLE_TIMEOUT_MS - 1_000)));
    await vi.advanceTimersByTimeAsync(TOTAL_TIMEOUT_MS);
    const { text, error } = await out;
    expect(error).toBeInstanceOf(Error);
    expect(text).not.toContain("pai_receipt");
  });

  it("catalog: timeout signal, one in-flight refresh, stale entries for at most STALE_MAX_MS", async () => {
    vi.stubEnv("MOCK_PROVIDER", "1");
    vi.stubEnv("MOCK_MODEL", "fallback");
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    _clearCatalog();
    let fail = false;
    const f = vi.fn(async (_u: string, init: RequestInit) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      if (fail) throw new Error("down");
      return Response.json({ data: [{ id: "a" }, { id: "b" }] });
    });
    vi.stubGlobal("fetch", f);
    const ids = async () => (await getCatalog()).map((m) => m.id);
    const [x, y] = await Promise.all([getCatalog(), getCatalog()]);
    expect(f).toHaveBeenCalledOnce();
    expect(x).toBe(y);
    fail = true;
    vi.setSystemTime(t0 + 2 * 60_000);
    expect(await ids()).toEqual(["a", "b"]); // failed refresh, still within the stale window
    vi.setSystemTime(t0 + STALE_MAX_MS - 1_000);
    expect(await ids()).toEqual(["a", "b"]); // refresh fails just before the stale deadline
    vi.setSystemTime(t0 + STALE_MAX_MS + 30_000);
    expect(await ids()).toEqual(["fallback"]); // a cache hit cannot outlive the deadline: delisted models are gone
    fail = false;
    vi.setSystemTime(t0 + STALE_MAX_MS + 122_000);
    expect(await ids()).toEqual(["a", "b"]);
  });
});
