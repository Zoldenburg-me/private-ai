import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { _setStores } from "../lib/store";
import { createSession, setTier, signInDevice } from "../lib/session";
import { handleChat } from "../lib/handler";
import { LIMITS } from "../lib/limits";
import { normaliseModel } from "../lib/catalog";
import { isLocked, needsSignIn } from "../components/app/ModelPicker";

const tee = normaliseModel({ id: "mock", privacy: "tee-attested" }, { id: "m" });
const opus = normaliseModel({ id: "liquid", privacy: "anon-gateway" }, { id: "claude-opus-5-5" });
const fable = normaliseModel({ id: "liquid", privacy: "anon-gateway" }, { id: "claude-fable-5-1" });

let sent = 0;
const deps = {
  catalog: async () => [tee, opus, fable],
  env: { MOCK_PROVIDER: "1", MOCK_BASE_URL: "http://upstream/v1", LIQUID_API_KEY: "k", LIQUID_BASE_URL: "http://upstream/v1" },
  fetchImpl: (async () => { sent++; return Response.json({ id: "c", choices: [{ message: { content: "ok" } }] }); }) as unknown as typeof fetch,
  log: () => {},
};
const chat = (token: string, model: string) => handleChat(new Request("http://app/api/chat", {
  method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
}), "/api/chat", deps);

beforeEach(() => { _setStores(); sent = 0; vi.stubEnv("INVITE_CODES", ""); vi.stubEnv("PAI_LIMIT_ANON_CHATS_PER_MIN", ""); });
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
});

describe("picker", () => {
  it("locks every model but free TEE ones for signed-out visitors", () => {
    expect(needsSignIn(opus, false, false)).toBe(true);
    expect(needsSignIn(fable, false, false)).toBe(true);
    expect(needsSignIn(tee, false, false)).toBe(false);
    expect(needsSignIn(opus, true, false)).toBe(false); // signed in
    expect(needsSignIn(opus, false, true)).toBe(false); // paid anonymous account
    expect(needsSignIn(opus, undefined, undefined)).toBe(false); // session still loading
    expect(isLocked(opus, false)).toBe(false); // the paid-plan lock is unchanged
  });
});
