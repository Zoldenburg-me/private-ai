import { describe, it, expect, vi, afterEach } from "vitest";
import { TOOLS, TOOL_HEARTBEAT_MS, runAgent } from "../lib/agent";
import { VIDEO_COST_MICROS, generateVideo, isMp4 } from "../lib/video-gen";
import { parseSseChunk } from "../lib/sse";
import { TIERS, type TierId } from "../lib/tiers";
import { creditsAvailable, reserveCredits } from "../lib/credits";
import { issueToken, setTier } from "../lib/session";
import { stores } from "../lib/store";

const enc = new TextEncoder();
const sse = (events: unknown[]) => new Response(new ReadableStream({ start(c) {
  for (const e of events) c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
  c.enqueue(enc.encode("data: [DONE]\n\n")); c.close();
} }));
const callStream = () => sse([{ id: "c1", choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "generate_video", arguments: `{"prompt":"a red cat"}` } }] }, finish_reason: "tool_calls" }] }]);
const answerStream = () => sse([{ id: "c2", choices: [{ delta: { content: "Here it is." } }] }, { id: "c2", choices: [{ delta: {}, finish_reason: "stop" }] }]);
const anon = { id: "venice", name: "Venice", privacy: "anon-gateway" as const, baseUrl: "http://upstream/v1", apiKey: "k", defaultModel: "" };
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.from([0, 0, 2, 0]), Buffer.from("isomiso2")]);
const BFL_ENV = { BFL_API_KEY: "bfl-key" };

/** BFL: submit, one Pending poll, Ready, then the clip; `over` replaces any step's response. */
function bfl(over: { poll?: string; sample?: string; status?: string; clip?: Buffer } = {}) {
  const calls: { url: string; key: string | null }[] = []; let polls = 0;
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, key: new Headers(init.headers).get("x-key") });
    if (url.endsWith("/flux-3-video")) return Response.json({ id: "j1", polling_url: over.poll ?? "https://api.eu.bfl.ai/v1/get_result?id=j1" });
    if (url.includes("get_result")) return Response.json(polls++ === 0 ? { status: "Pending" } : { status: over.status ?? "Ready", result: { sample: over.sample ?? "https://delivery.eu.bfl.ai/x.mp4?sig=1" } });
    return new Response(new Uint8Array(over.clip ?? MP4));
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

afterEach(() => { vi.useRealTimers(); });

/** A balance the video tool reserves from like the store does: all or nothing, refundable. */
function ledger(balance: number) {
  const l = { balance, refunds: 0, reserve: async (m: number) => {
    if (l.balance < m) return null;
    l.balance -= m; return async () => { l.balance += m; l.refunds++; };
  } };
  return l;
}

async function run(o: { tier?: TierId; provider?: typeof anon; credit?: number; video?: boolean; over?: Parameters<typeof bfl>[0] }) {
  const bodies: Record<string, unknown>[] = []; const b = bfl(o.over); const credits = ledger(o.credit ?? 10_000_000); const start = credits.balance;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    if (!url.startsWith("http://upstream")) return b.fetchImpl(url, init);
    bodies.push(JSON.parse(String(init.body)));
    return bodies.length === 1 ? callStream() : answerStream();
  }) as unknown as typeof fetch;
  const res = runAgent({ provider: o.provider ?? anon, body: { model: "m", messages: [{ role: "user", content: "film a cat" }] }, maxSteps: 3, tier: o.tier,
    credits, video: o.video ?? true,
    beforeStep: async () => null, env: BFL_ENV, log: () => {}, route: "/api/agent", fetchImpl });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const text = res.text(); await vi.runAllTimersAsync();
  const out = parseSseChunk((await text) + "\n");
  const names = ((bodies[0].tools ?? []) as { function?: { name: string } }[]).map((t) => t.function?.name);
  return { out, names, spent: start - credits.balance, refunds: credits.refunds, bflCalls: b.calls.length };
}

describe("generate_video tool", () => {
  it("is offered on paid Anon chats only", async () => {
    expect((await run({ tier: "pro" })).names).toContain("generate_video");
    expect((await run({ tier: "free" })).names).not.toContain("generate_video");
    expect((await run({ tier: "pro", provider: { ...anon, id: "phala", privacy: "tee-attested" as never } })).names).not.toContain("generate_video");
  });

  it("is offered only when the user switched video on for this message, so the model alone never reaches BFL", async () => {
    const r = await run({ tier: "pro", video: false });
    expect(r.names).not.toContain("generate_video");
    expect(r.bflCalls).toBe(0);
    expect(r.out.tools.find((t) => t.name === "generate_video")?.status).not.toBe("done");
  });

  it("sends the clip to the browser and charges its credit once it exists", async () => {
    const r = await run({ tier: "pro" });
    const done = r.out.tools.find((t) => t.status === "done")!;
    expect(done).toMatchObject({ name: "generate_video", query: "a red cat" });
    expect(done.video).toMatch(/^data:video\/mp4;base64,/);
    expect(r.spent).toBe(VIDEO_COST_MICROS);
    expect(r.refunds).toBe(0);
    expect(r.out.deltas.join("")).toBe("Here it is.");
  });

  it("refunds the reserved credit when the clip is refused", async () => {
    const r = await run({ tier: "pro", over: { status: "Content Moderated" } });
    expect(r.bflCalls).toBeGreaterThan(0);
    expect(r.spent).toBe(0);
    expect(r.refunds).toBe(1);
    expect(r.out.tools.map((t) => t.status)).toEqual(["running", "error"]);
  });

  it("keeps the stream alive while a clip renders", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const b = bfl(); let release!: () => void; const slow = new Promise<void>((r) => { release = r; });
    let n = 0;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      if (!url.startsWith("http://upstream")) { if (url.includes("get_result")) await slow; return b.fetchImpl(url, init); }
      return n++ === 0 ? callStream() : answerStream();
    }) as unknown as typeof fetch;
    const res = runAgent({ provider: anon, body: { model: "m", messages: [{ role: "user", content: "film" }] }, maxSteps: 3, tier: "pro",
      credits: ledger(10_000_000), video: true, beforeStep: async () => null, env: BFL_ENV, log: () => {}, route: "/api/agent", fetchImpl });
    const text = res.text();
    await vi.advanceTimersByTimeAsync(TOOL_HEARTBEAT_MS * 3 + 1);
    release(); await vi.advanceTimersByTimeAsync(10_000);
    const statuses = parseSseChunk((await text) + "\n").tools.map((t) => t.status);
    expect(statuses.filter((s) => s === "running").length).toBeGreaterThanOrEqual(4);
    expect(statuses.at(-1)).toBe("done");
  });

  it("makes no paid call without enough credit", async () => {
    const r = await run({ tier: "pro", credit: VIDEO_COST_MICROS - 1 });
    expect(r.bflCalls).toBe(0);
    expect(r.spent).toBe(0);
    expect(r.out.tools.map((t) => t.status)).toEqual(["running", "error"]);
  });

  it("two chats rendering at once cannot spend the same credit twice", async () => {
    const { id } = issueToken();
    await setTier(id, "pro");
    const { accounts } = await stores();
    const allowance = TIERS.pro.includedCreditsEur * 1e6;
    await accounts.spendCredits(id, allowance, new Date().toISOString().slice(0, 7), allowance); // this month's included credit used up
    await accounts.addCredits(id, VIDEO_COST_MICROS + VIDEO_COST_MICROS / 2, "cs_video_race"); // one and a half clips
    let bflSubmits = 0;
    const one = () => {
      const b = bfl(); let n = 0;
      const fetchImpl = (async (url: string, init: RequestInit) => {
        if (!url.startsWith("http://upstream")) { if (url.endsWith("/flux-3-video")) bflSubmits++; return b.fetchImpl(url, init); }
        return n++ === 0 ? callStream() : answerStream();
      }) as unknown as typeof fetch;
      return runAgent({ provider: anon, body: { model: "m", messages: [{ role: "user", content: "film" }] }, maxSteps: 3, tier: "pro", video: true,
        credits: { reserve: (m) => reserveCredits(id, "pro", m) }, beforeStep: async () => null, env: BFL_ENV, log: () => {}, route: "/api/agent", fetchImpl }).text();
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const both = Promise.all([one(), one()]); await vi.runAllTimersAsync();
    const done = (await both).map((t) => parseSseChunk(t + "\n").tools.filter((e) => e.status === "done").length);
    expect(done.sort()).toEqual([0, 1]);
    expect(bflSubmits).toBe(1);
    expect((await creditsAvailable(id, "pro")).purchased).toBe(VIDEO_COST_MICROS / 2);
  });
});

describe("generateVideo", () => {
  const gen = async (over: Parameters<typeof bfl>[0]) => {
    const b = bfl(over); vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const p = generateVideo("a cat", BFL_ENV, b.fetchImpl).then((v) => v, (e: { status: number }) => e.status);
    await vi.runAllTimersAsync();
    return { result: await p, calls: b.calls };
  };

  it("sends the key to BFL only, never to the delivery URL", async () => {
    const { result, calls } = await gen({});
    expect(result).toMatch(/^data:video\/mp4;base64,/);
    expect(calls[0]).toEqual({ url: "https://api.eu.bfl.ai/v1/flux-3-video", key: "bfl-key" });
    expect(calls.at(-1)).toEqual({ url: "https://delivery.eu.bfl.ai/x.mp4?sig=1", key: null });
  });

  it("refuses polling or sample URLs off BFL's hosts", async () => {
    expect((await gen({ poll: "https://evil.example/get_result" })).result).toBe(502);
    expect((await gen({ poll: "https://bfl.ai.evil.example/x" })).result).toBe(502);
    expect((await gen({ sample: "http://169.254.169.254/latest" })).result).toBe(502);
  });

  it("keeps the reservation when the user disconnects mid-render: BFL has no cancel and still bills the clip", async () => {
    const credits = ledger(10_000_000); const ac = new AbortController(); const b = bfl();
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const r = await b.fetchImpl(url, init); if (url.endsWith("/flux-3-video")) ac.abort(); return r;
    }) as unknown as typeof fetch;
    const ctx = { env: BFL_ENV, credits, fetchImpl, signal: ac.signal, charge: async () => null, remaining: () => undefined };
    const tool = TOOLS.get("generate_video")!;
    if (!("run" in tool)) throw new Error("generate_video runs on our server");
    await expect(tool.run(`{"prompt":"a cat"}`, ctx)).rejects.toBeTruthy();
    expect(10_000_000 - credits.balance).toBe(VIDEO_COST_MICROS);
    expect(credits.refunds).toBe(0);
  });

  it("refunds a clip the user left before BFL accepted it", async () => {
    const credits = ledger(10_000_000); const ac = new AbortController(); ac.abort();
    const fetchImpl = (async (_url: string, init?: RequestInit) => { init?.signal?.throwIfAborted(); throw new Error("unreachable"); }) as unknown as typeof fetch;
    const tool = TOOLS.get("generate_video")!;
    if (!("run" in tool)) throw new Error("generate_video runs on our server");
    await expect(tool.run(`{"prompt":"a cat"}`, { env: BFL_ENV, credits, fetchImpl, signal: ac.signal, charge: async () => null, remaining: () => undefined })).rejects.toBeTruthy();
    expect(credits.balance).toBe(10_000_000);
    expect(credits.refunds).toBe(1);
  });

  it("sends the API key only to a BFL API host, never to another bfl.ai host", async () => {
    const leak = await gen({ poll: "https://cdn.bfl.ai/v1/get_result?id=j1" });
    expect(leak.result).toBe(502);
    expect(leak.calls.filter((c) => c.key).map((c) => c.url)).toEqual(["https://api.eu.bfl.ai/v1/flux-3-video"]);
    const regional = await gen({ poll: "https://api.eu1.bfl.ai/v1/get_result?id=j1" });
    expect(String(regional.result)).toMatch(/^data:video\/mp4;base64,/);
    expect((await gen({ poll: "https://api.us1.bfl.ai/v1/get_result?id=j1" })).result).toBe(502); // outside the EU endpoint
  });

  it("treats moderation and non-MP4 bodies as refusals", async () => {
    expect((await gen({ status: "Content Moderated" })).result).toBe(422);
    expect((await gen({ status: "Task not found" })).result).toBe(422);
    expect((await gen({ clip: Buffer.from("<html>") })).result).toBe(422);
  });

  it("the client keeps only inline MP4 data URLs", () => {
    const ev = (video: string) => `event: agent_tool\ndata: ${JSON.stringify({ id: "1", name: "generate_video", status: "done", video })}\n\n`;
    expect(parseSseChunk(ev("data:video/mp4;base64,AAAA")).tools[0].video).toBe("data:video/mp4;base64,AAAA");
    expect(parseSseChunk(ev("https://delivery.eu.bfl.ai/x.mp4")).tools[0].video).toBeUndefined();
    expect(isMp4(MP4)).toBe(true);
  });
});
