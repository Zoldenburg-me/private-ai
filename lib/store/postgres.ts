import postgres, { type Sql, type TransactionSql } from "postgres";
import type { TierId } from "../tiers";
import type { AccountStore, AuditEntry, Device, Entitlement, EntitlementSource, InviteInfo, NewAuditEntry, PasskeyCredential, ProviderKeyInfo, ProviderKeyStatus, Subscription } from "./types";
import { dayKey, AUDIT_LOG_DAYS, ENTITLED_STATUSES, ERASURE_LEDGER_DAYS, erasureHash } from "./types";
import { migrate } from "./migrate";

const ms = (d: Date | null) => (d ? d.getTime() : null);
const date = (n: number | null) => (n == null ? null : new Date(n));
/** Erasure-ledger entry for `id`, replayed by scripts/reerase.sql after a restore. */
const ledger = (tx: TransactionSql, id: string) => tx`INSERT INTO erasures (id_hash, deleted_on) VALUES (${erasureHash(id)}, ${dayKey(Date.now())}) ON CONFLICT (id_hash) DO NOTHING`;

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

interface KeyRow { id: string; provider: string; suffix: string; status: ProviderKeyStatus; created_at: Date; disabled_at: Date | null; last_used_at: Date | null }
const toKey = (r: KeyRow): ProviderKeyInfo => ({
  id: r.id, provider: r.provider, suffix: r.suffix, status: r.status,
  createdAt: r.created_at.getTime(), disabledAt: ms(r.disabled_at), lastUsedAt: ms(r.last_used_at),
});
interface AuditRow { id: string; at: Date; admin_id: string; action: string; account_id: string | null; target: string | null; detail: string | null }
const toAudit = (r: AuditRow): AuditEntry => ({ id: Number(r.id), at: r.at.getTime(), adminId: r.admin_id, action: r.action, accountId: r.account_id, target: r.target, detail: r.detail });
interface InviteRow { id: string; max_uses: number; uses: number; created_at: Date; revoked_at: Date | null }
const toInvite = (r: InviteRow): InviteInfo => ({ id: r.id, maxUses: r.max_uses, uses: r.uses, createdAt: r.created_at.getTime(), revokedAt: ms(r.revoked_at) });

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
      await ledger(tx, id);
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
      if ((await tx`DELETE FROM passkey_credentials WHERE credential_id = ${id} AND account_id = ${accountId}`).count === 0) return false;
      await ledger(tx, id);
      return true;
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
    return sql.begin(async (tx) => {
      if ((await tx`DELETE FROM devices WHERE id = ${id} AND account_id = ${accountId}`).count === 0) return false;
      await ledger(tx, id);
      return true;
    });
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
    await sql`DELETE FROM admin_audit WHERE at < ${new Date(now - AUDIT_LOG_DAYS * 86_400_000)}`;
    // ON DELETE CASCADE removes entitlements, subscriptions and passkeys of purged accounts.
    const r = await sql`DELETE FROM sessions s WHERE s.last_seen_on < ${dayKey(cutoff)}
      AND NOT EXISTS (SELECT 1 FROM subscriptions x WHERE x.account_id = s.id AND x.status = ANY(${ENTITLED_STATUSES as unknown as string[]})
        AND (x.current_period_end IS NULL OR x.current_period_end >= ${new Date(cutoff)}))`;
    return r.count;
  }
  async listAccounts(q: { prefix: string; limit: number; offset: number }) {
    const sql = await this.db();
    // starts_with is a literal prefix match: "_" and "%" in the search are not wildcards.
    const rows = await sql<{ id: string; created_at: Date; last_seen_on: string; tier: TierId | null }[]>`
      SELECT s.id, s.created_at, to_char(s.last_seen_on, 'YYYY-MM-DD') AS last_seen_on, e.tier
      FROM sessions s LEFT JOIN entitlements e ON e.account_id = s.id AND (e.expires_at IS NULL OR e.expires_at > now())
      WHERE starts_with(s.id, ${q.prefix}) ORDER BY s.created_at DESC, s.id LIMIT ${q.limit} OFFSET ${q.offset}`;
    return rows.map((r) => ({ id: r.id, createdAt: r.created_at.getTime(), lastSeenOn: r.last_seen_on, tier: r.tier }));
  }
  async addProviderKey(k: { id: string; provider: string; ciphertext: Uint8Array; suffix: string; createdAt: number }) {
    const sql = await this.db();
    await sql.begin(async (tx) => {
      // Serialises rotations of one provider, so concurrent ones queue instead of hitting provider_keys_one_active.
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`provider_key:${k.provider}`}))`;
      await tx`UPDATE provider_keys SET status = 'disabled', disabled_at = ${new Date(k.createdAt)} WHERE provider = ${k.provider} AND status = 'active'`;
      await tx`INSERT INTO provider_keys (id, provider, ciphertext, suffix, status, created_at)
        VALUES (${k.id}, ${k.provider}, ${Buffer.from(k.ciphertext)}, ${k.suffix}, 'active', ${new Date(k.createdAt)})`;
    });
  }
  async listProviderKeys() {
    const sql = await this.db();
    return (await sql<KeyRow[]>`SELECT id, provider, suffix, status, created_at, disabled_at, last_used_at FROM provider_keys ORDER BY created_at DESC, id DESC`).map(toKey);
  }
  async activeProviderKeys() {
    const sql = await this.db();
    return (await sql<{ id: string; provider: string; ciphertext: Uint8Array }[]>`SELECT id, provider, ciphertext FROM provider_keys WHERE status = 'active'`)
      .map((r) => ({ id: r.id, provider: r.provider, ciphertext: new Uint8Array(r.ciphertext) }));
  }
  async setProviderKeyStatus(id: string, status: ProviderKeyStatus) {
    const sql = await this.db();
    return sql.begin(async (tx) => {
      const [p] = await tx<{ provider: string }[]>`SELECT provider FROM provider_keys WHERE id = ${id}`;
      if (!p) return false;
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`provider_key:${p.provider}`}))`;
      const [k] = await tx<{ provider: string; status: string }[]>`SELECT provider, status FROM provider_keys WHERE id = ${id} FOR UPDATE`;
      if (!k) return false;
      if (status === "disabled") await ledger(tx, id);
      else await tx`DELETE FROM erasures WHERE id_hash = ${erasureHash(id)}`;
      if (k.status === status) return true;
      if (status === "active") await tx`UPDATE provider_keys SET status = 'disabled', disabled_at = now() WHERE provider = ${k.provider} AND status = 'active'`;
      await tx`UPDATE provider_keys SET status = ${status}, disabled_at = ${status === "active" ? null : new Date()} WHERE id = ${id}`;
      return true;
    });
  }
  async deleteProviderKey(id: string) {
    const sql = await this.db();
    return sql.begin(async (tx) => {
      if ((await tx`DELETE FROM provider_keys WHERE id = ${id}`).count === 0) return false;
      await ledger(tx, id);
      return true;
    });
  }
  async markProviderKeyUsed(id: string, now: number) {
    const sql = await this.db();
    await sql`UPDATE provider_keys SET last_used_at = ${new Date(now)} WHERE id = ${id}`;
  }
  async addAudit(e: NewAuditEntry) {
    const sql = await this.db();
    // An account deleted meanwhile is recorded as null instead of failing the (already applied) action's entry.
    await sql`INSERT INTO admin_audit (admin_id, action, account_id, target, detail)
      VALUES (${e.adminId}, ${e.action}, (SELECT id FROM sessions WHERE id = ${e.accountId ?? null}), ${e.target ?? null}, ${e.detail ?? null})`;
  }
  async listAudit(limit: number) {
    const sql = await this.db();
    return (await sql<AuditRow[]>`SELECT * FROM admin_audit ORDER BY id DESC LIMIT ${limit}`).map(toAudit);
  }
  async addInvite(i: { id: string; codeHash: string; maxUses: number; createdAt: number }) {
    const sql = await this.db();
    await sql`INSERT INTO invite_codes (id, code_hash, max_uses, created_at) VALUES (${i.id}, ${i.codeHash}, ${i.maxUses}, ${new Date(i.createdAt)})`;
  }
  async listInvites() {
    const sql = await this.db();
    return (await sql<InviteRow[]>`SELECT id, max_uses, uses, created_at, revoked_at FROM invite_codes ORDER BY created_at DESC, id DESC`).map(toInvite);
  }
  async inviteUsable(codeHash: string) {
    const sql = await this.db();
    return (await sql`SELECT 1 FROM invite_codes WHERE code_hash = ${codeHash} AND revoked_at IS NULL AND uses < max_uses`).length > 0;
  }
  async redeemInvite(codeHash: string) {
    const sql = await this.db();
    return (await sql`UPDATE invite_codes SET uses = uses + 1 WHERE code_hash = ${codeHash} AND revoked_at IS NULL AND uses < max_uses`).count > 0;
  }
  async releaseInvite(codeHash: string) {
    const sql = await this.db();
    await sql`UPDATE invite_codes SET uses = uses - 1 WHERE code_hash = ${codeHash} AND uses > 0`;
  }
  async revokeInvite(id: string) {
    const sql = await this.db();
    return sql.begin(async (tx) => {
      if ((await tx`UPDATE invite_codes SET revoked_at = COALESCE(revoked_at, now()) WHERE id = ${id}`).count === 0) return false;
      await ledger(tx, id);
      return true;
    });
  }
  async ping() { const sql = await this.db(); await sql`SELECT 1`; }
  async close() { await this.sql.end({ timeout: 2 }); }
}
