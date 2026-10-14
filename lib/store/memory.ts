import type { AccountStore, ConsumeLimits, ConsumeResult, CounterStore, Entitlement, EntitlementSource, PasskeyCredential, Subscription } from "./types";
import { dayKey, minuteStartOf, ENTITLED_STATUSES } from "./types";

/** In-memory stores for tests and local dev. Same semantics as the Postgres/Redis ones. */
export class MemoryAccountStore implements AccountStore {
  sessions = new Map<string, { createdAt: number; lastSeenOn: string }>();
  entitlements = new Map<string, Entitlement>();
  subscriptions = new Map<string, Subscription & { updatedAt: number }>();
  credentials = new Map<string, PasskeyCredential>();
  private seq = 0;

  async touchSession(id: string, now = Date.now()) {
    const s = this.sessions.get(id);
    if (s) s.lastSeenOn = dayKey(now); else this.sessions.set(id, { createdAt: now, lastSeenOn: dayKey(now) });
  }
  /** Create the row if missing without bumping last-seen (matches INSERT ... ON CONFLICT DO NOTHING). */
  private ensure(id: string) { if (!this.sessions.has(id)) this.sessions.set(id, { createdAt: Date.now(), lastSeenOn: dayKey(Date.now()) }); }
  async sessionExists(id: string) { return this.sessions.has(id); }
  async getEntitlement(id: string) { return this.entitlements.get(id) ?? null; }
  async setEntitlement(id: string, e: Entitlement) { this.ensure(id); this.entitlements.set(id, { ...e }); }
  async clearEntitlement(id: string, source?: EntitlementSource) {
    const e = this.entitlements.get(id);
    if (e && (!source || e.source === source)) this.entitlements.delete(id);
  }
  async upsertSubscription(s: Subscription) {
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
  async purgeInactive(cutoff: number) {
    const day = dayKey(cutoff); let n = 0;
    for (const [id, s] of this.sessions) {
      if (s.lastSeenOn >= day) continue;
      if ([...this.subscriptions.values()].some((x) => x.accountId === id && (ENTITLED_STATUSES as readonly string[]).includes(x.status))) continue;
      this.sessions.delete(id); this.entitlements.delete(id); n++;
      for (const [k, x] of this.subscriptions) if (x.accountId === id) this.subscriptions.delete(k);
      for (const [k, c] of this.credentials) if (c.accountId === id) this.credentials.delete(k);
    }
    return n;
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
    const dk = `d:${id}:${dayKey(now)}`; const mk = `m:${id}:${minuteStart}`;
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
  async usedToday(id: string, now: number) { return this.get(`d:${id}:${dayKey(now)}`, now); }
  async putOnce(key: string, value: string, ttlMs: number) { this.once.set(key, { value, expiresAt: Date.now() + ttlMs }); }
  async takeOnce(key: string) {
    const v = this.once.get(key); this.once.delete(key);
    return v && v.expiresAt > Date.now() ? v.value : null;
  }
  async ping() {}
}
