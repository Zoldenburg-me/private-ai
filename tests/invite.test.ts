import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { _setStores, stores } from "../lib/store";
import { createSession, signInDevice } from "../lib/session";
import { handleChat } from "../lib/handler";
import { inviteOk } from "../lib/invite";
import { normaliseModel } from "../lib/catalog";
import { POST as regOptions } from "../app/api/auth/passkey/register/options/route";
import { POST as regVerify } from "../app/api/auth/passkey/register/verify/route";
import { SoftAuthenticator } from "./helpers/soft-authenticator";

const ORIGIN = "http://localhost:3000";
const cookie = (token: string) => ({ Cookie: `pai_session=${encodeURIComponent(token)}` });
const raw = (token: string, body: string) => new Request(`${ORIGIN}/x`, { method: "POST", headers: { "Content-Type": "application/json", ...cookie(token) }, body });
const post = (token: string, body: unknown) => raw(token, JSON.stringify(body));

const deps = {
  catalog: async () => [normaliseModel({ id: "mock", privacy: "tee-attested" }, { id: "m" })],
  env: { MOCK_PROVIDER: "1", MOCK_BASE_URL: "http://upstream/v1" },
  fetchImpl: (async () => Response.json({ id: "c", choices: [{ message: { content: "ok" } }] })) as unknown as typeof fetch,
};
const chat = (token: string) => handleChat(new Request(`${ORIGIN}/api/v1/chat/completions`, {
  method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ model: "mock:m", messages: [{ role: "user", content: "hi" }] }),
}), "/t", deps);

beforeEach(() => { _setStores(); vi.stubEnv("INVITE_CODES", "alpha-123"); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("invite gate: chat", () => {
  it("anonymous token: 401 signup_required while gated, 200 when open; a device token always chats", async () => {
    const { id, token } = await createSession();
    const r = await chat(token);
    expect(r.status).toBe(401);
    expect((await r.json()).error.code).toBe("signup_required");
    const device = await signInDevice((await createSession()).id);
    expect((await chat(device)).status).toBe(200);
    vi.stubEnv("INVITE_CODES", "");
    expect((await chat(token)).status).toBe(200);
    expect(id).toBeTruthy();
  });
});

describe("invite gate: anonymous web chat", () => {
  const webChat = (token: string) => handleChat(post(token, { model: "mock:m", messages: [{ role: "user", content: "hi" }] }), "/api/chat", deps);

  it("a signed-out visitor chats in the web app while gated, under a whole-instance cap (never per IP)", async () => {
    vi.stubEnv("PAI_LIMIT_ANON_CHATS_PER_MIN", "2");
    const a = (await createSession()).token; const b = (await createSession()).token;
    expect((await webChat(a)).status).toBe(200);
    expect((await webChat(b)).status).toBe(200);
    const r = await webChat((await createSession()).token); // fresh sessions are free to mint: the route cap holds
    expect(r.status).toBe(429);
    expect(r.headers.get("Retry-After")).toBeTruthy();
    expect((await chat(a)).status).toBe(401); // the OpenAI-compatible API still needs an account
    const device = await signInDevice((await createSession()).id);
    expect((await webChat(device)).status).toBe(200); // accounts are not counted against the anonymous cap
  });

  it("gate off: anonymous web chat is never capped by the anonymous budget", async () => {
    vi.stubEnv("INVITE_CODES", ""); vi.stubEnv("PAI_LIMIT_ANON_CHATS_PER_MIN", "1");
    for (let i = 0; i < 3; i++) expect((await webChat((await createSession()).token)).status).toBe(200);
  });

  it("invalid requests do not use up the anonymous budget", async () => {
    vi.stubEnv("PAI_LIMIT_ANON_CHATS_PER_MIN", "1");
    const token = (await createSession()).token;
    expect((await handleChat(raw(token, "{"), "/api/chat", deps)).status).toBe(400);
    expect((await handleChat(post(token, { model: "nope:x", messages: [] }), "/api/chat", deps)).status).toBe(400);
    expect((await webChat(token)).status).toBe(200);
  });

  it("requests the per-account gate rejects do not use up the anonymous budget", async () => {
    vi.stubEnv("PAI_LIMIT_ANON_CHATS_PER_MIN", "1");
    const huge = { model: "mock:m", messages: [{ role: "user", content: "x".repeat(200_000) }] }; // over the free context limit
    expect((await handleChat(post((await createSession()).token, huge), "/api/chat", deps)).status).toBe(413);
    expect((await webChat((await createSession()).token)).status).toBe(200);
  });

  it("the web route passes the route name the anonymous cap keys on", () => {
    expect(readFileSync(join(__dirname, "../app/api/chat/route.ts"), "utf8")).toContain('handleChat(req, "/api/chat"');
  });
});

describe("invite gate: codes", () => {
  it("rejects whitespace-only, non-string and non-JSON invites", async () => {
    expect(inviteOk("   ")).toBe(false);
    expect(inviteOk(123)).toBe(false);
    expect(inviteOk(["alpha-123"])).toBe(false);
    expect(inviteOk("alpha-123")).toBe(true);
    const { token } = await createSession();
    const r = await regOptions(raw(token, "not json"));
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: { message: "invite code required", code: "invite_required" } });
  });

  it("a wrong code says so", async () => {
    const { token } = await createSession();
    const r = await regOptions(post(token, { invite: "nope" }));
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: { message: "invalid invite code", code: "invite_required" } });
  });

  it("NFKC: a full-width code matches", () => {
    expect(inviteOk("ａｌｐｈａ-１２３")).toBe(true);
  });

  it("failed attempts are capped globally", async () => {
    vi.stubEnv("PAI_LIMIT_INVITE_FAILS_PER_MIN", "2");
    for (let i = 0; i < 2; i++) expect((await regOptions(post((await createSession()).token, { invite: "x" }))).status).toBe(403);
    expect((await regOptions(post((await createSession()).token, { invite: "x" }))).status).toBe(429);
  });

  it("a request without a code (the UI's first try) is not a failed guess", async () => {
    vi.stubEnv("PAI_LIMIT_INVITE_FAILS_PER_MIN", "2");
    for (let i = 0; i < 3; i++) expect((await regOptions(post((await createSession()).token, {}))).status).toBe(403);
    expect((await regOptions(post((await createSession()).token, { invite: "x" }))).status).toBe(403);
  });

  it("register/verify without a successful options call creates no account", async () => {
    const { id, token } = await createSession();
    expect((await regOptions(post(token, { invite: "nope" }))).status).toBe(403);
    const fake = { challenge: "A".repeat(43), rp: { id: "localhost" }, user: { id: "dXNlcg" } };
    const v = await regVerify(post(token, new SoftAuthenticator().create(fake, ORIGIN)));
    // Refused at the gate: no admission was recorded by a successful options call.
    expect(v.status).toBe(403);
    expect(v.headers.get("set-cookie")).toBeNull();
    expect(await (await stores()).accounts.listCredentials(id)).toHaveLength(0);
  });
});
