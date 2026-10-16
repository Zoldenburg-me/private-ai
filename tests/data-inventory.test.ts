import { describe, it, expect, beforeEach } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_INVENTORY } from "../lib/data-inventory";
import { ALLOWED } from "../lib/log";
import { _setStores } from "../lib/store";
import { purgeInactive, RETENTION_DAYS } from "../lib/retention";

const root = join(__dirname, "..");

describe("/privacy/metadata lists exactly what we store", () => {
  it("every Postgres column is listed, and nothing extra", () => {
    const cols = new Set<string>();
    for (const f of readdirSync(join(root, "migrations")).filter((x) => x.endsWith(".sql"))) {
      const sql = readFileSync(join(root, "migrations", f), "utf8").replace(/--.*$/gm, "");
      for (const m of sql.matchAll(/CREATE TABLE (\w+) \(([\s\S]*?)\n\);/g)) {
        for (const line of m[2].split("\n")) { const c = /^\s+(\w+)\s+\w/.exec(line); if (c) cols.add(`${m[1]}.${c[1]}`); }
      }
      for (const m of sql.matchAll(/ALTER TABLE (\w+) ADD COLUMN (\w+)/g)) cols.add(`${m[1]}.${m[2]}`);
    }
    const listed = new Set(DATA_INVENTORY.filter((d) => d.store === "postgres" && d.container !== "schema_migrations").map((d) => `${d.container}.${d.field}`));
    expect(cols.size).toBeGreaterThan(15);
    expect([...cols].sort()).toEqual([...listed].sort());
  });
  it("every Redis key family and every log field is listed", () => {
    const redis = DATA_INVENTORY.filter((d) => d.store === "redis").map((d) => d.container);
    const src = readFileSync(join(root, "lib/store/redis.ts"), "utf8") + readFileSync(join(root, "lib/passkey.ts"), "utf8");
    for (const kind of [...src.matchAll(/this\.k\("(\w+)"/g)].map((m) => m[1])) expect(redis.some((r) => r.startsWith(`pai:${kind}:`))).toBe(true);
    for (const once of [...src.matchAll(/`(webauthn:\w+):/g)].map((m) => m[1])) expect(redis.some((r) => r.startsWith(`pai:once:${once}:`))).toBe(true);
    const logs = DATA_INVENTORY.filter((d) => d.store === "server-log").map((d) => d.field);
    expect([...logs].sort()).toEqual([...ALLOWED].sort());
  });
  it("every entry is bilingual with a retention period", () => {
    for (const d of DATA_INVENTORY) for (const k of ["en", "de", "retentionEn", "retentionDe"] as const) expect(d[k].length).toBeGreaterThan(3);
  });
});

describe("retention purge", () => {
  beforeEach(() => { _setStores(); });
  it("deletes inactive accounts without an active subscription, keeps the rest", async () => {
    const { accounts } = _setStores();
    const now = Date.UTC(2027, 5, 1);
    const old = now - (RETENTION_DAYS + 2) * 86_400_000;
    await accounts.touchSession("old_inactive_1", old);
    await accounts.addCredential({ credentialId: "c1", accountId: "old_inactive_1", publicKey: new Uint8Array([1]), counter: 0, transports: [], createdAt: old });
    await accounts.touchSession("old_subscribed", old);
    await accounts.upsertSubscription({ stripeSubscriptionId: "sub_x", accountId: "old_subscribed", stripeCustomerId: "cus", tier: "pro", status: "active", currentPeriodEnd: null });
    await accounts.touchSession("old_subscribed", old);
    await accounts.touchSession("recent_user", now - 86_400_000);
    expect(await purgeInactive(now)).toBe(1);
    expect(await accounts.sessionExists("old_inactive_1")).toBe(false);
    expect(await accounts.getCredential("c1")).toBeNull();
    expect(await accounts.sessionExists("old_subscribed")).toBe(true);
    expect(await accounts.sessionExists("recent_user")).toBe(true);
  });
  it("signs out browsers unused for the retention period", async () => {
    const { accounts } = _setStores();
    const now = Date.UTC(2027, 5, 1);
    await accounts.touchSession("active_user_1", now);
    await accounts.addDevice({ id: "stale_device_000001", accountId: "active_user_1", createdAt: now - (RETENTION_DAYS + 2) * 86_400_000 });
    await accounts.addDevice({ id: "fresh_device_000001", accountId: "active_user_1", createdAt: now });
    expect(await purgeInactive(now)).toBe(1);
    expect((await accounts.listDevices("active_user_1")).map((d) => d.id)).toEqual(["fresh_device_000001"]);
  });
});
