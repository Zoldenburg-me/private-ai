import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { _setStores, StoreUnavailableError } from "../lib/store";
import { MemoryCounterStore } from "../lib/store/memory";
import { createSession, setTier, signInDevice } from "../lib/session";
import { handleChat } from "../lib/handler";
import { LIMITS } from "../lib/limits";
import { normaliseModel } from "../lib/catalog";
import { isLocked, needsSignIn } from "../components/app/ModelPicker";
import { signInUnlocks } from "../lib/client/levels";
import { ANON_MAX_OUTPUT_TOKENS, TIERS } from "../lib/tiers";
import { usage } from "../lib/ratelimit";

const tee = normaliseModel({ id: "mock", privacy: "tee-attested" }, { id: "m" });
const opus = normaliseModel({ id: "liquid", privacy: "anon-gateway" }, { id: "claude-opus-5-5" });
const fable = normaliseModel({ id: "liquid", privacy: "anon-gateway" }, { id: "claude-fable-5-1" });
const tinfoil = { id: "tinfoil", privacy: "tee-attested" } as const;
const curated = normaliseModel(tinfoil, { id: "kimi-k3", type: "chat" }); // a curated Auto route
const big = normaliseModel(tinfoil, { id: "gpt-oss-120b", type: "chat" }); // TEE and free, but not curated

let sent = 0; let bodies: Record<string, unknown>[] = [];
const deps = {
  catalog: async () => [tee, opus, fable, curated, big],
  env: { MOCK_PROVIDER: "1", MOCK_BASE_URL: "http://upstream/v1", LIQUID_API_KEY: "k", LIQUID_BASE_URL: "http://upstream/v1", TINFOIL_API_KEY: "k", TINFOIL_BASE_URL: "http://upstream/v1" },
  fetchImpl: (async (_u: string, init: RequestInit) => { sent++; bodies.push(JSON.parse(String(init.body))); return Response.json({ id: "c", choices: [{ message: { content: "ok" } }] }); }) as unknown as typeof fetch,
  log: () => {},
};
const chat = (token: string, model: string, extra: Record<string, unknown> = {}) => handleChat(new Request("http://app/api/chat", {
  method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], ...extra }),
}), "/api/chat", deps);

beforeEach(() => { _setStores(); sent = 0; bodies = []; vi.stubEnv("INVITE_CODES", ""); vi.stubEnv("PAI_LIMIT_ANON_CHATS_PER_MIN", ""); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("anonymous sessions: free TEE models only", () => {
  for (const gated of [false, true]) {
    it(`a frontier or incognito model needs sign-in (invite gate ${gated ? "on" : "off"}), nothing reaches the provider`, async () => {
      if (gated) vi.stubEnv("INVITE_CODES", "alpha-123");
      const { token } = await createSession();
      for (const m of ["liquid:claude-opus-5-5", "liquid:claude-fable-5-1"]) {
        const r = await chat(token, m);
        expect(r.status).toBe(401);
        expect((await r.json()).error).toEqual({ message: "Sign in to use this model.", code: "signin_required" });
      }
      expect(sent).toBe(0);
    });
  }

  it("a free TEE model still works for an anonymous session", async () => {
    const { token } = await createSession();
    expect((await chat(token, "mock:m")).status).toBe(200);
  });

  it("only the curated Auto routes, not every free TEE model", async () => {
    const { token } = await createSession();
    const r = await chat(token, "tinfoil:gpt-oss-120b");
    expect(r.status).toBe(401);
    expect((await r.json()).error.code).toBe("signin_required");
    expect(sent).toBe(0);
    expect((await chat(token, "tinfoil:kimi-k3")).status).toBe(200); // the route the web client's Auto resolves to
    expect((await chat(token, "auto:kimi-k3")).status).toBe(200);
    const device = await signInDevice((await createSession()).id);
    expect((await chat(device, "tinfoil:gpt-oss-120b")).status).toBe(200);
  });

  it("caps an anonymous reply below the free plan", async () => {
    expect(ANON_MAX_OUTPUT_TOKENS).toBeLessThan(TIERS.free.maxOutputTokens);
    await chat((await createSession()).token, "mock:m", { max_tokens: 100_000 });
    await chat((await createSession()).token, "mock:m");
    expect(bodies.map((b) => b.max_tokens)).toEqual([ANON_MAX_OUTPUT_TOKENS, ANON_MAX_OUTPUT_TOKENS]);
    await chat(await signInDevice((await createSession()).id), "mock:m", { max_tokens: 100_000 });
    expect(bodies[2].max_tokens).toBe(TIERS.free.maxOutputTokens);
  });

  it("a signed-in free account may use incognito models", async () => {
    const device = await signInDevice((await createSession()).id);
    expect((await chat(device, "liquid:claude-opus-5-5")).status).toBe(200);
  });

  it("an anonymous account on a paid plan keeps what it pays for", async () => {
    const { id, token } = await createSession();
    await setTier(id, "pro");
    expect((await chat(token, "liquid:claude-fable-5-1")).status).toBe(200);
  });
});

describe("anonymous web chat cap", () => {
  it("defaults to 10 per minute for the whole instance", async () => {
    expect(LIMITS.anonChat.fallback).toBe(10);
    vi.stubEnv("INVITE_CODES", "alpha-123");
    for (let i = 0; i < 10; i++) expect((await chat((await createSession()).token, "mock:m")).status).toBe(200);
    expect((await chat((await createSession()).token, "mock:m")).status).toBe(429);
  });

  it("a session out of daily messages is refused by its own quota, not the shared cap", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-25T12:00:00Z"));
    try {
      vi.stubEnv("INVITE_CODES", "alpha-123"); vi.stubEnv("PAI_LIMIT_ANON_CHATS_PER_MIN", "2");
      const { token } = await createSession();
      for (let i = 0; i < TIERS.free.dailyMessages; i++) { // a minute apart: each is a fresh window for both limits
        expect((await chat(token, "mock:m")).status).toBe(200);
        vi.setSystemTime(Date.now() + 61_000);
      }
      for (let i = 0; i < 3; i++) expect((await chat(token, "mock:m")).status).toBe(429);
      expect((await chat((await createSession()).token, "mock:m")).status).toBe(200);
    } finally { vi.useRealTimers(); }
  });

  it("a request that ends in a store outage gives its shared-cap slot back (and still fails closed)", async () => {
    vi.stubEnv("INVITE_CODES", "alpha-123"); vi.stubEnv("PAI_LIMIT_ANON_CHATS_PER_MIN", "1");
    const counters = new MemoryCounterStore(); _setStores({ counters });
    const { token } = await createSession();
    const consume = counters.consume.bind(counters);
    counters.consume = async () => { throw new StoreUnavailableError("redis"); };
    expect((await chat(token, "mock:m")).status).toBe(503);
    counters.consume = consume;
    expect((await chat(token, "mock:m")).status).toBe(200);
  });

  it("requests the session's own limits refuse give their shared-cap slot back", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-25T12:00:00Z"));
    try {
      vi.stubEnv("INVITE_CODES", "alpha-123"); vi.stubEnv("PAI_LIMIT_ANON_CHATS_PER_MIN", "2");
      const { token } = await createSession();
      for (let i = 0; i < TIERS.free.dailyMessages - 1; i++) { expect((await chat(token, "mock:m")).status).toBe(200); vi.setSystemTime(Date.now() + 61_000); }
      // One daily message left, two at once: one is answered, the other refused by the daily quota.
      expect((await Promise.all([chat(token, "mock:m"), chat(token, "mock:m")])).map((r) => r.status).sort()).toEqual([200, 429]);
      expect((await chat((await createSession()).token, "mock:m")).status).toBe(200); // the refused one's slot is free again
      // Over the per-minute limit: refused by the session's own window, the shared cap is untouched.
      vi.setSystemTime(Date.now() + 61_000);
      const busy = (await createSession()).token;
      vi.stubEnv("PAI_LIMIT_ANON_CHATS_PER_MIN", String(TIERS.free.requestsPerMinute + 1));
      for (let i = 0; i < TIERS.free.requestsPerMinute; i++) expect((await chat(busy, "mock:m")).status).toBe(200);
      for (let i = 0; i < 3; i++) expect((await chat(busy, "mock:m")).status).toBe(429);
      expect((await chat((await createSession()).token, "mock:m")).status).toBe(200);
    } finally { vi.useRealTimers(); }
  });

  it("a message the cap refuses does not cost the session a daily message", async () => {
    vi.stubEnv("INVITE_CODES", "alpha-123"); vi.stubEnv("PAI_LIMIT_ANON_CHATS_PER_MIN", "1");
    const { id, token } = await createSession();
    expect((await chat(token, "mock:m")).status).toBe(200);
    expect((await chat(token, "mock:m")).status).toBe(429);
    expect((await usage(id, "free")).usedToday).toBe(1);
  });
});

describe("picker", () => {
  it("locks every model but free TEE ones for signed-out visitors", () => {
    expect(needsSignIn(opus, false, false)).toBe(true);
    expect(needsSignIn(fable, false, false)).toBe(true);
    expect(needsSignIn(tee, false, false)).toBe(false);
    expect(needsSignIn(big, false, false)).toBe(true); // free TEE, but not a curated Auto route
    expect(needsSignIn(curated, false, false)).toBe(false);
    expect(needsSignIn({ ...curated, provider: "auto" }, false, false)).toBe(false);
    expect(needsSignIn(opus, true, false)).toBe(false); // signed in
    expect(needsSignIn(opus, false, true)).toBe(false); // paid anonymous account
    expect(needsSignIn(opus, undefined, undefined)).toBe(false); // session still loading
    expect(isLocked(opus, false)).toBe(false); // the paid-plan lock is unchanged
  });
});

describe("Auto's sign-in note", () => {
  const zdr = normaliseModel({ id: "custom", privacy: "zdr-contract" }, { id: "z" });
  const all = [tee, opus, fable, zdr];
  const usable = all.filter((m) => !needsSignIn(m, false, false));

  it("shows only where signing in unlocks a model", () => {
    expect(signInUnlocks(all, usable, "anon")).toBe(true); // Opus is locked for the visitor
    expect(signInUnlocks(all, usable, "medium")).toBe(true);
    expect(signInUnlocks(all, usable, "max")).toBe(false); // the TEE model is usable already
  });

  it("not on a level the server has no models for, nor when only paid-only models are locked", () => {
    const teeOnly = [tee];
    expect(signInUnlocks(teeOnly, teeOnly, "medium")).toBe(false);
    expect(signInUnlocks([tee, fable], [tee], "anon")).toBe(false); // signing in on the free plan would not unlock Fable
  });

  it("never for a signed-in visitor", () => {
    expect(signInUnlocks(all, all.filter((m) => !needsSignIn(m, true, false)), "anon")).toBe(false);
  });
});
