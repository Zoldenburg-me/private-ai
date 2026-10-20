import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { _setStores, type Stores } from "../lib/store";
import { erasureHash } from "../lib/store/types";
import { MemoryAccountStore } from "../lib/store/memory";
import { createSession, resolveIdentity, setTier, tierOf } from "../lib/session";
import { issueAdminToken, ADMIN_COOKIE } from "../lib/admin";
import { liveProviders, _resetKeyCache } from "../lib/provider-keys";
import { sealKey, openKey } from "../lib/keyvault";
import { POST as regOptions } from "../app/api/auth/passkey/register/options/route";
import { POST as regVerify } from "../app/api/auth/passkey/register/verify/route";
import { POST as adminLoginOptions } from "../app/api/admin/login/options/route";
import { POST as adminLoginVerify } from "../app/api/admin/login/verify/route";
import { POST as adminStepUpOptions } from "../app/api/admin/stepup/options/route";
import { GET as accountsGET } from "../app/api/admin/accounts/route";
import { GET as accountGET, DELETE as accountDELETE } from "../app/api/admin/account/route";
import { POST as entitlementPOST, DELETE as entitlementDELETE } from "../app/api/admin/account/entitlement/route";
import { DELETE as deviceDELETE } from "../app/api/admin/account/device/route";
import { GET as keysGET, POST as keysPOST, PATCH as keysPATCH, DELETE as keysDELETE } from "../app/api/admin/keys/route";
import { GET as invitesGET, POST as invitesPOST, DELETE as invitesDELETE } from "../app/api/admin/invites/route";
import { GET as auditGET } from "../app/api/admin/audit/route";
import { POST as userLoginOptions } from "../app/api/auth/passkey/login/options/route";
import { POST as userLoginVerify } from "../app/api/auth/passkey/login/verify/route";
import { getCatalog, _clearCatalog } from "../lib/catalog-cache";
import { SoftAuthenticator } from "./helpers/soft-authenticator";

const ORIGIN = "http://localhost:3000";
const KEK = randomBytes(32).toString("base64");
type Json = Record<string, unknown>;

const userReq = (path: string, method: string, token?: string, body?: unknown) => new Request(`${ORIGIN}${path}`, {
  method, headers: { "Content-Type": "application/json", ...(token ? { Cookie: `pai_session=${encodeURIComponent(token)}` } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const req = (path: string, method: string, admin?: string, body?: unknown) => new Request(`${ORIGIN}${path}`, {
  method, headers: { "Content-Type": "application/json", ...(admin ? { Cookie: `${ADMIN_COOKIE}=${encodeURIComponent(admin)}` } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const cookieOf = (r: Response, name: string) => {
  const m = new RegExp(`^${name}=([^;]*)`).exec(r.headers.get("set-cookie") ?? "");
  return m ? decodeURIComponent(m[1]) : null;
};

/** A normal user account with a passkey; returns its id and device token. */
async function createAccount(auth: SoftAuthenticator) {
  const { id, token } = await createSession();
  const opts = await (await regOptions(userReq("/r", "POST", token, {}))).json();
  const r = await regVerify(userReq("/r", "POST", token, auth.create(opts, ORIGIN)));
  expect(r.status).toBe(200);
  return { id, device: cookieOf(r, "pai_session")! };
}
async function adminLogin(auth: SoftAuthenticator) {
  const opts = await (await adminLoginOptions(req("/a", "POST", undefined, {}))).json();
  return adminLoginVerify(req("/a", "POST", undefined, auth.get(opts, ORIGIN)));
}
async function stepUp(auth: SoftAuthenticator, admin: string) {
  const o = await adminStepUpOptions(req("/s", "POST", admin, {}));
  expect(o.status).toBe(200);
  const v = await adminLoginVerify(req("/a", "POST", admin, auth.get(await o.json(), ORIGIN)));
  expect(v.status).toBe(200);
  expect(await v.json()).toEqual({ confirmed: true });
}

let st: Stores;
let adminAuth: SoftAuthenticator;
let adminId: string;
let admin: string;

beforeEach(async () => {
  st = _setStores();
  _resetKeyCache();
  vi.stubEnv("ADMIN_KEY_KEK", KEK);
  vi.stubEnv("INVITE_CODES", "");
  vi.stubEnv("INVITE_ONLY", "");
  adminAuth = new SoftAuthenticator();
  adminId = (await createAccount(adminAuth)).id;
  vi.stubEnv("ADMIN_ACCOUNT_IDS", `someone_else_123,${adminId}`);
  const r = await adminLogin(adminAuth);
  expect(r.status).toBe(200);
  admin = cookieOf(r, ADMIN_COOKIE)!;
  expect(admin).toBeTruthy();
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

/** Every app/api/admin/**\/route.ts, so a new route cannot skip the auth check. */
function adminRoutes(): string[] {
  const dir = join(__dirname, "..", "app", "api", "admin");
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? walk(p) : f === "route.ts" ? [p] : [];
  });
  return walk(dir);
}
const PUBLIC = new Set(["login/options/route.ts", "login/verify/route.ts", "logout/route.ts"]);

describe("admin auth: every admin API route rejects non-admins", () => {
  it("rejects no cookie, a user session, a non-allowlisted admin token, a forged and an expired token", async () => {
    const user = await createAccount(new SoftAuthenticator());
    const forged = admin.slice(0, -4) + (admin.endsWith("AAAA") ? "BBBB" : "AAAA");
    const outsider = issueAdminToken(user.id);
    const expired = issueAdminToken(adminId, Date.now() - 24 * 3_600_000);
    const files = adminRoutes();
    expect(files.length).toBeGreaterThanOrEqual(10);
    let checked = 0;
    for (const f of files) {
      const rel = relative(join(__dirname, "..", "app", "api", "admin"), f);
      if (PUBLIC.has(rel)) continue;
      const mod = (await import(f)) as Record<string, unknown>;
      for (const m of ["GET", "POST", "PATCH", "PUT", "DELETE"]) {
        const h = mod[m] as ((r: Request) => Promise<Response>) | undefined;
        if (!h) continue;
        const body = m === "GET" ? undefined : { id: user.id, provider: "near", key: "sk-x", tier: "max" };
        for (const [label, r] of [
          ["none", req("/x?id=" + user.id, m, undefined, body)],
          ["user", new Request(`${ORIGIN}/x?id=${user.id}`, { method: m, headers: { "Content-Type": "application/json", Cookie: `pai_session=${encodeURIComponent(user.device)}` }, body: body && JSON.stringify(body) })],
          ["outsider", req("/x?id=" + user.id, m, outsider, body)],
          ["forged", req("/x?id=" + user.id, m, forged, body)],
          ["expired", req("/x?id=" + user.id, m, expired, body)],
        ] as const) {
          const res = await h(r);
          expect({ route: rel, method: m, label, status: res.status }).toEqual({ route: rel, method: m, label, status: 401 });
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(5 * 12);
    // Nothing changed for the user.
    expect(await resolveIdentity(userReq("/", "GET", user.device))).not.toBeNull();
    expect(await tierOf(user.id)).toBe("free");
  });
  it("a passkey login of an account not on the allowlist gets no admin cookie", async () => {
    const other = new SoftAuthenticator();
    await createAccount(other);
    const r = await adminLogin(other);
    expect(r.status).toBe(403);
    expect(r.headers.get("set-cookie")).toBeNull();
  });
  it("removing an id from ADMIN_ACCOUNT_IDS revokes its admin session at once", async () => {
    expect((await accountsGET(req("/a", "GET", admin))).status).toBe(200);
    vi.stubEnv("ADMIN_ACCOUNT_IDS", "someone_else_123");
    expect((await accountsGET(req("/a", "GET", admin))).status).toBe(401);
  });
  it("the admin cookie is HttpOnly, SameSite=Strict and short-lived", async () => {
    const r = await adminLogin(adminAuth);
    const c = r.headers.get("set-cookie")!;
    expect(c).toMatch(/HttpOnly/); expect(c).toMatch(/SameSite=Strict/);
    expect(Number(/Max-Age=(\d+)/.exec(c)![1])).toBeLessThanOrEqual(8 * 3600);
  });
  it("every write needs a fresh passkey step-up, used once", async () => {
    const user = await createAccount(new SoftAuthenticator());
    const set = () => entitlementPOST(req("/e", "POST", admin, { id: user.id, tier: "pro" }));
    const r = await set();
    expect(r.status).toBe(403);
    expect((await r.json()).error.code).toBe("step_up_required");
    await stepUp(adminAuth, admin);
    expect((await set()).status).toBe(200);
    expect((await set()).status).toBe(403);
  });
  it("a malformed admin cookie is a 401, not a crash", async () => {
    const r = await accountsGET(new Request(`${ORIGIN}/a`, { headers: { Cookie: `${ADMIN_COOKIE}=%E0%A4%A` } }));
    expect(r.status).toBe(401);
  });
  it("writes from another origin are refused", async () => {
    await stepUp(adminAuth, admin);
    const r = await invitesPOST(new Request(`${ORIGIN}/i`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example", Cookie: `${ADMIN_COOKIE}=${encodeURIComponent(admin)}` }, body: "{}" }));
    expect(r.status).toBe(403);
    const ok = await invitesPOST(new Request(`${ORIGIN}/i`, { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: `${ADMIN_COOKIE}=${encodeURIComponent(admin)}` }, body: "{}" }));
    expect(ok.status).toBe(200);
  });
  it("an admin account cannot be deleted from the panel", async () => {
    await stepUp(adminAuth, admin);
    expect((await accountDELETE(req("/a", "DELETE", admin, { id: adminId }))).status).toBe(409);
    expect(await st.accounts.sessionExists(adminId)).toBe(true);
  });
  it("an admin step-up cannot be confirmed with another account's passkey (stolen admin cookie)", async () => {
    const attackerAuth = new SoftAuthenticator();
    const attacker = await createAccount(attackerAuth);
    // 1. Admin step-up challenge signed with the attacker's own passkey.
    const o = await (await adminStepUpOptions(req("/s", "POST", admin, {}))).json();
    expect(o.allowCredentials.length).toBeGreaterThan(0);
    expect((await adminLoginVerify(req("/a", "POST", admin, attackerAuth.get(o, ORIGIN)))).status).toBe(401);
    // 2. The attacker's own user step-up, completed on the admin endpoint.
    const uo = await (await userLoginOptions(userReq("/l", "POST", attacker.device, { stepUp: true }))).json();
    expect((await adminLoginVerify(req("/a", "POST", admin, attackerAuth.get(uo, ORIGIN)))).status).toBe(200);
    expect((await userLoginVerify(userReq("/l", "POST", attacker.device, attackerAuth.get(uo, ORIGIN)))).status).toBe(400);
    // Neither grants the admin session a write.
    expect((await invitesPOST(req("/i", "POST", admin, {}))).status).toBe(403);
  });
  it("a malformed ADMIN_KEY_KEK gives a clear 503 and the panel reports it", async () => {
    vi.stubEnv("ADMIN_KEY_KEK", "too-short");
    await stepUp(adminAuth, admin);
    const r = await keysPOST(req("/k", "POST", admin, { provider: "near", key: "test-near-provider-key" }));
    expect(r.status).toBe(503);
    expect((await keysGET(req("/k", "GET", admin)).then((x) => x.json())).kekConfigured).toBe(false);
  });
  it("after a rotation, models listed with the old key are not kept as a stale fallback", async () => {
    vi.stubEnv("NEAR_AI_API_KEY", "env-key-for-near");
    vi.stubEnv("NEAR_AI_MODEL", "");
    let ok = true;
    vi.stubGlobal("fetch", async () => (ok ? Response.json({ data: [{ id: "old-key-model" }] }) : new Response("down", { status: 503 })));
    _clearCatalog();
    expect((await getCatalog()).map((m) => m.id)).toContain("old-key-model");
    ok = false;
    await stepUp(adminAuth, admin);
    await keysPOST(req("/k", "POST", admin, { provider: "near", key: "test-near-rotated-key" }));
    expect((await getCatalog()).map((m) => m.id)).not.toContain("old-key-model");
    vi.unstubAllGlobals();
  });
  it("rotating one provider's key keeps another provider's stale models during its outage", async () => {
    vi.stubEnv("NEAR_AI_API_KEY", "env-key-for-near");
    vi.stubEnv("PHALA_API_KEY", "env-key-for-phala");
    vi.stubEnv("NEAR_AI_MODEL", ""); vi.stubEnv("PHALA_MODEL", "");
    let ok = true;
    vi.stubGlobal("fetch", async (url: string) => (ok ? Response.json({ data: [{ id: String(url).includes("phala") ? "phala-model" : "near-model" }] }) : new Response("down", { status: 503 })));
    _clearCatalog();
    expect((await getCatalog()).map((m) => m.id)).toEqual(expect.arrayContaining(["near-model", "phala-model"]));
    ok = false;
    await stepUp(adminAuth, admin);
    await keysPOST(req("/k", "POST", admin, { provider: "near", key: "test-near-rotated-key" }));
    const ids = (await getCatalog()).map((m) => m.id);
    expect(ids).toContain("phala-model");
    expect(ids).not.toContain("near-model");
    vi.unstubAllGlobals();
  });
  it("a key change refreshes the model catalog of this process at once", async () => {
    vi.stubGlobal("fetch", async () => { throw new Error("offline"); });
    vi.stubEnv("PHALA_MODEL", "phala-model-1");
    _clearCatalog();
    expect((await getCatalog()).some((m) => m.provider === "phala")).toBe(false);
    await stepUp(adminAuth, admin);
    await keysPOST(req("/k", "POST", admin, { provider: "phala", key: "test-phala-provider-key" }));
    expect((await getCatalog()).some((m) => m.provider === "phala")).toBe(true);
    vi.unstubAllGlobals();
  });
  it("admin routes are rate limited per admin", async () => {
    vi.stubEnv("PAI_LIMIT_ADMIN_PER_MIN", "3");
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await accountsGET(req("/a", "GET", admin))).status);
    expect(codes).toEqual([200, 200, 200, 429]);
  });
});

describe("admin: user base", () => {
  it("lists and searches accounts by id prefix with plan and timestamps", async () => {
    const user = await createAccount(new SoftAuthenticator());
    await setTier(user.id, "pro");
    const all = await (await accountsGET(req("/a", "GET", admin))).json();
    expect(all.accounts.map((a: Json) => a.id)).toEqual(expect.arrayContaining([adminId, user.id]));
    const hit = await (await accountsGET(req(`/a?q=${user.id.slice(0, 6)}`, "GET", admin))).json();
    expect(hit.accounts.map((a: Json) => a.id)).toContain(user.id);
    expect(hit.accounts.find((a: Json) => a.id === user.id)).toMatchObject({ tier: "pro", lastSeenOn: expect.any(String), createdAt: expect.any(Number) });
    expect((await accountsGET(req("/a?q=no%25such", "GET", admin))).status).toBe(400);
  });
  it("shows one account's entitlement, usage, passkeys and devices; 404 for unknown", async () => {
    const user = await createAccount(new SoftAuthenticator());
    const r = await accountGET(req(`/a?id=${user.id}`, "GET", admin));
    expect(r.status).toBe(200);
    const a = await r.json();
    expect(a).toMatchObject({ id: user.id, tier: "free", entitlement: null, usage: { usedToday: 0 }, passkeys: 1 });
    expect(a.devices).toHaveLength(1);
    expect(JSON.stringify(a)).not.toMatch(/publicKey/);
    expect((await accountGET(req("/a?id=nosuchaccount1", "GET", admin))).status).toBe(404);
  });
  it("revokes a device session: its token stops working", async () => {
    const user = await createAccount(new SoftAuthenticator());
    const [dev] = (await (await accountGET(req(`/a?id=${user.id}`, "GET", admin))).json()).devices;
    await stepUp(adminAuth, admin);
    expect((await deviceDELETE(req("/d", "DELETE", admin, { id: user.id, deviceId: dev.id }))).status).toBe(200);
    expect(await resolveIdentity(userReq("/", "GET", user.device))).toBeNull();
  });
  it("sets and clears a manual entitlement; clearing leaves a Stripe plan alone", async () => {
    const user = await createAccount(new SoftAuthenticator());
    await stepUp(adminAuth, admin);
    expect((await entitlementPOST(req("/e", "POST", admin, { id: user.id, tier: "max", expiresAt: Date.now() + 86_400_000 }))).status).toBe(200);
    expect(await tierOf(user.id)).toBe("max");
    await stepUp(adminAuth, admin);
    expect((await entitlementDELETE(req("/e", "DELETE", admin, { id: user.id }))).status).toBe(200);
    expect(await tierOf(user.id)).toBe("free");
    await st.accounts.upsertSubscription({ stripeSubscriptionId: "sub_c", accountId: user.id, stripeCustomerId: "cus_c", tier: "pro", status: "active", currentPeriodEnd: null });
    await st.accounts.setEntitlement(user.id, { tier: "pro", source: "stripe", expiresAt: null });
    await stepUp(adminAuth, admin);
    await entitlementDELETE(req("/e", "DELETE", admin, { id: user.id }));
    expect(await tierOf(user.id)).toBe("pro");
    await stepUp(adminAuth, admin);
    expect((await entitlementPOST(req("/e", "POST", admin, { id: user.id, tier: "gold" }))).status).toBe(400);
    await stepUp(adminAuth, admin);
    expect((await entitlementPOST(req("/e", "POST", admin, { id: "nosuchaccount1", tier: "pro" }))).status).toBe(404);
    expect(await st.accounts.sessionExists("nosuchaccount1")).toBe(false);
  });
  it("a manual override hands back to the active Stripe plan when cleared or expired", async () => {
    const user = await createAccount(new SoftAuthenticator());
    await st.accounts.upsertSubscription({ stripeSubscriptionId: "sub_t", accountId: user.id, stripeCustomerId: "cus_t", tier: "pro", status: "active", currentPeriodEnd: Date.now() + 30 * 86_400_000 });
    await st.accounts.setEntitlement(user.id, { tier: "pro", source: "stripe", expiresAt: null });
    await stepUp(adminAuth, admin);
    await entitlementPOST(req("/e", "POST", admin, { id: user.id, tier: "max", expiresAt: Date.now() + 60_000 }));
    expect(await tierOf(user.id)).toBe("max");
    expect(await tierOf(user.id, Date.now() + 120_000)).toBe("pro");
    await stepUp(adminAuth, admin);
    await entitlementPOST(req("/e", "POST", admin, { id: user.id, tier: "max" }));
    await stepUp(adminAuth, admin);
    await entitlementDELETE(req("/e", "DELETE", admin, { id: user.id }));
    expect(await tierOf(user.id)).toBe("pro");
  });
  it("the account list shows the Stripe plan again once a manual override has expired", async () => {
    const user = await createAccount(new SoftAuthenticator());
    await st.accounts.upsertSubscription({ stripeSubscriptionId: "sub_l", accountId: user.id, stripeCustomerId: "cus_l", tier: "pro", status: "active", currentPeriodEnd: Date.now() + 30 * 86_400_000 });
    await st.accounts.setEntitlement(user.id, { tier: "max", source: "manual", expiresAt: Date.now() - 1000 });
    const { accounts } = await (await accountsGET(req(`/a?q=${user.id}`, "GET", admin))).json();
    expect(accounts[0].tier).toBe("pro");
  });
  it("the account list does not show an expired plan", async () => {
    const user = await createAccount(new SoftAuthenticator());
    await st.accounts.setEntitlement(user.id, { tier: "pro", source: "manual", expiresAt: Date.now() - 1000 });
    const { accounts } = await (await accountsGET(req(`/a?q=${user.id}`, "GET", admin))).json();
    expect(accounts[0].tier).toBe("free");
  });
  it("deletes an account through the erasure path and logs only the erasure hash", async () => {
    const user = await createAccount(new SoftAuthenticator());
    await stepUp(adminAuth, admin);
    const r = await accountDELETE(req("/a", "DELETE", admin, { id: user.id }));
    expect(r.status).toBe(200);
    expect(await st.accounts.sessionExists(user.id)).toBe(false);
    expect((await st.accounts.listErasures()).map((e) => e.idHash)).toContain(erasureHash(user.id));
    const audit = await (await auditGET(req("/l", "GET", admin))).json();
    expect(audit.entries[0]).toMatchObject({ adminId, action: "delete_account", target: erasureHash(user.id) });
    expect(JSON.stringify(audit)).not.toContain(user.id);
  });
});

describe("admin: provider keys", () => {
  const SECRET = "test-near-provider-key-9f2c";
  async function addKey(provider: string, key: string) {
    await stepUp(adminAuth, admin);
    return keysPOST(req("/k", "POST", admin, { provider, key }));
  }
  it("stores the key encrypted and never returns it, only a suffix", async () => {
    const r = await addKey("near", SECRET);
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).not.toContain(SECRET);
    const list = await (await keysGET(req("/k", "GET", admin))).text();
    expect(list).not.toContain(SECRET);
    const near = (JSON.parse(list).providers as Json[]).find((p) => p.id === "near") as { keys: Json[] };
    expect(near.keys).toEqual([expect.objectContaining({ suffix: "9f2c", status: "active", lastUsedAt: null })]);
    const mem = st.accounts as MemoryAccountStore;
    const [row] = [...mem.providerKeys.values()];
    expect(Buffer.from(row.ciphertext).toString("latin1")).not.toContain(SECRET);
    const audit = await (await auditGET(req("/l", "GET", admin))).text();
    expect(audit).not.toContain(SECRET);
    expect(audit).toContain("add_key");
  });
  it("lists every provider id, so a new provider (Venice) needs no admin change", async () => {
    const list = await (await keysGET(req("/k", "GET", admin))).json();
    expect(list.providers.map((p: Json) => p.id)).toEqual(expect.arrayContaining(["near", "phala", "tinfoil", "privatemode", "redpill", "custom"]));
    expect(list.providers.map((p: Json) => p.id)).not.toContain("mock");
    expect((await addKey("mock", "x")).status).toBe(400);
    expect((await addKey("nope", "x")).status).toBe(400);
    expect((await addKey("near", "")).status).toBe(400);
  });
  it("the active DB key wins over env; without one the env key is used", async () => {
    vi.stubEnv("NEAR_AI_API_KEY", "env-key");
    expect((await liveProviders()).find((p) => p.id === "near")?.apiKey).toBe("env-key");
    await addKey("near", SECRET);
    const near = (await liveProviders()).find((p) => p.id === "near")!;
    expect(near.apiKey).toBe(SECRET);
    expect(near.keyId).toBeTruthy();
    const id = near.keyId!;
    await stepUp(adminAuth, admin);
    expect((await keysPATCH(req("/k", "PATCH", admin, { id, status: "disabled" }))).status).toBe(200);
    expect((await liveProviders()).find((p) => p.id === "near")?.apiKey).toBe("env-key");
    await stepUp(adminAuth, admin);
    expect((await keysDELETE(req("/k", "DELETE", admin, { id }))).status).toBe(200);
    const list = await (await keysGET(req("/k", "GET", admin))).json();
    expect(list.providers.find((p: Json) => p.id === "near").keys).toEqual([]);
  });
  it("Venice drops in as one more provider id: a stored key serves its vetted models", async () => {
    const list = await (await keysGET(req("/k", "GET", admin))).json();
    expect(list.providers.map((p: Json) => p.id)).toContain("venice");
    vi.stubEnv("VENICE_MODELS", "claude-sonnet-x");
    expect((await liveProviders()).find((p) => p.id === "venice")).toBeUndefined();
    await addKey("venice", "test-venice-provider-key");
    const v = (await liveProviders()).find((p) => p.id === "venice")!;
    expect(v).toMatchObject({ apiKey: "test-venice-provider-key", privacy: "anon-gateway", models: ["claude-sonnet-x"] });
    expect(v.keyId).toBeTruthy();
  });
  it("a DB key makes a provider available that has no env key", async () => {
    expect((await liveProviders()).find((p) => p.id === "phala")).toBeUndefined();
    await addKey("phala", "test-phala-provider-key");
    expect((await liveProviders()).find((p) => p.id === "phala")?.apiKey).toBe("test-phala-provider-key");
  });
  it("rotating adds a new active key and disables the old one", async () => {
    await addKey("near", "first-key-aaaa");
    await addKey("near", "second-key-bbbb");
    const keys = (await (await keysGET(req("/k", "GET", admin))).json()).providers.find((p: Json) => p.id === "near").keys as Json[];
    expect(keys.map((k) => [k.suffix, k.status])).toEqual([["bbbb", "active"], ["aaaa", "disabled"]]);
    expect((await liveProviders()).find((p) => p.id === "near")?.apiKey).toBe("second-key-bbbb");
    // Re-activating the old key disables the new one.
    await stepUp(adminAuth, admin);
    await keysPATCH(req("/k", "PATCH", admin, { id: keys[1].id, status: "active" }));
    expect((await liveProviders()).find((p) => p.id === "near")?.apiKey).toBe("first-key-aaaa");
  });
  it("without ADMIN_KEY_KEK keys cannot be added, and a stored key is not silently replaced by env", async () => {
    await addKey("near", SECRET);
    vi.stubEnv("ADMIN_KEY_KEK", "");
    vi.stubEnv("NEAR_AI_API_KEY", "env-key");
    _resetKeyCache();
    expect((await addKey("near", "another-key-1234")).status).toBe(503);
    expect((await liveProviders()).find((p) => p.id === "near")).toBeUndefined();
  });
  it("a wrong KEK fails closed too", async () => {
    await addKey("near", SECRET);
    vi.stubEnv("ADMIN_KEY_KEK", randomBytes(32).toString("base64"));
    _resetKeyCache();
    expect((await liveProviders()).find((p) => p.id === "near")).toBeUndefined();
  });
});

describe("keyvault", () => {
  const k = randomBytes(32);
  it("round-trips and binds the ciphertext to its provider and key id", () => {
    const blob = sealKey("secret-value", "near:k1", k);
    expect(openKey(blob, "near:k1", k)).toBe("secret-value");
    expect(() => openKey(blob, "phala:k1", k)).toThrow();
    const tampered = Buffer.from(blob); tampered[tampered.length - 1] ^= 1;
    expect(() => openKey(tampered, "near:k1", k)).toThrow();
    expect(() => openKey(blob, "near:k1", randomBytes(32))).toThrow();
    expect(sealKey("secret-value", "near:k1", k).equals(blob)).toBe(false);
  });
});

describe("admin: invite codes", () => {
  it("creates a code shown once, lists it without the code, and it lets one signup through", async () => {
    vi.stubEnv("INVITE_ONLY", "1");
    await stepUp(adminAuth, admin);
    const r = await invitesPOST(req("/i", "POST", admin, { maxUses: 1 }));
    expect(r.status).toBe(200);
    const { code, id } = await r.json();
    expect(code).toMatch(/^[A-Za-z0-9_-]{10,}$/);
    const list = await (await invitesGET(req("/i", "GET", admin))).text();
    expect(list).not.toContain(code);
    expect(JSON.parse(list).invites).toEqual([expect.objectContaining({ id, uses: 0, maxUses: 1, revokedAt: null })]);
    const opts = async (token: string, invite?: string) => regOptions(userReq("/r", "POST", token, { invite }));
    const a = (await createSession()).token; const b = (await createSession()).token;
    expect((await opts(a, "wrong-code")).status).toBe(403);
    // A cancelled passkey prompt and a retry spend nothing; the use is counted when the account is created.
    expect((await opts(a, code)).status).toBe(200);
    const o = await opts(a, code); expect(o.status).toBe(200);
    const obr = await opts(b, code); expect(obr.status).toBe(200);
    const ob = await obr.json();
    expect((await regVerify(userReq("/r", "POST", a, new SoftAuthenticator().create(await o.json(), ORIGIN)))).status).toBe(200);
    // b started before a finished; the last use is gone, so b cannot create an account.
    const vb = await regVerify(userReq("/r", "POST", b, new SoftAuthenticator().create(ob, ORIGIN)));
    expect(vb.status).toBe(403);
    expect(await st.accounts.listCredentials((await resolveIdentity(userReq("/", "GET", b)))!.accountId)).toEqual([]);
    expect((await opts((await createSession()).token, code)).status).toBe(403);
    // Retrying b's verify after the 403 must not slip through on a missing admission.
    const again = await regVerify(userReq("/r", "POST", b, new SoftAuthenticator().create(ob, ORIGIN)));
    expect(again.status).toBe(403);
    expect(await st.accounts.hasSignIn((await resolveIdentity(userReq("/", "GET", b)))!.accountId)).toBe(false);
  });
  it("invite-only: verify without an admission from registerOptions creates no account", async () => {
    vi.stubEnv("INVITE_ONLY", "1");
    await stepUp(adminAuth, admin);
    const { code } = await (await invitesPOST(req("/i", "POST", admin, { maxUses: 5 }))).json();
    vi.stubEnv("INVITE_ONLY", "");
    const t = (await createSession()).token;
    const o = await (await regOptions(userReq("/r", "POST", t, {}))).json();
    vi.stubEnv("INVITE_ONLY", "1");
    expect((await regVerify(userReq("/r", "POST", t, new SoftAuthenticator().create(o, ORIGIN)))).status).toBe(403);
    expect(code).toBeTruthy();
  });
  it("a failed passkey verification gives the invite use back", async () => {
    vi.stubEnv("INVITE_ONLY", "1");
    await stepUp(adminAuth, admin);
    const { code } = await (await invitesPOST(req("/i", "POST", admin, { maxUses: 1 }))).json();
    const t = (await createSession()).token;
    expect((await regOptions(userReq("/r", "POST", t, { invite: code }))).status).toBe(200);
    expect((await regVerify(userReq("/r", "POST", t, { id: "x", response: { clientDataJSON: "garbage" } }))).status).toBe(400);
    expect((await (await invitesGET(req("/i", "GET", admin))).json()).invites[0].uses).toBe(0);
    const o = await regOptions(userReq("/r", "POST", t, { invite: code }));
    expect(o.status).toBe(200);
    expect((await regVerify(userReq("/r", "POST", t, new SoftAuthenticator().create(await o.json(), ORIGIN)))).status).toBe(200);
  });
  it("revoked codes stop working; env codes keep working and show read-only", async () => {
    vi.stubEnv("INVITE_CODES", "env-code-1");
    await stepUp(adminAuth, admin);
    const { code, id } = await (await invitesPOST(req("/i", "POST", admin, { maxUses: 5 }))).json();
    await stepUp(adminAuth, admin);
    expect((await invitesDELETE(req("/i", "DELETE", admin, { id }))).status).toBe(200);
    const opts = async (invite?: string) => regOptions(userReq("/r", "POST", (await createSession()).token, { invite }));
    expect((await opts(code)).status).toBe(403);
    expect((await opts("env-code-1")).status).toBe(200);
    const list = await (await invitesGET(req("/i", "GET", admin))).json();
    expect(list.envCodes).toBe(1);
    expect(JSON.stringify(list)).not.toContain("env-code-1");
  });
});

describe("admin audit log", () => {
  it("records who did what to which target, newest first, with no secrets", async () => {
    const user = await createAccount(new SoftAuthenticator());
    await stepUp(adminAuth, admin);
    await entitlementPOST(req("/e", "POST", admin, { id: user.id, tier: "pro" }));
    const { entries } = await (await auditGET(req("/l", "GET", admin))).json();
    expect(entries[0]).toMatchObject({ adminId, action: "set_entitlement", accountId: user.id, at: expect.any(Number) });
    expect(entries.some((e: Json) => e.action === "login")).toBe(true);
    expect(Object.keys(entries[0]).sort()).toEqual(["accountId", "action", "adminId", "at", "detail", "id", "target"]);
  });
  it("account ids in the audit log are erased with the account", async () => {
    const user = await createAccount(new SoftAuthenticator());
    await stepUp(adminAuth, admin);
    await entitlementPOST(req("/e", "POST", admin, { id: user.id, tier: "pro" }));
    await st.accounts.deleteAccount(user.id);
    expect(JSON.stringify(await st.accounts.listAudit(50))).not.toContain(user.id);
  });
});
