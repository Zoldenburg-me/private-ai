import type { AccountStore, CreditBalance, AuditEntry, ConsumeLimits, ConsumeResult, CounterStore, QuotaScope, Device, Entitlement, EntitlementSource, HitResult, InviteInfo, NewAuditEntry, PasskeyCredential, ProviderKeyInfo, ProviderKeyStatus, Subscription } from "./types";
import { dailySuffix, dayKey, minuteStartOf, AUDIT_LOG_DAYS, ENTITLED_STATUSES, ERASURE_LEDGER_DAYS, erasureHash } from "./types";

/** In-memory stores for tests and local dev. Same semantics as the Postgres/Redis ones. */
export class MemoryAccountStore implements AccountStore {
  sessions = new Map<string, { createdAt: number; lastSeenOn: string }>();
  entitlements = new Map<string, Entitlement>();
  subscriptions = new Map<string, Subscription & { updatedAt: number }>();
  credentials = new Map<string, PasskeyCredential>();
  devices = new Map<string, Device>();
  erasures = new Map<string, string>();
  providerKeys = new Map<string, ProviderKeyInfo & { ciphertext: Uint8Array }>();
  audit: AuditEntry[] = [];
  invites = new Map<string, InviteInfo & { codeHash: string }>();
  credits = new Map<string, CreditBalance>();
  topups = new Map<string, string>();
  private seq = 0;

  async touchSession(id: string, now = Date.now()) {
    const s = this.sessions.get(id);
    if (s) s.lastSeenOn = dayKey(now); else this.sessions.set(id, { createdAt: now, lastSeenOn: dayKey(now) });
  }
  /** Create the row if missing without bumping last-seen (matches INSERT ... ON CONFLICT DO NOTHING). */
  private ensure(id: string) { if (!this.sessions.has(id)) this.sessions.set(id, { createdAt: Date.now(), lastSeenOn: dayKey(Date.now()) }); }
  async sessionExists(id: string) { return this.sessions.has(id); }
  async getSession(id: string) { const s = this.sessions.get(id); return s ? { ...s } : null; }
  async deleteAccount(id: string) {
    if (!this.drop(id)) return false;
    this.ledger(id);
    return true;
  }
  private ledger(id: string) { if (!this.erasures.has(erasureHash(id))) this.erasures.set(erasureHash(id), dayKey(Date.now())); }
  async listErasures() {
    return [...this.erasures].map(([idHash, deletedOn]) => ({ idHash, deletedOn })).sort((a, b) => a.deletedOn.localeCompare(b.deletedOn) || a.idHash.localeCompare(b.idHash));
  }
  /** Delete the account and everything hanging off it (ON DELETE CASCADE in Postgres). */
  private drop(id: string) {
    if (!this.sessions.delete(id)) return false;
    this.entitlements.delete(id);
    for (const [k, x] of this.subscriptions) if (x.accountId === id) this.subscriptions.delete(k);
    for (const [k, c] of this.credentials) if (c.accountId === id) this.credentials.delete(k);
    for (const [k, d] of this.devices) if (d.accountId === id) this.devices.delete(k);
    this.credits.delete(id);
    for (const [k, a] of this.topups) if (a === id) this.topups.delete(k);
    this.audit = this.audit.map((e) => (e.accountId === id ? { ...e, accountId: null } : e));
    return true;
  }
  async getCredits(id: string) { const c = this.credits.get(id); return c ? { ...c } : null; }
  async spendCredits(id: string, micros: number, month: string, allowance: number) {
    if (!this.sessions.has(id)) throw new Error("no such account"); // foreign key in Postgres
    const c = this.credits.get(id) ?? { purchased: 0, included: allowance, includedMonth: month };
    if (c.includedMonth < month) { c.included = allowance; c.includedMonth = month; } // "YYYY-MM" sorts as text; forward only
    const fromIncluded = Math.min(c.included, micros);
    c.included -= fromIncluded; c.purchased -= micros - fromIncluded;
    this.credits.set(id, c);
    return { ...c };
  }
  async addCredits(id: string, micros: number, stripeSessionId: string) {
    if (!this.sessions.has(id)) throw new Error("no such account"); // foreign key in Postgres
    if (this.topups.has(stripeSessionId)) return false;
    this.topups.set(stripeSessionId, id);
    const c = this.credits.get(id) ?? { purchased: 0, included: 0, includedMonth: "" };
    c.purchased += micros; this.credits.set(id, c);
    return true;
  }
  async getEntitlement(id: string) { return this.entitlements.get(id) ?? null; }
  async setEntitlement(id: string, e: Entitlement) { this.ensure(id); this.entitlements.set(id, { ...e }); }
  async clearEntitlement(id: string, source?: EntitlementSource) {
    const e = this.entitlements.get(id);
    if (e && (!source || e.source === source)) this.entitlements.delete(id);
  }
  async upsertSubscription(s: Subscription, opts: { onlyIfAccountExists?: boolean } = {}) {
    if (opts.onlyIfAccountExists && !this.sessions.has(s.accountId)) return;
    this.ensure(s.accountId);
    this.subscriptions.set(s.stripeSubscriptionId, { ...s, updatedAt: ++this.seq });
  }
  async getSubscription(id: string) {
    const s = this.subscriptions.get(id); if (!s) return null;
    const { updatedAt: _u, ...rest } = s; return rest;
  }
  async latestSubscriptionFor(accountId: string) {
    const all = [...this.subscriptions.values()].filter((s) => s.accountId === accountId).sort((a, b) => b.updatedAt - a.updatedAt);
    if (!all[0]) return null;
    const { updatedAt: _u, ...rest } = all[0]; return rest;
  }
  async listSubscriptionsFor(accountId: string) {
    return [...this.subscriptions.values()].filter((s) => s.accountId === accountId).sort((a, b) => b.updatedAt - a.updatedAt)
      .map(({ updatedAt: _u, ...rest }) => rest);
  }
  async addCredential(c: PasskeyCredential) {
    if (this.credentials.has(c.credentialId)) throw new Error("credential exists");
    this.ensure(c.accountId);
    this.credentials.set(c.credentialId, { ...c, transports: [...c.transports] });
  }
  async getCredential(id: string) { const c = this.credentials.get(id); return c ? { ...c } : null; }
  async listCredentials(accountId: string) { return [...this.credentials.values()].filter((c) => c.accountId === accountId); }
  async updateCredentialCounter(id: string, counter: number) { const c = this.credentials.get(id); if (c) c.counter = counter; }
  async deleteCredential(accountId: string, id: string) {
    if (this.credentials.get(id)?.accountId !== accountId) return false;
    // No await between the count and the delete, so concurrent removals cannot both pass.
    if ([...this.credentials.values()].filter((c) => c.accountId === accountId).length <= 1) return false;
    this.credentials.delete(id);
    this.ledger(id);
    return true;
  }
  async addDevice(d: { id: string; accountId: string; createdAt: number }) {
    if (this.devices.has(d.id)) throw new Error("device exists");
    this.ensure(d.accountId);
    this.devices.set(d.id, { ...d, lastSeenOn: dayKey(d.createdAt) });
  }
  async touchDevice(accountId: string, id: string, now = Date.now()) {
    const d = this.devices.get(id);
    if (d?.accountId !== accountId) return false;
    if (d.lastSeenOn < dayKey(now)) this.devices.set(id, { ...d, lastSeenOn: dayKey(now) });
    return true;
  }
  async listDevices(accountId: string) { return [...this.devices.values()].filter((d) => d.accountId === accountId).map((d) => ({ ...d })); }
  async deleteDevice(accountId: string, id: string) {
    if (this.devices.get(id)?.accountId !== accountId) return false;
    this.devices.delete(id);
    this.ledger(id);
    return true;
  }
  async hasSignIn(accountId: string) {
    return [...this.credentials.values(), ...this.devices.values()].some((x) => x.accountId === accountId);
  }
  async purgeInactive(cutoff: number, now = Date.now()) {
    const keepFrom = dayKey(now - ERASURE_LEDGER_DAYS * 86_400_000);
    for (const [h, d] of this.erasures) if (d < keepFrom) this.erasures.delete(h);
    this.audit = this.audit.filter((e) => e.at >= now - AUDIT_LOG_DAYS * 86_400_000);
    const day = dayKey(cutoff); let n = 0;
    for (const [id, s] of this.sessions) {
      if (s.lastSeenOn >= day) continue;
      if ([...this.subscriptions.values()].some((x) => x.accountId === id && (ENTITLED_STATUSES as readonly string[]).includes(x.status)
        && (x.currentPeriodEnd == null || x.currentPeriodEnd >= cutoff))) continue;
      if ((this.credits.get(id)?.purchased ?? 0) > 0) continue; // bought credits keep the account
      this.drop(id); n++;
    }
    return n;
  }
  async listAccounts(q: { prefix: string; limit: number; offset: number }) {
    return [...this.sessions].filter(([id]) => id.startsWith(q.prefix))
      .sort(([a, x], [b, y]) => y.createdAt - x.createdAt || a.localeCompare(b))
      .slice(q.offset, q.offset + q.limit)
      .map(([id, x]) => {
        const e = this.entitlements.get(id);
        return { id, createdAt: x.createdAt, lastSeenOn: x.lastSeenOn, tier: e && (e.expiresAt == null || e.expiresAt > Date.now()) ? e.tier : null };
      });
  }
  private disableActive(provider: string, now: number) {
    for (const [id, k] of this.providerKeys) if (k.provider === provider && k.status === "active") this.providerKeys.set(id, { ...k, status: "disabled", disabledAt: now });
  }
  async addProviderKey(k: { id: string; provider: string; ciphertext: Uint8Array; suffix: string; createdAt: number }) {
    if (this.providerKeys.has(k.id)) throw new Error("key exists");
    this.disableActive(k.provider, k.createdAt);
    this.providerKeys.set(k.id, { ...k, ciphertext: new Uint8Array(k.ciphertext), status: "active", disabledAt: null, lastUsedAt: null });
  }
  async listProviderKeys(): Promise<ProviderKeyInfo[]> {
    return [...this.providerKeys.values()].sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
      .map(({ ciphertext: _c, ...k }) => k);
  }
  async activeProviderKeys() {
    return [...this.providerKeys.values()].filter((k) => k.status === "active").map((k) => ({ id: k.id, provider: k.provider, ciphertext: new Uint8Array(k.ciphertext) }));
  }
  async setProviderKeyStatus(id: string, status: ProviderKeyStatus) {
    const k = this.providerKeys.get(id); if (!k) return false;
    if (status === "disabled") this.ledger(id);
    if (k.status === status) return true;
    if (status === "active") this.disableActive(k.provider, Date.now());
    this.providerKeys.set(id, { ...k, status, disabledAt: status === "active" ? null : Date.now() });
    return true;
  }
  async deleteProviderKey(id: string) {
    if (!this.providerKeys.delete(id)) return false;
    this.ledger(id);
    return true;
  }
  async markProviderKeyUsed(id: string, now: number) { const k = this.providerKeys.get(id); if (k) this.providerKeys.set(id, { ...k, lastUsedAt: now }); }
  async addAudit(e: NewAuditEntry) {
    // Like Postgres: an account that no longer exists is recorded as null.
    const accountId = e.accountId && this.sessions.has(e.accountId) ? e.accountId : null;
    this.audit = [...this.audit, { id: ++this.seq, at: Date.now(), adminId: e.adminId, action: e.action, accountId, target: e.target ?? null, detail: e.detail ?? null }];
  }
  async listAudit(limit: number) { return [...this.audit].sort((a, b) => b.id - a.id).slice(0, limit).map((e) => ({ ...e })); }
  async addInvite(i: { id: string; codeHash: string; maxUses: number; createdAt: number }) {
    if ([...this.invites.values()].some((x) => x.codeHash === i.codeHash) || this.invites.has(i.id)) throw new Error("invite exists");
    this.invites.set(i.id, { ...i, uses: 0, revokedAt: null });
  }
  async listInvites(): Promise<InviteInfo[]> {
    return [...this.invites.values()].sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id)).map(({ codeHash: _h, ...i }) => i);
  }
  async inviteUsable(codeHash: string) {
    const i = [...this.invites.values()].find((x) => x.codeHash === codeHash);
    return !!i && i.revokedAt === null && i.uses < i.maxUses;
  }
  async redeemInvite(codeHash: string) {
    const i = [...this.invites.values()].find((x) => x.codeHash === codeHash);
    if (!i || i.revokedAt !== null || i.uses >= i.maxUses) return false;
    this.invites.set(i.id, { ...i, uses: i.uses + 1 });
    return true;
  }
  async releaseInvite(codeHash: string) {
    const i = [...this.invites.values()].find((x) => x.codeHash === codeHash);
    if (i && i.uses > 0) this.invites.set(i.id, { ...i, uses: i.uses - 1 });
  }
  async revokeInvite(id: string) {
    const i = this.invites.get(id); if (!i) return false;
    if (i.revokedAt === null) this.invites.set(id, { ...i, revokedAt: Date.now() });
    this.ledger(id);
    return true;
  }
  async ping() {}
}

export class MemoryCounterStore implements CounterStore {
  private counters = new Map<string, { value: number; expiresAt: number }>();
  private failures = new Map<string, number[]>();
  private once = new Map<string, { value: string; expiresAt: number }>();

  private get(key: string, now: number) {
    const c = this.counters.get(key);
    if (c && c.expiresAt <= now) { this.counters.delete(key); return 0; }
    return c?.value ?? 0;
  }
  private incr(key: string, ttlMs: number, now: number) {
    const v = this.get(key, now) + 1; this.counters.set(key, { value: v, expiresAt: now + ttlMs }); return v;
  }
  private recentFailures(id: string, windowMs: number, now: number) {
    const f = (this.failures.get(id) ?? []).filter((t) => now - t < windowMs);
    this.failures.set(id, f); return f;
  }

  async consume(id: string, l: ConsumeLimits, commit: boolean, now: number): Promise<ConsumeResult> {
    const minuteStart = minuteStartOf(now);
    const dk = `d:${id}${dailySuffix(now, l.scope)}`; const mk = `m:${id}:${minuteStart}`;
    const f = this.recentFailures(id, l.budgetWindowMs, now);
    const oldestFailure = f.length ? Math.min(...f) : 0;
    let daily = this.get(dk, now); let minute = this.get(mk, now);
    const res = (outcome: ConsumeResult["outcome"]): ConsumeResult => ({ outcome, daily, minute, minuteStart, oldestFailure });
    if (f.length >= l.budgetFailures) return res("budget");
    if (!commit) return res("rejected");
    if (daily >= l.daily) return res("daily");
    if (minute >= l.perMinute) return res("minute");
    daily = this.incr(dk, 2 * 86_400_000, now); minute = this.incr(mk, 120_000, now);
    return res("ok");
  }
  async recordFailure(id: string, windowMs: number, now: number) { this.recentFailures(id, windowMs, now).push(now); }
  async usedToday(id: string, now: number, scope?: QuotaScope) { return this.get(`d:${id}${dailySuffix(now, scope)}`, now); }
  async hit(bucket: string, limit: number, windowMs: number, now: number): Promise<HitResult> {
    const start = Math.floor(now / windowMs) * windowMs;
    const count = this.incr(`rl:${bucket}:${start}`, windowMs, now);
    return { allowed: count <= limit, count, resetAt: start + windowMs };
  }
  async unhit(bucket: string, windowMs: number, now: number) {
    const key = `rl:${bucket}:${Math.floor(now / windowMs) * windowMs}`; const c = this.counters.get(key);
    if (c && c.expiresAt > now && c.value > 0) c.value--;
  }
  async putOnce(key: string, value: string, ttlMs: number) { this.once.set(key, { value, expiresAt: Date.now() + ttlMs }); }
  async takeOnce(key: string) {
    const v = this.once.get(key); this.once.delete(key);
    return v && v.expiresAt > Date.now() ? v.value : null;
  }
  async ping() {}
}
