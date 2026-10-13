export type TierId = "free" | "pro" | "max";

export interface Tier { id: TierId; name: string; priceEurMonth: number; dailyMessages: number; maxContextTokens: number; models: "basic" | "all" }

/** PROPOSAL placeholders - not final pricing. */
export const TIERS: Record<TierId, Tier> = {
  free: { id: "free", name: "Free", priceEurMonth: 0, dailyMessages: 20, maxContextTokens: 8_000, models: "basic" },
  pro: { id: "pro", name: "Pro", priceEurMonth: 15, dailyMessages: 1_000, maxContextTokens: 128_000, models: "all" },
  max: { id: "max", name: "Max", priceEurMonth: 49, dailyMessages: Number.POSITIVE_INFINITY, maxContextTokens: 1_000_000, models: "all" },
};

export interface GateResult { allowed: boolean; reason?: string; remaining: number }

/** Stub usage gate. Counting is per anonymous token, no content stored. TODO: persist counters + real entitlements (payments). */
export function checkGate(tier: TierId, usedToday: number, contextTokens: number): GateResult {
  const t = TIERS[tier];
  if (!t) return { allowed: false, reason: "unknown tier", remaining: 0 };
  if (contextTokens > t.maxContextTokens) return { allowed: false, reason: "context too long for tier", remaining: Math.max(0, t.dailyMessages - usedToday) };
  if (usedToday >= t.dailyMessages) return { allowed: false, reason: "daily limit reached", remaining: 0 };
  return { allowed: true, remaining: t.dailyMessages - usedToday - 1 };
}

/** Rough token estimate (~4 chars/token). */
export const estimateTokens = (s: string) => Math.ceil(s.length / 4);
