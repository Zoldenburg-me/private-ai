import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleChat } from "../lib/handler";
import { issueToken, setTier } from "../lib/session";
import { gate, _reset } from "../lib/ratelimit";
import { normaliseModel } from "../lib/catalog";
import { loadProviders } from "../lib/providers";
import { TIERS } from "../lib/tiers";
import { defaultModelRef, pickerGroup, visibleModels } from "../lib/client/providers";

const liquid = { id: "liquid", privacy: "anon-gateway" } as const;
const open = normaliseModel(liquid, { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" });
const fable = normaliseModel(liquid, { id: "claude-fable-5-1", name: "Claude Fable 5.1" });

let sent: Record<string, unknown>[] = [];
const upstream = vi.fn(async (_url: string, init: RequestInit) => {
  sent.push(JSON.parse(String(init.body)));
  return Response.json({ id: "x", choices: [{ message: { content: "ok" } }] });
}) as unknown as typeof fetch;
const deps = { catalog: async () => [open, fable], env: { LIQUID_API_KEY: "k", LIQUID_BASE_URL: "http://upstream/v1" }, fetchImpl: upstream, log: () => {} };
const chat = (token: string, model: string, extra: Record<string, unknown> = {}) =>
  handleChat(new Request("http://app/api/chat", { method: "POST", headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], ...extra }) }), "/api/chat", deps);

beforeEach(() => { _reset(); sent = []; });

describe("Liquid provider", () => {
  it("is on with just a key and offers open-weight models first, then frontier", () => {
    const [p] = loadProviders({ LIQUID_API_KEY: "k" });
    expect(p).toMatchObject({ id: "liquid", privacy: "anon-gateway", baseUrl: "https://router.inference.ai.exchange/v1" });
    expect(p.models?.slice(0, 2)).toEqual(["deepseek-v4.1-flash", "kimi-k3"]);
    expect(p.models).toContain("claude-opus-5-5");
    expect(loadProviders({ LIQUID_API_KEY: "k", LIQUID_MODELS: "kimi-k3" })[0].models).toEqual(["kimi-k3"]);
    expect(normaliseModel(liquid, { id: "claude-opus-5-5" }).name).toBe("Claude Opus 5.5"); // Liquid lists no names
  });

  it("every request asks the exchange for zero-retention offers, and the client cannot override it", async () => {
    const { token } = issueToken();
    const r = await chat(token, "liquid:deepseek-v4.1-flash", { exchange: { retention_policy: "allowed" } });
    expect(r.status).toBe(200);
    expect(sent[0].exchange).toEqual({ retention_policy: "none", cache: "off" });
  });
});

describe("paid-only frontier models", () => {
  it("are flagged in the catalog", () => {
    expect(fable.paid).toBe(true);
    expect(open.paid).toBeUndefined();
  });

  it("are refused for free users and served for paid ones", async () => {
    const { id, token } = issueToken();
    expect((await chat(token, "liquid:claude-fable-5-1")).status).toBe(402);
    expect(sent).toHaveLength(0);
    await setTier(id, "pro");
    expect((await chat(token, "liquid:claude-fable-5-1")).status).toBe(200);
  });
});

describe("incognito quota", () => {
  it("free users get 50 incognito messages a day, apart from their 20 TEE messages", async () => {
    let now = Date.UTC(2026, 9, 21, 1);
    for (let i = 0; i < TIERS.free.dailyMessages; i++) { await gate("u", "free", 1, now); now += 13_000; }
    expect((await gate("u", "free", 1, now)).reason).toBe("daily limit reached");
    for (let i = 0; i < 50; i++) { expect((await gate("u", "free", 1, now, true)).allowed).toBe(true); now += 13_000; }
    const d = await gate("u", "free", 1, now, true);
    expect(d.reason).toBe("daily limit reached");
    expect(d.headers["x-usage-limit-daily"]).toBe("50");
  });

  it("an incognito chat reports the incognito quota", async () => {
    const { token } = issueToken();
    const r = await chat(token, "liquid:deepseek-v4.1-flash");
    expect(r.headers.get("x-usage-limit-daily")).toBe("50");
    expect(r.headers.get("x-usage-remaining-daily")).toBe("49");
  });
});

it("the picker puts every selectable non-TEE model in one Incognito group", () => {
  const venice = normaliseModel({ id: "venice", privacy: "anon-gateway" }, { id: "v" });
  const tee = normaliseModel({ id: "near", privacy: "tee-attested" }, { id: "q" }, true);
  const blocked = normaliseModel({ id: "near", privacy: "tee-attested" }, { id: "closed" }, false);
  expect([open, venice, tee, blocked].map(pickerGroup)).toEqual(["incognito", "incognito", "near", "near"]);
});

describe("Venice private routes", () => {
  const venice = { id: "venice", privacy: "anon-gateway" } as const;
  const kimiPrivate = normaliseModel(venice, { id: "kimi-k3", model_spec: { name: "Kimi K3", privacy: "private" } });
  const kimiLiquid = normaliseModel(liquid, { id: "kimi-k3" });
  const opusVenice = normaliseModel(venice, { id: "claude-opus-5-5", model_spec: { name: "Claude Opus 5.5", privacy: "anonymized" } });
  const opusLiquid = normaliseModel(liquid, { id: "claude-opus-5-5" });

  it("the picker shows each model once: the private route wins, otherwise Liquid's zero-retention route", () => {
    const shown = visibleModels([kimiLiquid, opusLiquid, kimiPrivate, opusVenice]);
    expect(shown.map((m) => `${m.provider}:${m.privacy}`)).toEqual(["venice:private", "liquid:anonymized"]);
  });

  it("models are matched by id, never by display name", () => {
    const glmPrivate = normaliseModel(venice, { id: "z-ai-glm-5-3", model_spec: { name: "GLM 5.3 (latest)", privacy: "private" } });
    const lookalike = normaliseModel(venice, { id: "kimi-k3-long", model_spec: { name: "Kimi K3", privacy: "anonymized" } });
    const shown = visibleModels([normaliseModel(liquid, { id: "glm-5.3" }), kimiLiquid, glmPrivate, lookalike]);
    expect(shown.map((m) => `${m.provider}:${m.id}`)).toEqual(["venice:z-ai-glm-5-3", "liquid:kimi-k3", "venice:kimi-k3-long"]);
  });

  it("private models count against the incognito quota and are never the default", async () => {
    expect(defaultModelRef([kimiPrivate])).toBe("");
    const { token } = issueToken();
    const d = { ...deps, catalog: async () => [kimiPrivate], env: { VENICE_API_KEY: "k", VENICE_BASE_URL: "http://upstream/v1" } };
    const r = await handleChat(new Request("http://app/api/chat", { method: "POST", headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: "venice:kimi-k3", messages: [{ role: "user", content: "hi" }] }) }), "/api/chat", d);
    expect(r.headers.get("x-usage-limit-daily")).toBe("50");
    expect(sent[0].exchange).toBeUndefined(); // the Liquid rule is not sent to other providers
  });
});
