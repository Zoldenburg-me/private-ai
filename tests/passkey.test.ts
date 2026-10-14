import { describe, it, expect, beforeEach } from "vitest";
import { _setStores } from "../lib/store";
import { createSession, setTier, verifyToken } from "../lib/session";
import { POST as regOptions } from "../app/api/auth/passkey/register/options/route";
import { POST as regVerify } from "../app/api/auth/passkey/register/verify/route";
import { POST as loginOptions } from "../app/api/auth/passkey/login/options/route";
import { POST as loginVerify } from "../app/api/auth/passkey/login/verify/route";
import { GET as listPasskeys } from "../app/api/auth/passkey/route";
import { SoftAuthenticator } from "./helpers/soft-authenticator";

const ORIGIN = "http://localhost:3000";
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
