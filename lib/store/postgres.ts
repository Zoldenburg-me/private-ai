import postgres, { type Sql } from "postgres";
import type { TierId } from "../tiers";
import type { AccountStore, Entitlement, EntitlementSource, PasskeyCredential, Subscription } from "./types";
import { dayKey } from "./types";
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
  async upsertSubscription(s: Subscription) {
    const sql = await this.db();
    await sql.begin(async (tx) => {
      await tx`INSERT INTO sessions (id) VALUES (${s.accountId}) ON CONFLICT (id) DO NOTHING`;
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
  async ping() { const sql = await this.db(); await sql`SELECT 1`; }
  async close() { await this.sql.end({ timeout: 2 }); }
}
