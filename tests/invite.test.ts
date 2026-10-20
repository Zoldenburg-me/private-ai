import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { _setStores, stores } from "../lib/store";
import { createSession, signInDevice } from "../lib/session";
import { handleChat } from "../lib/handler";
import { inviteOk, _resetInviteWarning } from "../lib/invite";
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

  it("production with no codes logs one metadata warning", async () => {
    vi.stubEnv("INVITE_CODES", ""); vi.stubEnv("NODE_ENV", "production");
    _resetInviteWarning();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    inviteOk("x"); inviteOk("y");
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({ event: "invite_gate_off" });
  });
});
