import { describe, it, expect } from "vitest";
import { streamChat, toChatMessages } from "@/lib/client/chat-stream";
import { visibleModels, defaultModelRef } from "@/lib/client/providers";
import type { ModelEntry } from "@/lib/catalog";

const sse = (parts: string[]) => new Response(new ReadableStream({ start(c) { for (const p of parts) c.enqueue(new TextEncoder().encode(p)); c.close(); } }),
  { headers: { "content-type": "text/event-stream", "x-usage-remaining-daily": "7" } });

describe("client chat stream", () => {
  it("maps assistant-ui messages to OpenAI messages (text parts only)", () => {
    expect(toChatMessages([{ role: "user", content: [{ type: "text", text: "hi" }, { type: "image" }] }, { role: "tool", content: [] }]))
      .toEqual([{ role: "user", content: "hi" }]);
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
