import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import postgres from "postgres";
import { MemoryAccountStore } from "../lib/store/memory";
import { PgAccountStore } from "../lib/store/postgres";
import { migrate } from "../lib/store/migrate";
import { createStores, _setStores, type AccountStore } from "../lib/store";
import { createSession, issueToken, issueTokenFor, setTier, tierOf, verifyToken } from "../lib/session";
import { handleChat } from "../lib/handler";
import { GET as sessionGET } from "../app/api/session/route";

// Contract tests: memory always; Postgres when TEST_DATABASE_URL is set (CI / docker-compose).
const pgUrl = process.env.TEST_DATABASE_URL;
const pg = pgUrl ? new PgAccountStore(postgres(pgUrl, { max: 2, onnotice: () => {} }), false) : null;
const backends: [string, () => Promise<AccountStore>][] = [["memory", async () => new MemoryAccountStore()]];
if (pg) backends.push(["postgres", async () => {
  await pg.sql.unsafe("DROP TABLE IF EXISTS passkey_credentials, subscriptions, entitlements, sessions, schema_migrations CASCADE");
  await migrate(pg.sql); return pg;
}]);
afterAll(async () => { await pg?.close(); });

describe.each(backends)("account store contract (%s)", (_name, make) => {
  let s: AccountStore;
  beforeEach(async () => { s = await make(); });

  it("sessions: touch creates, exists", async () => {
    expect(await s.sessionExists("acct_aaaaaaaaaa")).toBe(false);
    await s.touchSession("acct_aaaaaaaaaa"); await s.touchSession("acct_aaaaaaaaaa");
    expect(await s.sessionExists("acct_aaaaaaaaaa")).toBe(true);
  });
  it("entitlements: set, overwrite, clear by source", async () => {
    await s.setEntitlement("acct_b", { tier: "pro", source: "stripe", expiresAt: null });
    expect(await s.getEntitlement("acct_b")).toEqual({ tier: "pro", source: "stripe", expiresAt: null });
    await s.setEntitlement("acct_b", { tier: "max", source: "stripe", expiresAt: 4_102_444_800_000 });
    expect((await s.getEntitlement("acct_b"))?.tier).toBe("max");
    await s.clearEntitlement("acct_b", "manual");
    expect(await s.getEntitlement("acct_b")).not.toBeNull();
    await s.clearEntitlement("acct_b", "stripe");
    expect(await s.getEntitlement("acct_b")).toBeNull();
  });
  it("subscriptions: upsert and latest per account", async () => {
    const base = { accountId: "acct_c", stripeCustomerId: "cus_1", tier: "pro" as const, status: "active", currentPeriodEnd: 4_102_444_800_000 };
    await s.upsertSubscription({ ...base, stripeSubscriptionId: "sub_1" });
    await s.upsertSubscription({ ...base, stripeSubscriptionId: "sub_2", tier: "max" });
    expect((await s.latestSubscriptionFor("acct_c"))?.stripeSubscriptionId).toBe("sub_2");
    await s.upsertSubscription({ ...base, stripeSubscriptionId: "sub_1", status: "canceled" });
    expect(await s.getSubscription("sub_1")).toMatchObject({ status: "canceled", stripeCustomerId: "cus_1" });
    expect((await s.latestSubscriptionFor("acct_c"))?.stripeSubscriptionId).toBe("sub_1");
    expect((await s.listSubscriptionsFor("acct_c")).map((x) => x.stripeSubscriptionId)).toEqual(["sub_1", "sub_2"]);
  });
  it("purgeInactive removes old accounts (cascading) unless subscribed", async () => {
    const old = Date.UTC(2020, 0, 1);
    await s.touchSession("acct_old_1", old); await s.touchSession("acct_old_2", old);
    await s.setEntitlement("acct_old_1", { tier: "pro", source: "manual", expiresAt: null });
    await s.upsertSubscription({ stripeSubscriptionId: "sub_keep", accountId: "acct_old_2", stripeCustomerId: "cus", tier: "pro", status: "active", currentPeriodEnd: null });
    expect(await s.purgeInactive(Date.UTC(2021, 0, 1))).toBe(1);
    expect(await s.sessionExists("acct_old_1")).toBe(false);
    expect(await s.getEntitlement("acct_old_1")).toBeNull();
    expect(await s.sessionExists("acct_old_2")).toBe(true);
  });
  it("purgeInactive ignores a stale 'active' subscription whose period ended before the cutoff", async () => {
    const old = Date.UTC(2020, 0, 1); const cutoff = Date.UTC(2021, 0, 1);
    await s.touchSession("acct_stale_1", old); await s.touchSession("acct_paid_1", old);
    // renewal webhooks were missed: still "active", but the period ended in 2020
    await s.upsertSubscription({ stripeSubscriptionId: "sub_stale", accountId: "acct_stale_1", stripeCustomerId: "cus", tier: "pro", status: "active", currentPeriodEnd: Date.UTC(2020, 1, 1) });
    // a yearly plan paid until after the cutoff is kept
    await s.upsertSubscription({ stripeSubscriptionId: "sub_paid", accountId: "acct_paid_1", stripeCustomerId: "cus", tier: "pro", status: "active", currentPeriodEnd: Date.UTC(2021, 5, 1) });
    expect(await s.purgeInactive(cutoff)).toBe(1);
    expect(await s.sessionExists("acct_stale_1")).toBe(false);
    expect(await s.sessionExists("acct_paid_1")).toBe(true);
  });
  it("getSession returns created/last-seen, null when unknown", async () => {
    expect(await s.getSession("acct_unknown_1")).toBeNull();
    await s.touchSession("acct_gs_12345", Date.UTC(2027, 0, 2, 15));
    const g = await s.getSession("acct_gs_12345");
    expect(g?.lastSeenOn).toBe("2027-01-02");
    expect(typeof g?.createdAt).toBe("number");
  });
  it("upsertSubscription with onlyIfAccountExists never recreates a deleted account", async () => {
    const sub = { stripeSubscriptionId: "sub_gone_2", accountId: "acct_gone_456", stripeCustomerId: "cus_g", tier: "pro" as const, status: "canceled", currentPeriodEnd: null };
    await s.upsertSubscription(sub, { onlyIfAccountExists: true });
    expect(await s.sessionExists("acct_gone_456")).toBe(false);
    expect(await s.getSubscription("sub_gone_2")).toBeNull();
    await s.touchSession("acct_gone_456");
    await s.upsertSubscription(sub, { onlyIfAccountExists: true });
    expect((await s.getSubscription("sub_gone_2"))?.status).toBe("canceled");
  });
  it("deleteCredential only deletes the owner's credential", async () => {
    await s.addCredential({ credentialId: "cred_del_1", accountId: "acct_owner_1", publicKey: new Uint8Array([1]), counter: 0, transports: [], createdAt: Date.now() });
    expect(await s.deleteCredential("acct_other_1", "cred_del_1")).toBe(false);
    expect(await s.getCredential("cred_del_1")).not.toBeNull();
    expect(await s.deleteCredential("acct_owner_1", "cred_del_1")).toBe(true);
    expect(await s.getCredential("cred_del_1")).toBeNull();
  });
  it("deleteAccount removes the account and everything hanging off it", async () => {
    const id = "acct_gone_123";
    await s.touchSession(id);
    await s.setEntitlement(id, { tier: "pro", source: "stripe", expiresAt: null });
    await s.upsertSubscription({ stripeSubscriptionId: "sub_gone", accountId: id, stripeCustomerId: "cus_gone", tier: "pro", status: "active", currentPeriodEnd: null });
    await s.addCredential({ credentialId: "cred_gone", accountId: id, publicKey: new Uint8Array([1]), counter: 0, transports: [], createdAt: Date.now() });
    expect(await s.deleteAccount(id)).toBe(true);
    expect(await s.sessionExists(id)).toBe(false);
    expect(await s.getEntitlement(id)).toBeNull();
    expect(await s.getSubscription("sub_gone")).toBeNull();
    expect(await s.getCredential("cred_gone")).toBeNull();
    expect(await s.deleteAccount(id)).toBe(false);
  });
  it("passkey credentials: add, get, list, counter, duplicate rejected", async () => {
    const c = { credentialId: "cred1", accountId: "acct_d", publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ["internal"], createdAt: Date.now() };
    await s.addCredential(c);
    expect(await s.getCredential("cred1")).toMatchObject({ accountId: "acct_d", counter: 0, transports: ["internal"] });
    expect(Array.from((await s.getCredential("cred1"))!.publicKey)).toEqual([1, 2, 3]);
    await s.updateCredentialCounter("cred1", 7);
    expect((await s.listCredentials("acct_d")).map((x) => x.counter)).toEqual([7]);
    await expect(s.addCredential(c)).rejects.toThrow();
  });
});

describe("session + entitlements over the store", () => {
  beforeEach(() => { _setStores(); });
  it("createSession writes nothing; the row appears on first authenticated use", async () => {
    const { id, token } = await createSession();
    expect(verifyToken(token)).toBe(id);
    expect(verifyToken(issueTokenFor(id))).toBe(id);
    const { accounts } = await (await import("../lib/store")).stores();
    expect(await accounts.sessionExists(id)).toBe(false);
    // anonymous calls (no cookie) never write a row, however many there are
    for (let i = 0; i < 5; i++) expect((await sessionGET(new Request("http://app/api/session"))).status).toBe(200);
    expect((accounts as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0);
    await sessionGET(new Request("http://app/api/session", { headers: { Cookie: `pai_session=${token}` } }));
    expect(await accounts.sessionExists(id)).toBe(true);
  });
  it("tier: store wins, expired falls back, free clears", async () => {
    const { id } = issueToken();
    expect(await tierOf(id)).toBe("free");
    vi.stubEnv("ENTITLEMENTS", JSON.stringify({ [id]: "max" }));
    expect(await tierOf(id)).toBe("max");
    await setTier(id, "free"); expect(await tierOf(id)).toBe("free"); // downgrade beats the seed
    vi.unstubAllEnvs();
    await setTier(id, "pro"); expect(await tierOf(id)).toBe("pro");
    await setTier(id, "free"); expect(await tierOf(id)).toBe("free");
    const { accounts } = _setStores();
    await accounts.setEntitlement(id, { tier: "max", source: "stripe", expiresAt: 1000 });
    expect(await tierOf(id, 999)).toBe("max");
    expect(await tierOf(id, 1001)).toBe("free");
  });
  it("/api/session reports tier and usage", async () => {
    const res = await sessionGET(new Request("http://app/api/session"));
    const body = await res.json();
    expect(body).toMatchObject({ tier: { id: "free" }, usage: { usedToday: 0, dailyLimit: 20 } });
    expect(res.headers.get("set-cookie")).toMatch(/^pai_session=pai_/);
  });
});

describe("fail closed", () => {
  const down = { DATABASE_URL: "postgres://x:y@127.0.0.1:1/none", REDIS_URL: "redis://127.0.0.1:1" };
  it("configured but unreachable backends give 503, not a memory fallback", async () => {
    const s = await createStores({ ...down, NODE_ENV: "test" });
    expect(s.kind).toEqual({ accounts: "postgres", counters: "redis" });
    _setStores(s);
    expect((await sessionGET(new Request("http://app/api/session"))).status).toBe(503);
    const { token } = issueToken();
    const res = await handleChat(new Request("http://app/x", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ model: "mock:m", messages: [] }) }), "/t",
      { catalog: async () => [], log: () => {} });
    // invalid model is rejected after recordFailure() hits the down Redis -> 503
    expect(res.status).toBe(503);
  }, 20_000);
  it("production without URLs refuses to use memory unless explicitly allowed", async () => {
    const s = await createStores({ NODE_ENV: "production" });
    expect(s.kind).toEqual({ accounts: "unconfigured", counters: "unconfigured" });
    await expect(s.accounts.ping()).rejects.toThrow(/not configured/);
    expect((await createStores({ NODE_ENV: "production", PAI_ALLOW_MEMORY_STORE: "1" })).kind.accounts).toBe("memory");
  });
});
