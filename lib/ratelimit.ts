import { TIERS, type TierId } from "./tiers";
import { stores } from "./store";

/**
 * Fair-use gate. Counts only - no content. Counters live in the CounterStore (Redis in
 * production, one atomic Lua call per request; in-memory for tests/dev). Fixed one-minute
 * windows, UTC-day quotas, and an error budget of N failures per sliding window.
 */
export const ERROR_BUDGET = { failures: 20, windowMs: 30_000 };

export interface GateDecision {
  allowed: boolean; status: number; reason?: string; headers: Record<string, string>;
}

/** Incognito models count against their own daily quota, under this counter id. */
export const incognitoId = (id: string) => `${id}:incognito`;

export async function gate(id: string, tierId: TierId, contextTokens: number, now = Date.now(), incognito = false): Promise<GateDecision> {
  const t = TIERS[tierId];
  const daily = incognito ? t.incognitoDailyMessages : t.dailyMessages;
  const { counters } = await stores();
  const r = await counters.consume(incognito ? incognitoId(id) : id, { daily, perMinute: t.requestsPerMinute, budgetFailures: ERROR_BUDGET.failures, budgetWindowMs: ERROR_BUDGET.windowMs },
    contextTokens <= t.maxContextTokens, now);
  const resetMinute = Math.ceil((r.minuteStart + 60_000) / 1000);
  const headers: Record<string, string> = {
    "x-ratelimit-limit-requests": String(t.requestsPerMinute),
    "x-ratelimit-remaining-requests": String(Math.max(0, t.requestsPerMinute - r.minute)),
    "x-ratelimit-reset-requests": String(resetMinute),
    "x-usage-limit-daily": String(daily),
    "x-usage-remaining-daily": String(Math.max(0, daily - r.daily)),
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

/** Messages used today (for the usage display). */
export async function usage(id: string, tierId: TierId, now = Date.now()) {
  const used = await (await stores()).counters.usedToday(id, now);
  const limit = TIERS[tierId].dailyMessages;
  return { usedToday: used, dailyLimit: limit, remainingToday: Math.max(0, limit - used) };
}

/** Tests: fresh in-memory stores. */
export { _setStores as _reset } from "./store";
