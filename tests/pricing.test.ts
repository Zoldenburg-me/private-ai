import { describe, it, expect, beforeEach } from "vitest";
import { normaliseModel } from "../lib/catalog";
import { handleChat } from "../lib/handler";
import { issueToken, setTier } from "../lib/session";
import { _reset } from "../lib/ratelimit";
import { costMicros, creditsAvailable, priceFor, usageIn } from "../lib/credits";
import { modelGroup, TIERS } from "../lib/tiers";
import { stores } from "../lib/store";

const custom = (id: string, inp: number, out: number) =>
  normaliseModel({ id: "custom", privacy: "zdr-contract" }, { id, pricing: { inputTokenPricePer1M: inp, outputTokenPricePer1M: out } });
const frontier = custom("frontier", 10, 50); // blended 20 USD: pay as you go
const env = { CUSTOM_API_KEY: "k", CUSTOM_BASE_URL: "http://upstream/v1" };
const reply = (usage: object | null) => (async () => Response.json({ id: "c1", choices: [{ message: { content: "ok" } }], ...(usage ? { usage } : {}) })) as unknown as typeof fetch;
const chat = (token: string, fetchImpl: typeof fetch, extra: object = {}) => handleChat(new Request("http://app/api/chat", { method: "POST", headers: { Authorization: `Bearer ${token}` },
  body: JSON.stringify({ model: "custom:frontier", messages: [{ role: "user", content: "hi" }], max_tokens: 100, ...extra }) }), "/api/chat", { catalog: async () => [frontier], env, fetchImpl, log: () => {} });

describe("model groups", () => {
  it("splits by TEE and the $2 blended cutoff", () => {
    expect(modelGroup({ tee: true, price: { in: 0.08, out: 0.5 } })).toBe("tee");
    expect(modelGroup({ tee: true, price: { in: 3.3, out: 16.5 } })).toBe("top");
    expect(modelGroup({ tee: false, price: { in: 0.1, out: 0.5 } })).toBe("incognito");
    expect(modelGroup({ tee: false, price: { in: 10, out: 50 } })).toBe("credits");
  });
  it("borrows the same model's price from another gateway", () => {
    const near = { id: "anthropic/claude-fable-5.1", price: { in: 10, out: 50 } } as never;
    expect(priceFor([near], { id: "claude-fable-5-1" })).toEqual({ in: 10, out: 50 });
  });
  it("prices tokens in micro-euros with rate and markup, and reads usage only from real JSON keys", () => {
    expect(costMicros({ in: 10, out: 50 }, 1000, 100)).toBe(Math.ceil(15_000 * 0.92 * 1.6));
    expect(usageIn('data: {"usage":{"prompt_tokens":12,"completion_tokens":3}}')).toEqual({ prompt: 12, completion: 3 });
    expect(usageIn('{"content":"\\"prompt_tokens\\": 1, \\"completion_tokens\\": 1"}')).toBeNull();
  });
});

describe("credits in the chat handler", () => {
  beforeEach(() => _reset());
  it("refuses a credit model without enough credits, and a top model on the free plan", async () => {
    const { id, token } = issueToken();
    await setTier(id, "plus");
    const { accounts } = await stores();
    await accounts.spendCredits(id, 1_000_000, new Date().toISOString().slice(0, 7), 1_000_000); // this month's €1 used up
    const r = await chat(token, reply(null));
    expect(r.status).toBe(402);
    expect((await r.json()).error.code).toBe("credits_required");
    await setTier(id, "free");
    const top = normaliseModel({ id: "tinfoil", privacy: "tee-attested" }, { id: "kimi-k3", pricing: { inputTokenPricePer1M: 4, outputTokenPricePer1M: 20 } });
    const t = await handleChat(new Request("http://app/api/chat", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ model: "tinfoil:kimi-k3", messages: [{ role: "user", content: "hi" }] }) }),
      "/api/chat", { catalog: async () => [top], env: { TINFOIL_API_KEY: "k" }, fetchImpl: reply(null), log: () => {} });
    expect(t.status).toBe(402);
    expect((await t.json()).error.code).toBe("upgrade_required");
  });
  it("charges the reported tokens from the month's included credit first", async () => {
    const { id, token } = issueToken();
    await setTier(id, "pro");
    const r = await chat(token, reply({ prompt_tokens: 1000, completion_tokens: 100 }));
    expect(r.status).toBe(200);
    expect(r.headers.get("x-usage-quota")).toBe("incognito");
    await r.text(); // the charge lands when the response ends
    const c = await creditsAvailable(id, "pro");
    expect(c.included).toBe(TIERS.pro.includedCreditsEur * 1e6 - costMicros({ in: 10, out: 50 }, 1000, 100));
    expect(c.purchased).toBe(0);
  });
  it("charges a stream the client closes before the usage report", async () => {
    const { id, token } = issueToken();
    await setTier(id, "pro");
    const enc = new TextEncoder();
    const upstream = (async () => new Response(new ReadableStream({
      start(c) { c.enqueue(enc.encode(`data: {"id":"c1","choices":[{"delta":{"content":"${"word ".repeat(300)}"}}]}\n\n`)); }, // never ends, no usage
    }), { headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
    const r = await chat(token, upstream, { stream: true });
    expect(r.status).toBe(200);
    const reader = r.body!.getReader();
    await reader.read();
    await reader.cancel();
    const c = await creditsAvailable(id, "pro");
    // 1,500 reply characters, about 500 tokens, plus the input estimate
    expect(TIERS.pro.includedCreditsEur * 1e6 - c.included).toBeGreaterThanOrEqual(costMicros({ in: 10, out: 50 }, 0, 500));
  });
  it("charges nothing when the provider fails before the first word", async () => {
    const { id, token } = issueToken();
    await setTier(id, "pro");
    const failing = (async () => new Response(new ReadableStream({ pull(c) { c.error(new Error("boom")); } }), { headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
    const r = await chat(token, failing, { stream: true });
    await r.text().catch(() => {});
    expect((await creditsAvailable(id, "pro")).included).toBe(TIERS.pro.includedCreditsEur * 1e6);
  });
  it("follows the current plan's allowance: an upgrade mid-month adds the difference at once", async () => {
    const { id } = issueToken();
    await setTier(id, "plus");
    const { accounts } = await stores();
    const month = new Date().toISOString().slice(0, 7);
    await accounts.spendCredits(id, 1_000_000, month, TIERS.plus.includedCreditsEur * 1e6); // Plus's €1 used up
    expect((await creditsAvailable(id, "plus")).included).toBe(0);
    expect((await creditsAvailable(id, "max")).included).toBe((TIERS.max.includedCreditsEur - 1) * 1e6);
  });
  it("resets the included credit each month and keeps bought credit", async () => {
    const { accounts } = await stores();
    await accounts.touchSession("acct-month-test");
    await accounts.addCredits("acct-month-test", 5_000_000, "cs_x");
    await accounts.spendCredits("acct-month-test", 3_000_000, "2026-10", 2_000_000);
    expect(await accounts.getCredits("acct-month-test")).toEqual({ purchased: 4_000_000, includedSpent: 2_000_000, includedMonth: "2026-10" });
    await accounts.spendCredits("acct-month-test", 500_000, "2026-11", 2_000_000);
    expect(await accounts.getCredits("acct-month-test")).toEqual({ purchased: 4_000_000, includedSpent: 500_000, includedMonth: "2026-11" });
    await accounts.spendCredits("acct-month-test", 100, "2026-10", 2_000_000); // a late charge from last month
    expect((await accounts.getCredits("acct-month-test"))?.includedMonth).toBe("2026-11");
    await accounts.deleteAccount("acct-month-test");
    await expect(accounts.spendCredits("acct-month-test", 1, "2026-11", 0)).rejects.toThrow(); // a late charge never brings it back
    expect(await accounts.sessionExists("acct-month-test")).toBe(false);
  });
});
