import { describe, it, expect } from "vitest";
import { ProviderFailure, newestHasImage, storedView, streamChat, toChatMessages, toStoredMessages } from "@/lib/client/chat-stream";
import { visibleModels, defaultModelRef } from "@/lib/client/providers";
import type { ModelEntry } from "@/lib/catalog";

const sse = (parts: string[]) => new Response(new ReadableStream({ start(c) { for (const p of parts) c.enqueue(new TextEncoder().encode(p)); c.close(); } }),
  { headers: { "content-type": "text/event-stream", "x-usage-remaining-daily": "7" } });

describe("client chat stream", () => {
  it("an error turn is neither sent back to the model nor kept in history", () => {
    const ui = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "⚠️ daily limit reached" }], status: { type: "incomplete", reason: "error" } },
      { role: "user", content: [{ type: "text", text: "again" }] },
      { role: "assistant", content: [{ type: "text", text: "partial" }], status: { type: "incomplete", reason: "cancelled" } },
    ];
    // The unanswered message joins the next one, so roles still alternate (some chat templates require it).
    expect(toChatMessages(ui)).toEqual([{ role: "user", content: "hi\n\nagain" }, { role: "assistant", content: "partial" }]);
    const img = [ui[0], ui[1], { role: "user", content: [{ type: "text", text: "this" }], attachments: [{ name: "a.png", content: [{ type: "image", image: "data:image/png;base64,AA" }] }] }];
    expect(toChatMessages(img)).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }, { type: "text", text: "this" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA" } }] }]);
    expect(toStoredMessages(ui).map((m) => m.content)).toEqual(["hi", "again", "partial"]);
  });
  it("maps assistant-ui messages to OpenAI messages (text parts only)", () => {
    expect(toChatMessages([{ role: "user", content: [{ type: "text", text: "hi" }, { type: "image" }] }, { role: "tool", content: [] }]))
      .toEqual([{ role: "user", content: "hi" }]);
  });

  it("sends attached documents as text and images as image_url parts; history keeps only image names", () => {
    const ui = [{ role: "user", content: [{ type: "text", text: "compare" }], attachments: [
      { name: "a.md", content: [{ type: "text", text: "<document name=\"a.md\">\nA\n</document>" }] },
      { name: "cat.png", content: [{ type: "image", image: "data:image/jpeg;base64,AAAA" }] },
    ] }];
    expect(toChatMessages(ui)).toEqual([{ role: "user", content: [
      { type: "text", text: "<document name=\"a.md\">\nA\n</document>\n\ncompare" },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA" } },
    ] }]);
    expect(toStoredMessages(ui)).toEqual([{ role: "user", content: "[image: cat.png]\n\n<document name=\"a.md\">\nA\n</document>\n\ncompare" }]);
    expect(toChatMessages([{ role: "user", content: [], attachments: [{ name: "a.md", content: [{ type: "text", text: "doc" }] }] }])).toEqual([{ role: "user", content: "doc" }]);
  });

  it("sends images only on the newest user message, only to a model that reads them, and never an empty text part", () => {
    const img = (name: string) => ({ name, content: [{ type: "image", image: `data:image/jpeg;base64,${name}` }] });
    const ui = [
      { role: "user", content: [{ type: "text", text: "old" }], attachments: [img("a")] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: [], attachments: [img("b")] },
    ];
    expect(toChatMessages(ui)).toEqual([
      { role: "user", content: "[image: a]\n\nold" },
      { role: "assistant", content: "ok" },
      { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/jpeg;base64,b" } }] },
    ]);
    expect(toChatMessages(ui, { images: false })[2]).toEqual({ role: "user", content: "[image: b]" });
    expect(newestHasImage(ui)).toBe(true);
    expect(newestHasImage([...ui, { role: "user", content: [{ type: "text", text: "next" }] }])).toBe(false);
  });

  it("splits a stored user message back into file names and the typed text", () => {
    const stored = toStoredMessages([{ role: "user", content: [{ type: "text", text: "compare" }], attachments: [
      { name: "a \"x\".md", content: [{ type: "text", text: "<document name=\"a &quot;x&quot;.md\">\nA\n</document>" }] },
      { name: "cat.png", content: [{ type: "image", image: "data:image/jpeg;base64,AAAA" }] },
    ] }])[0].content;
    expect(storedView(stored)).toEqual({ files: [{ name: "cat.png", type: "image" }, { name: "a \"x\".md", type: "document" }], text: "compare" });
    expect(storedView("just text")).toEqual({ files: [], text: "just text" });
    expect(storedView("<document name=\"a\">\nx<\\/document>y\n</document>\n\n<document name=\"b\">\nB\n</document>\n\nhi").files.map((f) => f.name)).toEqual(["a", "b"]);
    // Display only: typed text in the stored format shows as a chip after reload; what is stored and sent is unchanged.
    expect(storedView("[image: x]\n\nhi")).toEqual({ files: [{ name: "x", type: "image" }], text: "hi" });
  });

  it("keeps earlier replies' signature status for history, but never sends it to the server", () => {
    const ui = [
      { role: "user", content: [{ type: "text", text: "q1" }] },
      { role: "assistant", content: [{ type: "text", text: "a1" }], metadata: { custom: { signed: "key-match" } } },
      { role: "assistant", content: [{ type: "text", text: "a0" }], metadata: { custom: { signed: "ok" } } },
      { role: "assistant", content: [{ type: "text", text: "a2" }], metadata: { custom: { incognito: "anonymized" } } },
      { role: "assistant", content: [{ type: "text", text: "a3" }], metadata: { custom: { incognito: "tee" } } },
      { role: "user", content: [{ type: "text", text: "q2" }], metadata: { custom: { signed: "enclave" } } },
      { role: "tool", content: [] },
    ];
    expect(toStoredMessages(ui)).toEqual([
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1", signed: "key-match" },
      { role: "assistant", content: "a0", signed: "key-match" },
      { role: "assistant", content: "a2", incognito: "anonymized" },
      { role: "assistant", content: "a3" },
      { role: "user", content: "q2" },
    ]);
    expect(toChatMessages(ui).some((m) => "signed" in m || "incognito" in m)).toBe(false);
  });

  it("streams deltas, usage header and the relay receipt", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_u: string, init: RequestInit) => { body = JSON.parse(String(init.body)); return sse([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n',
      'event: pai_receipt\ndata: {"chat_id":"c1","provider":"near","model":"m","req_sha256":"a","resp_sha256":"b"}\n\n',
    ]); }) as unknown as typeof fetch;
    const out = [];
    for await (const u of streamChat({ model: "near:m", messages: [{ role: "user", content: "x" }], persona: { name: "T", system_prompt: "be nice" }, fetchImpl })) out.push(u);
    const last = out[out.length - 1];
    expect(last.text).toBe("Hello"); expect(last.receipt?.chat_id).toBe("c1"); expect(last.remaining).toBe("7");
    expect(body.pai_options).toEqual({ persona: { name: "T", system_prompt: "be nice" } });
  });

  it("agent mode posts to /api/agent with web_search and keeps the newest state of each tool step", async () => {
    let url = ""; let body: Record<string, unknown> = {};
    const tool = (status: string, extra = {}) => `event: agent_tool\ndata: ${JSON.stringify({ id: "t1", name: "web_search", status, query: "q", ...extra })}\n\n`;
    const fetchImpl = (async (u: string, init: RequestInit) => { url = u; body = JSON.parse(String(init.body)); return sse([
      tool("running"), tool("done", { results: [{ title: "A", url: "https://a.example" }] }), 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\nevent: pai_usage\ndata: {"remaining_daily":"5"}\n\ndata: [DONE]\n\n',
    ]); }) as unknown as typeof fetch;
    const out = [];
    for await (const u of streamChat({ model: "near:m", messages: [{ role: "user", content: "x" }], agent: true, fetchImpl })) out.push(u);
    expect(url).toBe("/api/agent");
    expect(body.pai_options).toEqual({ web_search: true });
    expect(out.at(-1)!.tools).toEqual([{ id: "t1", name: "web_search", status: "done", query: "q", results: [{ title: "A", url: "https://a.example" }] }]);
    expect(out.at(-1)!.text).toBe("ok");
    expect(out.at(-1)!.remaining).toBe("5"); // the header said 7: later agent steps used two more
  });

  it("agent mode: agent_error and a stream cut before [DONE] both surface as errors", async () => {
    const run = (parts: string[]) => (async () => {
      for await (const _ of streamChat({ model: "near:m", messages: [], agent: true, fetchImpl: (async () => sse(parts)) as unknown as typeof fetch })) void _;
    })();
    await expect(run(['data: {"choices":[{"delta":{"content":"a"}}]}\n\n', 'event: agent_error\ndata: {"message":"daily limit reached"}\n\n'])).rejects.toThrow("daily limit reached");
    await expect(run(['data: {"choices":[{"delta":{"content":"a"}}]}\n\n'])).rejects.toThrow(/connection lost/);
  });

  it("marks provider failures apart from our own limits, so Auto can move to another route", async () => {
    const first = async (res: () => Response, agent = false) => {
      try { for await (const _ of streamChat({ model: "near:m", messages: [], agent, fetchImpl: (async () => res()) as unknown as typeof fetch })) void _; } catch (e) { return e; }
    };
    expect(await first(() => Response.json({ error: { message: "provider error 401" } }, { status: 502 }))).toBeInstanceOf(ProviderFailure);
    expect(await first(() => Response.json({ error: { message: "provider timeout" } }, { status: 504 }))).toBeInstanceOf(ProviderFailure);
    expect(await first(() => sse(['event: agent_error\ndata: {"message":"provider stream ended early"}\n\n']), true)).toBeInstanceOf(ProviderFailure);
    expect(await first(() => sse(['event: agent_error\ndata: {"message":"model did not answer"}\n\n']), true)).toBeInstanceOf(ProviderFailure);
    expect(await first(() => Response.json({ error: { message: "provider not configured" } }, { status: 503 }))).toBeInstanceOf(ProviderFailure);

    for (const e of [await first(() => Response.json({ error: { message: "daily limit reached" } }, { status: 429 })),
      await first(() => sse(['event: agent_error\ndata: {"message":"rate limit, slow down"}\n\n']), true),
      await first(() => new Response("<html>Bad gateway</html>", { status: 502 })), // the tunnel, not the provider
      await first(() => Response.json({ error: { message: "service temporarily unavailable" } }, { status: 503 })), // our store
      await first(() => sse(['event: agent_error\ndata: {"message":"provider x"}\n\n'])), // a relayed provider faking our agent event
      // A stream that breaks after the headers: maybe the relay, maybe the user's own network, so no route is benched.
      await first(() => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n')); c.error(new TypeError("network error")); } })))]) {
      expect(e).toBeInstanceOf(Error); expect(e).not.toBeInstanceOf(ProviderFailure);
    }
  });

  it("surfaces server errors (e.g. tier limit)", async () => {
    const fetchImpl = (async () => Response.json({ error: { message: "daily limit reached" } }, { status: 429 })) as unknown as typeof fetch;
    await expect((async () => { for await (const _ of streamChat({ model: "near:m", messages: [], fetchImpl })) void _; })()).rejects.toThrow("daily limit reached");
  });
});

describe("client provider scope", () => {
  const m = (provider: string, id: string, selectable = true): ModelEntry => ({ id, provider, name: id, privacy: "tee", tee: true, e2ee: false, selectable });
  it("shows only NEAR (and the dev mock), never other providers", () => {
    const v = visibleModels([m("tinfoil", "a"), m("near", "b"), m("phala", "c"), m("mock", "d")]);
    expect(v.map((x) => x.provider)).toEqual(["near", "mock"]);
    expect(defaultModelRef([m("near", "x", false), m("near", "y")])).toBe("near:y");
  });
});

describe("usage from the chat response", () => {
  const limited = () => new Response(JSON.stringify({ error: { message: "daily limit reached" } }), { status: 429,
    headers: { "x-usage-remaining-daily": "0", "x-usage-limit-daily": "50", "x-usage-quota": "incognito" } });

  it("reports which quota a reply counted against", async () => {
    const ok = (async () => { const r = sse(["data: [DONE]\n\n"]); r.headers.set("x-usage-quota", "incognito"); return r; }) as unknown as typeof fetch;
    const updates: unknown[] = [];
    for await (const u of streamChat({ model: "liquid:m", messages: [], fetchImpl: ok })) updates.push(u);
    expect(updates.at(-1)).toMatchObject({ remaining: "7", quota: "incognito" });
  });

  it("still updates the meter when the request is refused for its quota", async () => {
    const updates: unknown[] = [];
    await expect((async () => { for await (const u of streamChat({ model: "liquid:m", messages: [], fetchImpl: (async () => limited()) as unknown as typeof fetch })) updates.push(u); })())
      .rejects.toThrow("daily limit reached");
    expect(updates).toEqual([{ text: "", remaining: "0", limit: "50", quota: "incognito", tools: [] }]);
  });
});
