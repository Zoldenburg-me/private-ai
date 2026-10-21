import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { MemoryAccountStore } from "../lib/store/memory";
import { PgAccountStore } from "../lib/store/postgres";
import { migrate } from "../lib/store/migrate";
import { createStores, _setStores, type AccountStore } from "../lib/store";
import { ERASURE_LEDGER_DAYS } from "../lib/store/types";
import { createSession, issueDeviceToken, issueToken, issueTokenFor, setTier, tierOf, verifyToken } from "../lib/session";
import { handleChat } from "../lib/handler";
import { GET as sessionGET } from "../app/api/session/route";

// Contract tests: memory always; Postgres when TEST_DATABASE_URL is set (CI / docker-compose).
const pgUrl = process.env.TEST_DATABASE_URL;
const pg = pgUrl ? new PgAccountStore(postgres(pgUrl, { max: 2, onnotice: () => {} }), false) : null;
const backends: [string, () => Promise<AccountStore>][] = [["memory", async () => new MemoryAccountStore()]];
if (pg) backends.push(["postgres", async () => {
  await pg.sql.unsafe("DROP TABLE IF EXISTS admin_audit, provider_keys, invite_codes, erasures, devices, passkey_credentials, subscriptions, entitlements, sessions, schema_migrations CASCADE");
  await migrate(pg.sql); return pg;
}]);
afterAll(async () => { await pg?.close(); });

describe.skipIf(!pg)("postgres passkey removal lock", () => {
  beforeEach(async () => { await backends[1][1](); });
  it("deleteCredential waits on the account row lock, then re-counts", async () => {
    const cred = (credentialId: string) => ({ credentialId, accountId: "acct_lock_1", publicKey: new Uint8Array([1]), counter: 0, transports: [], createdAt: Date.now() });
    await pg!.addCredential(cred("cred_lock_1")); await pg!.addCredential(cred("cred_lock_2"));
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    let locked!: () => void; const hasLock = new Promise<void>((r) => { locked = r; });
    // A competing removal holds the lock and deletes the other passkey.
    const holder = pg!.sql.begin(async (tx) => {
      await tx`SELECT 1 FROM sessions WHERE id = 'acct_lock_1' FOR UPDATE`; locked(); await gate;
      await tx`DELETE FROM passkey_credentials WHERE credential_id = 'cred_lock_2'`;
    });
    await hasLock;
    let settled = false;
    const p = pg!.deleteCredential("acct_lock_1", "cred_lock_1").then((v) => { settled = true; return v; });
    await new Promise((r) => setTimeout(r, 150));
    expect(settled).toBe(false); // without the lock it would already have deleted
    release(); await holder;
    expect(await p).toBe(false);
    expect(await pg!.listCredentials("acct_lock_1")).toHaveLength(1);
  });
});

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
    await s.addCredential({ credentialId: "cred_del_1b", accountId: "acct_owner_1", publicKey: new Uint8Array([1]), counter: 0, transports: [], createdAt: Date.now() });
    expect(await s.deleteCredential("acct_other_1", "cred_del_1")).toBe(false);
    expect(await s.getCredential("cred_del_1")).not.toBeNull();
    expect(await s.deleteCredential("acct_owner_1", "cred_del_1")).toBe(true);
    expect(await s.getCredential("cred_del_1")).toBeNull();
  });
  it("deleteCredential never deletes an account's last passkey, even when two removals race", async () => {
    const cred = (credentialId: string) => ({ credentialId, accountId: "acct_race_1", publicKey: new Uint8Array([1]), counter: 0, transports: [], createdAt: Date.now() });
    await s.addCredential(cred("cred_race_1"));
    expect(await s.deleteCredential("acct_race_1", "cred_race_1")).toBe(false);
    await s.addCredential(cred("cred_race_2"));
    const r = await Promise.all([s.deleteCredential("acct_race_1", "cred_race_1"), s.deleteCredential("acct_race_1", "cred_race_2")]);
    expect(r.filter(Boolean)).toHaveLength(1);
    expect(await s.listCredentials("acct_race_1")).toHaveLength(1);
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
  it("deleteAccount records the sha256 of the id in the erasure ledger; the purge prunes it later", async () => {
    const hash = createHash("sha256").update("acct_erase_1").digest("hex");
    await s.touchSession("acct_erase_1");
    expect(await s.deleteAccount("acct_erase_1")).toBe(true);
    expect(await s.listErasures()).toEqual([{ idHash: hash, deletedOn: new Date().toISOString().slice(0, 10) }]);
    await s.touchSession("acct_erase_1");
    await s.deleteAccount("acct_erase_1");
    expect(await s.listErasures()).toHaveLength(1);
    const day = 86_400_000;
    await s.purgeInactive(0, Date.now() + (ERASURE_LEDGER_DAYS - 1) * day);
    expect(await s.listErasures()).toHaveLength(1);
    await s.purgeInactive(0, Date.now() + (ERASURE_LEDGER_DAYS + 1) * day);
    expect(await s.listErasures()).toEqual([]);
  });
  it("purgeInactive does not add to the erasure ledger (the purge itself re-deletes after a restore)", async () => {
    await s.touchSession("acct_purged_1", Date.UTC(2020, 0, 1));
    expect(await s.purgeInactive(Date.UTC(2021, 0, 1))).toBe(1);
    expect(await s.listErasures()).toEqual([]);
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
  it("devices: add, touch only for the owner, list, delete, cascade", async () => {
    const day1 = Date.UTC(2027, 0, 2, 9); const day2 = Date.UTC(2027, 0, 5, 9);
    await s.addDevice({ id: "dev_aaaaaaaaaaaaaaaa", accountId: "acct_dev_1", createdAt: day1 });
    await s.addDevice({ id: "dev_bbbbbbbbbbbbbbbb", accountId: "acct_dev_1", createdAt: day1 });
    expect(await s.sessionExists("acct_dev_1")).toBe(true);
    expect(await s.touchDevice("acct_other", "dev_aaaaaaaaaaaaaaaa", day2)).toBe(false);
    expect(await s.touchDevice("acct_dev_1", "dev_unknown_xxxxxxxx", day2)).toBe(false);
    expect(await s.touchDevice("acct_dev_1", "dev_aaaaaaaaaaaaaaaa", day2)).toBe(true);
    const list = await s.listDevices("acct_dev_1");
    expect(list.map((d) => d.id).sort()).toEqual(["dev_aaaaaaaaaaaaaaaa", "dev_bbbbbbbbbbbbbbbb"]);
    expect(list.find((d) => d.id === "dev_aaaaaaaaaaaaaaaa")).toMatchObject({ accountId: "acct_dev_1", lastSeenOn: "2027-01-05" });
    expect(list.find((d) => d.id === "dev_bbbbbbbbbbbbbbbb")?.lastSeenOn).toBe("2027-01-02");
    expect(Object.keys(list[0]).sort()).toEqual(["accountId", "createdAt", "id", "lastSeenOn"]);
    expect(await s.deleteDevice("acct_other", "dev_aaaaaaaaaaaaaaaa")).toBe(false);
    expect(await s.deleteDevice("acct_dev_1", "dev_aaaaaaaaaaaaaaaa")).toBe(true);
    expect(await s.touchDevice("acct_dev_1", "dev_aaaaaaaaaaaaaaaa", day2)).toBe(false);
    expect(await s.deleteAccount("acct_dev_1")).toBe(true);
    expect(await s.listDevices("acct_dev_1")).toEqual([]);
  });
  it("hasSignIn: true once the account has a passkey or a device", async () => {
    await s.touchSession("acct_si_anon");
    expect(await s.hasSignIn("acct_si_anon")).toBe(false);
    await s.addCredential({ credentialId: "cred_si", accountId: "acct_si_pk", publicKey: new Uint8Array([1]), counter: 0, transports: [], createdAt: Date.now() });
    expect(await s.hasSignIn("acct_si_pk")).toBe(true);
    await s.addDevice({ id: "dev_si_cccccccccccc", accountId: "acct_si_dev", createdAt: Date.now() });
    expect(await s.hasSignIn("acct_si_dev")).toBe(true);
  });
  it("listAccounts: newest first, id prefix search, plan, paging", async () => {
    await s.touchSession("acct_list_a1", Date.UTC(2026, 0, 1));
    await new Promise((r) => setTimeout(r, 5));
    await s.touchSession("acct_list_b2", Date.UTC(2026, 0, 2));
    await s.setEntitlement("acct_list_b2", { tier: "pro", source: "manual", expiresAt: null });
    const all = await s.listAccounts({ prefix: "acct_list_", limit: 10, offset: 0 });
    expect(all.map((a) => a.id)).toEqual(["acct_list_b2", "acct_list_a1"]);
    expect(all[0]).toMatchObject({ tier: "pro", lastSeenOn: expect.any(String), createdAt: expect.any(Number) });
    expect(all[1].tier).toBeNull();
    await s.setEntitlement("acct_list_b2", { tier: "pro", source: "manual", expiresAt: Date.UTC(2020, 0, 1) });
    expect((await s.listAccounts({ prefix: "acct_list_b", limit: 10, offset: 0 }))[0].tier).toBeNull();
    expect((await s.listAccounts({ prefix: "acct_list_a", limit: 10, offset: 0 })).map((a) => a.id)).toEqual(["acct_list_a1"]);
    // "_" is a LIKE wildcard; the search is a literal prefix.
    expect(await s.listAccounts({ prefix: "acct_list__", limit: 10, offset: 0 })).toEqual([]);
    expect((await s.listAccounts({ prefix: "acct_list_", limit: 1, offset: 1 })).map((a) => a.id)).toEqual(["acct_list_a1"]);
  });
  it("provider keys: one active per provider, status changes, used-at, delete", async () => {
    const key = (id: string, provider = "near") => ({ id, provider, ciphertext: new Uint8Array([1, 2, 3]), suffix: "abcd", createdAt: Date.now() });
    await s.addProviderKey(key("pk_1"));
    await s.addProviderKey(key("pk_2"));
    await s.addProviderKey(key("pk_3", "phala"));
    expect((await s.activeProviderKeys()).map((k) => k.id).sort()).toEqual(["pk_2", "pk_3"]);
    const listed = await s.listProviderKeys();
    expect(listed.find((k) => k.id === "pk_1")).toMatchObject({ status: "disabled", disabledAt: expect.any(Number) });
    expect(JSON.stringify(listed)).not.toContain("ciphertext");
    expect(await s.setProviderKeyStatus("pk_1", "active")).toBe(true);
    expect((await s.activeProviderKeys()).filter((k) => k.provider === "near").map((k) => k.id)).toEqual(["pk_1"]);
    expect(await s.setProviderKeyStatus("pk_nope", "active")).toBe(false);
    await s.markProviderKeyUsed("pk_1", Date.UTC(2026, 5, 1));
    expect((await s.listProviderKeys()).find((k) => k.id === "pk_1")?.lastUsedAt).toBe(Date.UTC(2026, 5, 1));
    expect(await s.deleteProviderKey("pk_1")).toBe(true);
    expect(await s.deleteProviderKey("pk_1")).toBe(false);
    expect((await s.activeProviderKeys()).map((k) => k.id)).toEqual(["pk_3"]);
  });
  it("audit log: newest first; account ids go with the account", async () => {
    await s.touchSession("acct_audit_1");
    await s.addAudit({ adminId: "admin_1", action: "login" });
    await s.addAudit({ adminId: "admin_1", action: "set_entitlement", accountId: "acct_audit_1", detail: "pro" });
    const [e] = await s.listAudit(10);
    expect(e).toMatchObject({ adminId: "admin_1", action: "set_entitlement", accountId: "acct_audit_1", target: null, detail: "pro" });
    await s.deleteAccount("acct_audit_1");
    expect((await s.listAudit(10))[0].accountId).toBeNull();
    // An account deleted before the entry is written is recorded as null, not an error.
    await s.addAudit({ adminId: "admin_1", action: "revoke_device", accountId: "acct_audit_1" });
    expect((await s.listAudit(1))[0]).toMatchObject({ action: "revoke_device", accountId: null });
  });
  it("invite codes: redeem up to max uses, revoke", async () => {
    await s.addInvite({ id: "inv_1", codeHash: "h1", maxUses: 2, createdAt: Date.now() });
    expect(await s.inviteUsable("h1")).toBe(true);
    expect(await s.redeemInvite("h1")).toBe(true);
    expect(await s.redeemInvite("h1")).toBe(true);
    expect(await s.inviteUsable("h1")).toBe(false);
    expect(await s.redeemInvite("h1")).toBe(false);
    await s.releaseInvite("h1");
    expect(await s.redeemInvite("h1")).toBe(true);
    expect(await s.redeemInvite("nope")).toBe(false);
    await new Promise((r) => setTimeout(r, 5));
    await s.addInvite({ id: "inv_2", codeHash: "h2", maxUses: 5, createdAt: Date.now() });
    expect(await s.revokeInvite("inv_2")).toBe(true);
    expect(await s.redeemInvite("h2")).toBe(false);
    expect(await s.inviteUsable("h2")).toBe(false);
    expect((await s.listInvites()).map((i) => [i.id, i.uses, i.revokedAt !== null])).toEqual([["inv_2", 0, true], ["inv_1", 2, false]]);
  });
});

describe("session + entitlements over the store", () => {
  beforeEach(() => { _setStores(); });
  it("createSession writes nothing; the row appears on first authenticated use", async () => {
    const { id, token } = await createSession();
    expect(verifyToken(token)).toBe(id);
    expect(verifyToken(issueTokenFor(id))).toBe(id);
    expect(verifyToken(issueDeviceToken(id, "dev_0123456789abcdef"))).toBe(id);
    expect(verifyToken(issueDeviceToken(id, "dev_0123456789abcdef").replace("dev_0", "dev_1"))).toBeNull();
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
    expect(body).toMatchObject({ tier: { id: "free" }, usage: { usedToday: 0, dailyLimit: 20 }, incognitoUsage: { usedToday: 0, dailyLimit: 50 } });
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

describe.skipIf(!pg)("restore: scripts/reerase.sql", () => {
  it("deletes restored accounts that are in the snapshot's or the incoming ledger, keeps the rest", async () => {
    const s = await backends[1][1]();
    const hash = (id: string) => createHash("sha256").update(id).digest("hex");
    for (const id of ["acct_rs_keep", "acct_rs_old", "acct_rs_new"]) await s.touchSession(id);
    await s.addCredential({ credentialId: "cred_rs_new", accountId: "acct_rs_new", publicKey: new Uint8Array([1]), counter: 0, transports: [], createdAt: Date.now() });
    // acct_rs_old was deleted before the snapshot (row is in its ledger); acct_rs_new after it (only in the incoming ledger).
    await pg!.sql`INSERT INTO erasures (id_hash, deleted_on) VALUES (${hash("acct_rs_old")}, '2027-01-01')`;
    await pg!.sql.begin(async (tx) => {
      await tx`CREATE TEMP TABLE incoming (id_hash text, deleted_on date) ON COMMIT DROP`;
      await tx`INSERT INTO incoming VALUES (${hash("acct_rs_new")}, '2027-02-01'), (${hash("acct_rs_new")}, '2027-02-01'), (${hash("acct_rs_old")}, '2027-01-01')`;
      await tx.unsafe(readFileSync(join(__dirname, "../scripts/reerase.sql"), "utf8"));
    });
    expect(await s.sessionExists("acct_rs_keep")).toBe(true);
    expect(await s.sessionExists("acct_rs_old")).toBe(false);
    expect(await s.sessionExists("acct_rs_new")).toBe(false);
    expect(await s.getCredential("cred_rs_new")).toBeNull();
    expect((await s.listErasures()).map((e) => e.idHash).sort()).toEqual([hash("acct_rs_new"), hash("acct_rs_old")].sort());
  });
});
