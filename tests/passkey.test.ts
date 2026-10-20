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
/** The first passkey signs this browser in: it now holds a device token instead of the anonymous one. */
async function save(auth: SoftAuthenticator, token: string) {
  const r = await register(auth, token);
  expect(r.status).toBe(200);
  return decodeURIComponent(/^pai_session=([^;]*)/.exec(r.headers.get("set-cookie") ?? "")![1]);
}
/** Passkey confirmation made with this browser's cookie; it confirms actions for this browser only. */
async function stepUp(auth: SoftAuthenticator, token: string) {
  const opts = await (await loginOptions(post("/api/auth/passkey/login/options", { stepUp: true }, token))).json();
  return loginVerify(post("/api/auth/passkey/login/verify", auth.get(opts, ORIGIN), token));
}
async function login(auth: SoftAuthenticator, origin = ORIGIN) {
  const opts = await (await loginOptions(post("/api/auth/passkey/login/options", {}))).json();
  return loginVerify(post("/api/auth/passkey/login/verify", auth.get(opts, origin)));
}

describe("passkey login", () => {
  beforeEach(() => { _setStores(); });

  it("registration options carry the Hiddensee name, not the old working title", async () => {
    const { token } = await createSession();
    const opts = await (await regOptions(post("/api/auth/passkey/register/options", {}, token))).json();
    expect(opts.rp.name).toBe("Hiddensee");
    expect(opts.user.name).toMatch(/^Hiddensee [A-Za-z0-9_-]{1,6}$/);
  });

  it("register on device A, log in from a fresh browser: same account, same plan", async () => {
    const { id, token } = await createSession();
    await setTier(id, "pro");
    const auth = new SoftAuthenticator();
    const r = await register(auth, token);
    expect(r.status).toBe(200);
    const device = (await r.json()).apiToken as string;
    expect(verifyToken(device)).toBe(id);
    expect(await list(device)).toHaveLength(1);

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
    const { token: anon } = await createSession();
    const mine = new SoftAuthenticator();
    const token = await save(mine, anon);
    const attacker = new SoftAuthenticator();
    const denied = await regOptions(post("/x", {}, token));
    expect(denied.status).toBe(403);
    expect((await denied.json()).error.code).toBe("step_up_required");
    expect((await login(mine)).status).toBe(200);
    expect((await regOptions(post("/x", {}, token))).status).toBe(403); // a sign-in elsewhere confirms nothing here
    expect((await stepUp(mine, token)).status).toBe(200);
    expect((await register(attacker, token)).status).toBe(200); // step-up granted by the confirmation above
    // step-up is single use
    expect((await regOptions(post("/x", {}, token))).status).toBe(403);
    expect(await list(token)).toHaveLength(2);
  });

  it("removing a passkey needs a session, ownership and step-up", async () => {
    const auth = new SoftAuthenticator();
    const a = { token: await save(auth, (await createSession()).token) }; const b = await createSession();
    const [{ id, label }] = await list(a.token);
    expect(label).toBe(id.slice(0, 8));
    expect((await stepUp(auth, a.token)).status).toBe(200);
    expect((await register(new SoftAuthenticator(), a.token)).status).toBe(200); // a second key, so the first may go
    expect((await deletePasskey(del({ id }))).status).toBe(401);
    const noStepUp = await deletePasskey(del({ id }, a.token));
    expect(noStepUp.status).toBe(403);
    expect((await noStepUp.json()).error.code).toBe("step_up_required");
    expect((await deletePasskey(del({ id }, b.token))).status).toBe(404); // b has no passkeys: not found, not 403
    expect((await stepUp(auth, a.token)).status).toBe(200);
    expect((await deletePasskey(del({ nope: 1 }, a.token))).status).toBe(400);
    expect((await deletePasskey(del({ id }, a.token))).status).toBe(200);
    expect(await list(a.token)).toHaveLength(1);
    expect((await login(auth)).status).toBe(401); // removed passkey no longer logs in
  });

  it("the last passkey cannot be removed, so an old anonymous token never gets the account back", async () => {
    const auth = new SoftAuthenticator();
    const { token: anon } = await createSession();
    const device = await save(auth, anon);
    const [{ id }] = await list(device);
    expect((await stepUp(auth, device)).status).toBe(200);
    const r = await deletePasskey(del({ id }, device));
    expect(r.status).toBe(409);
    expect((await r.json()).error.message).toMatch(/add another passkey first or delete the account/);
    expect(await list(device)).toHaveLength(1);
    expect((await register(new SoftAuthenticator(), device)).status).toBe(200); // the refusal did not use up the step-up
    expect((await listPasskeys(new Request(`${ORIGIN}/api/auth/passkey`, { headers: { Cookie: `pai_session=${anon}` } }))).status).toBe(401);
  });

  async function twoPasskeys() {
    const st = _setStores();
    const auth = new SoftAuthenticator();
    const device = await save(auth, (await createSession()).token);
    expect((await stepUp(auth, device)).status).toBe(200);
    expect((await register(new SoftAuthenticator(), device)).status).toBe(200);
    const [{ id }] = await list(device);
    expect((await stepUp(auth, device)).status).toBe(200);
    return { st, device, id };
  }
  it("a removal that loses the race to another one gets 409 and keeps its step-up", async () => {
    const { st, device, id } = await twoPasskeys();
    st.accounts.deleteCredential = async () => false; // the other removal won: this would be the last one
    const r = await deletePasskey(del({ id }, device));
    expect(r.status).toBe(409);
    expect(await list(device)).toHaveLength(2);
    expect((await register(new SoftAuthenticator(), device)).status).toBe(200); // step-up restored
  });
  it("a removal whose passkey vanished meanwhile gets 404 and keeps its step-up", async () => {
    const { st, device, id } = await twoPasskeys();
    const real = st.accounts.deleteCredential.bind(st.accounts);
    st.accounts.deleteCredential = async (acct, cred) => { await real(acct, cred); return false; };
    expect((await deletePasskey(del({ id }, device))).status).toBe(404);
    expect((await register(new SoftAuthenticator(), device)).status).toBe(200);
  });
  it("a store error during removal gives the step-up back", async () => {
    const { st, device, id } = await twoPasskeys();
    st.accounts.deleteCredential = async () => { throw new Error("store down"); };
    await expect(deletePasskey(del({ id }, device))).rejects.toThrow();
    expect((await register(new SoftAuthenticator(), device)).status).toBe(200);
  });

  it("a step-up login only accepts passkeys of the signed-in account", async () => {
    const authA = new SoftAuthenticator(); const authB = new SoftAuthenticator();
    const a = { token: await save(authA, (await createSession()).token) };
    const b = { token: await save(authB, (await createSession()).token) };
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
    const auth = new SoftAuthenticator();
    const token = await save(auth, (await createSession()).token);
    vi.stubEnv("PAI_LIMIT_PASSKEY_LOGINS_PER_MIN", "1");
    await loginOptions(post("/x", {})); // the anonymous bucket is now full
    expect((await loginOptions(post("/x", {}))).status).toBe(429);
    const opts = await (await loginOptions(post("/x", { stepUp: true }, token))).json();
    expect((await loginVerify(post("/x", auth.get(opts, ORIGIN)))).status).toBe(200);
    expect((await regOptions(post("/x", {}, token))).status).toBe(200);
  });
});

describe("invite gate", () => {
  beforeEach(() => { _setStores(); vi.stubEnv("INVITE_CODES", " alpha-123 , beta-456 "); });
  afterEach(() => { vi.unstubAllEnvs(); });
  const reg = async (auth: SoftAuthenticator, token: string, invite?: string) => {
    const o = await regOptions(post("/x", invite === undefined ? {} : { invite }, token));
    return o.ok ? regVerify(post("/x", auth.create(await o.json(), ORIGIN), token)) : o;
  };

  it("the first passkey (signup) needs a listed code", async () => {
    const { token } = await createSession();
    for (const bad of [undefined, "", "alpha", "alpha-1234", "ALPHA-123"]) {
      const r = await regOptions(post("/x", bad === undefined ? {} : { invite: bad }, token));
      expect(r.status).toBe(403);
      expect((await r.json()).error.code).toBe("invite_required");
    }
    expect((await reg(new SoftAuthenticator(), token, " beta-456 ")).status).toBe(200);
  });

  it("existing accounts log in and add passkeys without a code", async () => {
    const { token: anon } = await createSession();
    const mine = new SoftAuthenticator();
    const r = await reg(mine, anon, "alpha-123");
    const token = (await r.json()).apiToken as string;
    expect((await login(mine)).status).toBe(200);
    expect((await stepUp(mine, token)).status).toBe(200);
    expect((await reg(new SoftAuthenticator(), token)).status).toBe(200);
  });

  it("no INVITE_CODES: signup is open", async () => {
    vi.stubEnv("INVITE_CODES", " , ");
    const { token } = await createSession();
    expect((await reg(new SoftAuthenticator(), token)).status).toBe(200);
  });
});
