import postgres, { type Sql } from "postgres";
import type { TierId } from "../tiers";
import type { AccountStore, Device, Entitlement, EntitlementSource, PasskeyCredential, Subscription } from "./types";
import { dayKey, ENTITLED_STATUSES, ERASURE_LEDGER_DAYS, erasureHash } from "./types";
import { migrate } from "./migrate";

const ms = (d: Date | null) => (d ? d.getTime() : null);
const date = (n: number | null) => (n == null ? null : new Date(n));

interface SubRow { stripe_subscription_id: string; account_id: string; stripe_customer_id: string; tier: TierId; status: string; current_period_end: Date | null }
interface CredRow { credential_id: string; account_id: string; public_key: Uint8Array; counter: string | number; transports: string[]; created_at: Date }
const toSub = (r: SubRow): Subscription => ({
  stripeSubscriptionId: r.stripe_subscription_id, accountId: r.account_id, stripeCustomerId: r.stripe_customer_id,
  tier: r.tier, status: r.status, currentPeriodEnd: ms(r.current_period_end),
});
const toCred = (r: CredRow): PasskeyCredential => ({
  credentialId: r.credential_id, accountId: r.account_id, publicKey: new Uint8Array(r.public_key),
  counter: Number(r.counter), transports: r.transports ?? [], createdAt: r.created_at.getTime(),
});

interface DeviceRow { id: string; account_id: string; created_at: Date; last_seen_on: string }
const toDevice = (r: DeviceRow): Device => ({ id: r.id, accountId: r.account_id, createdAt: r.created_at.getTime(), lastSeenOn: r.last_seen_on });

export class PgAccountStore implements AccountStore {
  private ready: Promise<void> | null = null;
  constructor(readonly sql: Sql, private autoMigrate = true) {}

  static fromUrl(url: string, autoMigrate = process.env.PAI_AUTO_MIGRATE !== "0") {
    // No query logging (`debug` off); short timeouts so an outage fails closed quickly.
    const sql = postgres(url, { max: 10, connect_timeout: 5, idle_timeout: 60, onnotice: () => {} });
    return new PgAccountStore(sql, autoMigrate);
  }

  /** Lazily run migrations once per process; retried on the next call if it failed. */
  private db(): Promise<Sql> {
    if (!this.autoMigrate) return Promise.resolve(this.sql);
    this.ready ??= migrate(this.sql).then(() => undefined, (e) => { this.ready = null; throw e; });
    return this.ready.then(() => this.sql);
  }

  async touchSession(id: string, now = Date.now()) {
    const sql = await this.db(); const day = dayKey(now);
    await sql`INSERT INTO sessions (id, last_seen_on) VALUES (${id}, ${day})
      ON CONFLICT (id) DO UPDATE SET last_seen_on = EXCLUDED.last_seen_on WHERE sessions.last_seen_on < EXCLUDED.last_seen_on`;
  }
  async sessionExists(id: string) {
    const sql = await this.db();
    return (await sql`SELECT 1 FROM sessions WHERE id = ${id}`).length > 0;
  }
  async getSession(id: string) {
    const sql = await this.db();
    const [r] = await sql<{ created_at: Date; last_seen_on: string }[]>`SELECT created_at, to_char(last_seen_on, 'YYYY-MM-DD') AS last_seen_on FROM sessions WHERE id = ${id}`;
    return r ? { createdAt: r.created_at.getTime(), lastSeenOn: r.last_seen_on } : null;
  }
  async deleteAccount(id: string) {
    const sql = await this.db();
    return sql.begin(async (tx) => {
      // ON DELETE CASCADE removes entitlements, subscriptions, passkeys and devices.
      if ((await tx`DELETE FROM sessions WHERE id = ${id}`).count === 0) return false;
      await tx`INSERT INTO erasures (id_hash, deleted_on) VALUES (${erasureHash(id)}, ${dayKey(Date.now())}) ON CONFLICT (id_hash) DO NOTHING`;
      return true;
    });
  }
  async listErasures() {
    const sql = await this.db();
    return (await sql<{ id_hash: string; deleted_on: string }[]>`SELECT id_hash, to_char(deleted_on, 'YYYY-MM-DD') AS deleted_on FROM erasures ORDER BY deleted_on, id_hash`)
      .map((r) => ({ idHash: r.id_hash, deletedOn: r.deleted_on }));
  }
  async getEntitlement(id: string): Promise<Entitlement | null> {
    const sql = await this.db();
    const [r] = await sql<{ tier: TierId; source: EntitlementSource; expires_at: Date | null }[]>`SELECT tier, source, expires_at FROM entitlements WHERE account_id = ${id}`;
    return r ? { tier: r.tier, source: r.source, expiresAt: ms(r.expires_at) } : null;
  }
  async setEntitlement(id: string, e: Entitlement) {
    const sql = await this.db();
    await sql.begin(async (tx) => {
      await tx`INSERT INTO sessions (id) VALUES (${id}) ON CONFLICT (id) DO NOTHING`;
      await tx`INSERT INTO entitlements (account_id, tier, source, expires_at) VALUES (${id}, ${e.tier}, ${e.source}, ${date(e.expiresAt)})
        ON CONFLICT (account_id) DO UPDATE SET tier = EXCLUDED.tier, source = EXCLUDED.source, expires_at = EXCLUDED.expires_at, updated_at = now()`;
    });
  }
  async clearEntitlement(id: string, source?: EntitlementSource) {
    const sql = await this.db();
    if (source) await sql`DELETE FROM entitlements WHERE account_id = ${id} AND source = ${source}`;
    else await sql`DELETE FROM entitlements WHERE account_id = ${id}`;
  }
  async upsertSubscription(s: Subscription, opts: { onlyIfAccountExists?: boolean } = {}) {
    const sql = await this.db();
    await sql.begin(async (tx) => {
      // FOR SHARE: a concurrent account deletion either finishes first (we write nothing) or waits for us.
      if (opts.onlyIfAccountExists) { if ((await tx`SELECT 1 FROM sessions WHERE id = ${s.accountId} FOR SHARE`).length === 0) return; }
      else await tx`INSERT INTO sessions (id) VALUES (${s.accountId}) ON CONFLICT (id) DO NOTHING`;
      await tx`INSERT INTO subscriptions (stripe_subscription_id, account_id, stripe_customer_id, tier, status, current_period_end)
        VALUES (${s.stripeSubscriptionId}, ${s.accountId}, ${s.stripeCustomerId}, ${s.tier}, ${s.status}, ${date(s.currentPeriodEnd)})
        ON CONFLICT (stripe_subscription_id) DO UPDATE SET account_id = EXCLUDED.account_id, stripe_customer_id = EXCLUDED.stripe_customer_id,
          tier = EXCLUDED.tier, status = EXCLUDED.status, current_period_end = EXCLUDED.current_period_end, updated_at = clock_timestamp()`;
    });
  }
  async getSubscription(id: string) {
    const sql = await this.db();
    const [r] = await sql<SubRow[]>`SELECT * FROM subscriptions WHERE stripe_subscription_id = ${id}`;
    return r ? toSub(r) : null;
  }
  async latestSubscriptionFor(accountId: string) {
    const sql = await this.db();
    const [r] = await sql<SubRow[]>`SELECT * FROM subscriptions WHERE account_id = ${accountId} ORDER BY updated_at DESC LIMIT 1`;
    return r ? toSub(r) : null;
  }
  async listSubscriptionsFor(accountId: string) {
    const sql = await this.db();
    return (await sql<SubRow[]>`SELECT * FROM subscriptions WHERE account_id = ${accountId} ORDER BY updated_at DESC`).map(toSub);
  }
  async addCredential(c: PasskeyCredential) {
    const sql = await this.db();
    await sql.begin(async (tx) => {
      await tx`INSERT INTO sessions (id) VALUES (${c.accountId}) ON CONFLICT (id) DO NOTHING`;
      await tx`INSERT INTO passkey_credentials (credential_id, account_id, public_key, counter, transports)
        VALUES (${c.credentialId}, ${c.accountId}, ${Buffer.from(c.publicKey)}, ${c.counter}, ${c.transports})`;
    });
  }
  async getCredential(id: string) {
    const sql = await this.db();
    const [r] = await sql<CredRow[]>`SELECT * FROM passkey_credentials WHERE credential_id = ${id}`;
    return r ? toCred(r) : null;
  }
  async listCredentials(accountId: string) {
    const sql = await this.db();
    return (await sql<CredRow[]>`SELECT * FROM passkey_credentials WHERE account_id = ${accountId} ORDER BY created_at`).map(toCred);
  }
  async updateCredentialCounter(id: string, counter: number) {
    const sql = await this.db();
    await sql`UPDATE passkey_credentials SET counter = ${counter} WHERE credential_id = ${id}`;
  }
  async deleteCredential(accountId: string, id: string) {
    const sql = await this.db();
    return sql.begin(async (tx) => {
      // The account row lock serialises removals, so two of them cannot both see a second passkey.
      await tx`SELECT 1 FROM sessions WHERE id = ${accountId} FOR UPDATE`;
      const [{ n }] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM passkey_credentials WHERE account_id = ${accountId}`;
      if (n <= 1) return false;
      return (await tx`DELETE FROM passkey_credentials WHERE credential_id = ${id} AND account_id = ${accountId}`).count > 0;
    });
  }
  async addDevice(d: { id: string; accountId: string; createdAt: number }) {
    const sql = await this.db();
    await sql.begin(async (tx) => {
      await tx`INSERT INTO sessions (id) VALUES (${d.accountId}) ON CONFLICT (id) DO NOTHING`;
      await tx`INSERT INTO devices (id, account_id, created_at, last_seen_on) VALUES (${d.id}, ${d.accountId}, ${new Date(d.createdAt)}, ${dayKey(d.createdAt)})`;
    });
  }
  async touchDevice(accountId: string, id: string, now = Date.now()) {
    const sql = await this.db(); const day = dayKey(now);
    const [r] = await sql<{ last_seen_on: string }[]>`SELECT to_char(last_seen_on, 'YYYY-MM-DD') AS last_seen_on FROM devices WHERE id = ${id} AND account_id = ${accountId}`;
    if (!r) return false;
    // At most one write per device and day.
    if (r.last_seen_on < day) await sql`UPDATE devices SET last_seen_on = ${day} WHERE id = ${id} AND last_seen_on < ${day}`;
    return true;
  }
  async listDevices(accountId: string) {
    const sql = await this.db();
    return (await sql<DeviceRow[]>`SELECT id, account_id, created_at, to_char(last_seen_on, 'YYYY-MM-DD') AS last_seen_on FROM devices WHERE account_id = ${accountId} ORDER BY created_at`).map(toDevice);
  }
  async deleteDevice(accountId: string, id: string) {
    const sql = await this.db();
    return (await sql`DELETE FROM devices WHERE id = ${id} AND account_id = ${accountId}`).count > 0;
  }
  async hasSignIn(accountId: string) {
    const sql = await this.db();
    const [r] = await sql<{ x: boolean }[]>`SELECT EXISTS (SELECT 1 FROM passkey_credentials WHERE account_id = ${accountId})
      OR EXISTS (SELECT 1 FROM devices WHERE account_id = ${accountId}) AS x`;
    return r.x;
  }
  async purgeInactive(cutoff: number, now = Date.now()) {
    const sql = await this.db();
    await sql`DELETE FROM erasures WHERE deleted_on < ${dayKey(now - ERASURE_LEDGER_DAYS * 86_400_000)}`;
    // ON DELETE CASCADE removes entitlements, subscriptions and passkeys of purged accounts.
    const r = await sql`DELETE FROM sessions s WHERE s.last_seen_on < ${dayKey(cutoff)}
      AND NOT EXISTS (SELECT 1 FROM subscriptions x WHERE x.account_id = s.id AND x.status = ANY(${ENTITLED_STATUSES as unknown as string[]})
        AND (x.current_period_end IS NULL OR x.current_period_end >= ${new Date(cutoff)}))`;
    return r.count;
  }
  async ping() { const sql = await this.db(); await sql`SELECT 1`; }
  async close() { await this.sql.end({ timeout: 2 }); }
}
