import { TIERS, type TierId } from "./tiers";

/** In-memory fair-use gate. Counts only - no content. TODO: Redis for multi-instance. */
interface State { day: string; daily: number; minuteStart: number; minute: number; failures: number[] }
// Shared via globalThis: Next bundles routes separately; a module-level Map would give each route its own quota.
const g = globalThis as unknown as { __paiRate?: Map<string, State> };
const store = (g.__paiRate ??= new Map<string, State>());

export const ERROR_BUDGET = { failures: 20, windowMs: 30_000 };

export interface GateDecision {
  allowed: boolean; status: number; reason?: string; headers: Record<string, string>;
}

const today = (now: number) => new Date(now).toISOString().slice(0, 10);

function state(id: string, now: number): State {
  let s = store.get(id);
  if (!s || s.day !== today(now)) { s = { day: today(now), daily: 0, minuteStart: now, minute: 0, failures: s?.failures ?? [] }; store.set(id, s); }
  if (now - s.minuteStart >= 60_000) { s.minuteStart = now; s.minute = 0; }
  s.failures = s.failures.filter((t) => now - t < ERROR_BUDGET.windowMs);
  return s;
}

export function gate(id: string, tierId: TierId, contextTokens: number, now = Date.now()): GateDecision {
  const t = TIERS[tierId];
  const s = state(id, now);
  const resetMinute = Math.ceil((s.minuteStart + 60_000) / 1000);
  const headers: Record<string, string> = {
    "x-ratelimit-limit-requests": String(t.requestsPerMinute),
    "x-ratelimit-remaining-requests": String(Math.max(0, t.requestsPerMinute - s.minute)),
    "x-ratelimit-reset-requests": String(resetMinute),
    "x-usage-limit-daily": String(t.dailyMessages),
    "x-usage-remaining-daily": String(Math.max(0, t.dailyMessages - s.daily)),
    "x-tier": t.id,
  };
  if (s.failures.length >= ERROR_BUDGET.failures) {
    const oldest = Math.min(...s.failures);
    return { allowed: false, status: 429, reason: "error budget exceeded, retry later", headers: { ...headers, "retry-after": String(Math.ceil((oldest + ERROR_BUDGET.windowMs - now) / 1000)) } };
  }
  if (contextTokens > t.maxContextTokens) return { allowed: false, status: 413, reason: "context too long for tier", headers };
  if (s.daily >= t.dailyMessages) return { allowed: false, status: 429, reason: "daily limit reached", headers };
  if (s.minute >= t.requestsPerMinute) return { allowed: false, status: 429, reason: "rate limit, slow down", headers: { ...headers, "retry-after": String(resetMinute - Math.floor(now / 1000)) } };
  s.daily++; s.minute++;
  headers["x-ratelimit-remaining-requests"] = String(t.requestsPerMinute - s.minute);
  headers["x-usage-remaining-daily"] = String(t.dailyMessages - s.daily);
  return { allowed: true, status: 200, headers };
}

export function recordFailure(id: string, now = Date.now()) { state(id, now).failures.push(now); }
export function _reset() { store.clear(); }
