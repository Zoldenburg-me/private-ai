export type TierId = "free" | "pro" | "max";

export interface Tier {
  id: TierId; name: string; priceEurMonth: number;
  dailyMessages: number; maxContextTokens: number; requestsPerMinute: number;
}

/** PROPOSAL - not final pricing. Max "unlimited" is fair-use. */
export const TIERS: Record<TierId, Tier> = {
  free: { id: "free", name: "Free", priceEurMonth: 0, dailyMessages: 20, maxContextTokens: 8_000, requestsPerMinute: 5 },
  pro: { id: "pro", name: "Pro", priceEurMonth: 15, dailyMessages: 1_000, maxContextTokens: 128_000, requestsPerMinute: 30 },
  max: { id: "max", name: "Max", priceEurMonth: 49, dailyMessages: 5_000, maxContextTokens: 1_000_000, requestsPerMinute: 60 },
};

export const estimateTokens = (s: string) => Math.ceil(s.length / 4);
