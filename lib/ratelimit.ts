import { TIERS, type TierId } from "./tiers";
import { stores } from "./store";
import type { QuotaScope } from "./store/types";

/**
 * Fair-use gate. Counts only - no content. Counters live in the CounterStore (Redis in
 * production, one atomic Lua call per request; in-memory for tests/dev). Fixed one-minute
 * windows, UTC-day quotas, and an error budget of N failures per sliding window.
 */
export const ERROR_BUDGET = { failures: 20, windowMs: 30_000 };

export interface GateDecision {
  allowed: boolean; status: number; reason?: string; headers: Record<string, string>;
}

/** The daily quota of a scope: no scope is everyday Max Privacy. */
export const dailyLimit = (tierId: TierId, scope?: QuotaScope) => {
  const t = TIERS[tierId];
  return scope === "incognito" ? t.incognitoDailyMessages : scope === "top" ? t.topDailyMessages : t.dailyMessages;
};

/** Top and incognito models have their own daily quotas; the per-minute window and error budget are shared with the account. */
export async function gate(id: string, tierId: TierId, contextTokens: number, now = Date.now(), scope?: QuotaScope): Promise<GateDecision> {
  const t = TIERS[tierId];
  const daily = dailyLimit(tierId, scope);
  const { counters } = await stores();
  const r = await counters.consume(id, { daily, perMinute: t.requestsPerMinute, budgetFailures: ERROR_BUDGET.failures, budgetWindowMs: ERROR_BUDGET.windowMs, ...(scope ? { scope } : {}) },
    contextTokens <= t.maxContextTokens, now);
  const resetMinute = Math.ceil((r.minuteStart + 60_000) / 1000);
  const headers: Record<string, string> = {
    "x-ratelimit-limit-requests": String(t.requestsPerMinute),
    "x-ratelimit-remaining-requests": String(Math.max(0, t.requestsPerMinute - r.minute)),
    "x-ratelimit-reset-requests": String(resetMinute),
    "x-usage-limit-daily": String(daily),
    "x-usage-remaining-daily": String(Math.max(0, daily - r.daily)),
    "x-usage-quota": scope ?? "standard",
    "x-tier": t.id,
  };
  switch (r.outcome) {
    case "budget":
      return { allowed: false, status: 429, reason: "error budget exceeded, retry later", headers: { ...headers, "retry-after": String(Math.max(1, Math.ceil((r.oldestFailure + ERROR_BUDGET.windowMs - now) / 1000))) } };
    case "rejected": return { allowed: false, status: 413, reason: "context too long for tier", headers };
    case "daily": return { allowed: false, status: 429, reason: "daily limit reached", headers };
    case "minute": return { allowed: false, status: 429, reason: "rate limit, slow down", headers: { ...headers, "retry-after": String(Math.max(1, resetMinute - Math.floor(now / 1000))) } };
    default: return { allowed: true, status: 200, headers };
  }
}

export async function recordFailure(id: string, now = Date.now()): Promise<void> {
  await (await stores()).counters.recordFailure(id, ERROR_BUDGET.windowMs, now);
}

/** Messages used today in a quota (for the usage display). */
export async function usage(id: string, tierId: TierId, now = Date.now(), scope?: QuotaScope) {
  const used = await (await stores()).counters.usedToday(id, now, scope);
  const limit = dailyLimit(tierId, scope);
  return { usedToday: used, dailyLimit: limit, remainingToday: Math.max(0, limit - used) };
}

/** Tests: fresh in-memory stores. */
export { _setStores as _reset } from "./store";
