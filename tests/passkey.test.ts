import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { _setStores } from "../lib/store";
import { createSession, setTier, verifyToken } from "../lib/session";
import { POST as regOptions } from "../app/api/auth/passkey/register/options/route";
import { POST as regVerify } from "../app/api/auth/passkey/register/verify/route";
import { POST as loginOptions } from "../app/api/auth/passkey/login/options/route";
import { POST as loginVerify } from "../app/api/auth/passkey/login/verify/route";
import { GET as listPasskeys, DELETE as deletePasskey } from "../app/api/auth/passkey/route";
import { SoftAuthenticator } from "./helpers/soft-authenticator";

const ORIGIN = "http://localhost:3000";
const del = (body: unknown, token?: string) => new Request(`${ORIGIN}/api/auth/passkey`, {
  method: "DELETE", headers: { "Content-Type": "application/json", ...(token ? { Cookie: `pai_session=${encodeURIComponent(token)}` } : {}) }, body: JSON.stringify(body),
});
const list = async (token: string) => (await (await listPasskeys(new Request(`${ORIGIN}/api/auth/passkey`, { headers: { Cookie: `pai_session=${token}` } }))).json()).passkeys as { id: string; label: string; createdAt: number }[];
const post = (path: string, body: unknown, token?: string) => new Request(`${ORIGIN}${path}`, {
  method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Cookie: `pai_session=${encodeURIComponent(token)}` } : {}) }, body: JSON.stringify(body ?? {}),
});

async function register(auth: SoftAuthenticator, token: string) {
  const opts = await (await regOptions(post("/api/auth/passkey/register/options", {}, token))).json();
  return regVerify(post("/api/auth/passkey/register/verify", auth.create(opts, ORIGIN), token));
}
async function login(auth: SoftAuthenticator, origin = ORIGIN) {
  const opts = await (await loginOptions(post("/api/auth/passkey/login/options", {}))).json();
  return loginVerify(post("/api/auth/passkey/login/verify", auth.get(opts, origin)));
}

describe("passkey login", () => {
  beforeEach(() => { _setStores(); });

  it("register on device A, log in from a fresh browser: same account, same plan", async () => {
    const { id, token } = await createSession();
    await setTier(id, "pro");
    const auth = new SoftAuthenticator();
    const r = await register(auth, token);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ registered: true });
    expect((await (await listPasskeys(new Request(`${ORIGIN}/api/auth/passkey`, { headers: { Cookie: `pai_session=${token}` } }))).json()).passkeys).toHaveLength(1);

    const res = await login(auth); // no cookie: a fresh browser
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tier.id).toBe("pro");
    expect(verifyToken(body.apiToken)).toBe(id);
    expect(res.headers.get("set-cookie")).toMatch(/^pai_session=pai_.*HttpOnly; SameSite=Strict/);
  });

  it("registration needs a session and a fresh, account-bound challenge", async () => {
    expect((await regOptions(post("/api/auth/passkey/register/options", {}))).status).toBe(401);
    const a = await createSession(); const b = await createSession();
    const auth = new SoftAuthenticator();
    const opts = await (await regOptions(post("/x", {}, a.token))).json();
    const cred = auth.create(opts, ORIGIN);
    // another account cannot redeem A's challenge
    expect((await regVerify(post("/x", cred, b.token))).status).toBe(400);
    // and the challenge was consumed by that attempt
    expect((await regVerify(post("/x", cred, a.token))).status).toBe(400);
  });

  it("rejects wrong origin, replayed challenge and unknown credentials", async () => {
    const { token } = await createSession();
    const auth = new SoftAuthenticator();
    expect((await register(auth, token)).status).toBe(200);
    expect((await login(auth, "https://evil.example")).status).toBe(401);

    const opts = await (await loginOptions(post("/x", {}))).json();
    const assertion = auth.get(opts, ORIGIN);
    expect((await loginVerify(post("/x", assertion))).status).toBe(200);
    expect((await loginVerify(post("/x", assertion))).status).toBe(400); // replay: challenge already used

    const stranger = new SoftAuthenticator();
    stranger.create({ challenge: "AAAAAAAAAAAAAAAAAAAAAA", rp: { id: "localhost" }, user: { id: "x" } }, ORIGIN);
    expect((await login(stranger)).status).toBe(401);
    expect((await loginVerify(post("/x", { nope: 1 }))).status).toBe(400);
  });

  it("stores only opaque ids, public key, counter and transports", async () => {
    const stores = _setStores();
    const { id, token } = await createSession();
    const auth = new SoftAuthenticator();
    await register(auth, token);
    await login(auth);
    const [c] = await stores.accounts.listCredentials(id);
    expect(Object.keys(c).sort()).toEqual(["accountId", "counter", "createdAt", "credentialId", "publicKey", "transports"]);
    expect(c.counter).toBe(1);
  });
});

describe("passkey hardening", () => {
  beforeEach(() => { _setStores(); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("requires user verification (PIN/biometric) on registration and login", async () => {
    const { token } = await createSession();
    expect((await register(new SoftAuthenticator({ uv: false }), token)).status).toBe(400);
    const auth = new SoftAuthenticator();
    expect((await register(auth, token)).status).toBe(200);
    const opts = await (await loginOptions(post("/x", {}))).json();
    expect(opts.userVerification).toBe("required");
    // the registered key, now asserting with presence only
    (auth as unknown as { opts: { uv?: boolean } }).opts.uv = false;
    expect((await login(auth)).status).toBe(401);
  });

  it("a second passkey needs a fresh passkey login (step-up); a stolen cookie alone cannot add one", async () => {
    const { token } = await createSession();
    const mine = new SoftAuthenticator();
    expect((await register(mine, token)).status).toBe(200);
    const attacker = new SoftAuthenticator();
    const denied = await regOptions(post("/x", {}, token));
    expect(denied.status).toBe(403);
    expect((await denied.json()).error.code).toBe("step_up_required");
    expect((await login(mine)).status).toBe(200);
    expect((await register(attacker, token)).status).toBe(200); // step-up granted by the login above
    // step-up is single use
    expect((await regOptions(post("/x", {}, token))).status).toBe(403);
    expect(await list(token)).toHaveLength(2);
  });

  it("removing a passkey needs a session, ownership and step-up", async () => {
    const a = await createSession(); const b = await createSession();
    const auth = new SoftAuthenticator();
    await register(auth, a.token);
    const [{ id, label }] = await list(a.token);
    expect(label).toBe(id.slice(0, 8));
    expect((await deletePasskey(del({ id }))).status).toBe(401);
    const noStepUp = await deletePasskey(del({ id }, a.token));
    expect(noStepUp.status).toBe(403);
    expect((await noStepUp.json()).error.code).toBe("step_up_required");
    expect((await deletePasskey(del({ id }, b.token))).status).toBe(404); // b has no passkeys: not found, not 403
    expect((await login(auth)).status).toBe(200);
    expect((await deletePasskey(del({ nope: 1 }, a.token))).status).toBe(400);
    expect((await deletePasskey(del({ id }, a.token))).status).toBe(200);
    expect(await list(a.token)).toHaveLength(0);
    expect((await login(auth)).status).toBe(401); // removed passkey no longer logs in
  });

  it("a step-up login only accepts passkeys of the signed-in account", async () => {
    const a = await createSession(); const b = await createSession();
    const authA = new SoftAuthenticator(); const authB = new SoftAuthenticator();
    await register(authA, a.token); await register(authB, b.token);
    expect((await loginOptions(post("/x", { stepUp: true }))).status).toBe(401); // step-up needs a session
    const opts = await (await loginOptions(post("/x", { stepUp: true }, a.token))).json();
    expect(opts.allowCredentials.map((c: { id: string }) => c.id)).toEqual((await list(a.token)).map((p) => p.id));
    expect((await loginVerify(post("/x", authB.get(opts, ORIGIN)))).status).toBe(401); // B's passkey cannot confirm for A
    expect((await regOptions(post("/x", {}, b.token))).status).toBe(403); // and granted B nothing
    const ok = await (await loginOptions(post("/x", { stepUp: true }, a.token))).json();
    expect((await loginVerify(post("/x", authA.get(ok, ORIGIN)))).status).toBe(200);
    expect((await regOptions(post("/x", {}, a.token))).status).toBe(200);
  });

  it("login challenges are capped globally so Redis cannot be filled", async () => {
    vi.stubEnv("PAI_LIMIT_PASSKEY_LOGINS_PER_MIN", "3");
    for (let i = 0; i < 3; i++) expect((await loginOptions(post("/x", {}))).status).toBe(200);
    const r = await loginOptions(post("/x", {}));
    expect(r.status).toBe(429);
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("a flood of anonymous logins does not block step-up for signed-in accounts", async () => {
    const { token } = await createSession();
    const auth = new SoftAuthenticator();
    await register(auth, token);
    vi.stubEnv("PAI_LIMIT_PASSKEY_LOGINS_PER_MIN", "1");
    await loginOptions(post("/x", {})); // the anonymous bucket is now full
    expect((await loginOptions(post("/x", {}))).status).toBe(429);
    const opts = await (await loginOptions(post("/x", { stepUp: true }, token))).json();
    expect((await loginVerify(post("/x", auth.get(opts, ORIGIN)))).status).toBe(200);
    expect((await regOptions(post("/x", {}, token))).status).toBe(200);
  });
});
