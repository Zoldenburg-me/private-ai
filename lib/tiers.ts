import type { ModelEntry } from "./catalog";
import { blendedPrice, isCuratedRoute } from "./routing";

export type TierId = "free" | "plus" | "pro" | "max";

export interface Tier {
  id: TierId; name: string; priceEurMonth: number;
  /** Daily quota for everyday Max Privacy models (TEE, blended price up to GROUP_CUTOFF_USD). */
  dailyMessages: number; maxContextTokens: number; maxOutputTokens: number; requestsPerMinute: number;
  /** Daily quota for top Max Privacy models (TEE above the cutoff, or unpriced). 0: not on this plan. */
  topDailyMessages: number;
  /** Separate daily quota for private (ZDR) and incognito (anonymized) models; credit models count here too. */
  incognitoDailyMessages: number;
  /** Frontier credit included each calendar month (euros), spent before bought credits. */
  includedCreditsEur: number;
  /** Model calls per agent run (/api/agent); each one counts against the limits above. */
  agentMaxSteps: number;
}

/** PROPOSAL - not final pricing. Paid plans differ only in limits; daily numbers are fair use. */
export const TIERS: Record<TierId, Tier> = {
  free: { id: "free", name: "Free", priceEurMonth: 0, dailyMessages: 20, topDailyMessages: 0, incognitoDailyMessages: 50, includedCreditsEur: 0, maxContextTokens: 8_000, maxOutputTokens: 4_096, requestsPerMinute: 5, agentMaxSteps: 3 },
  plus: { id: "plus", name: "Plus", priceEurMonth: 8, dailyMessages: 300, topDailyMessages: 10, incognitoDailyMessages: 300, includedCreditsEur: 1, maxContextTokens: 32_000, maxOutputTokens: 8_192, requestsPerMinute: 15, agentMaxSteps: 5 },
  pro: { id: "pro", name: "Pro", priceEurMonth: 15, dailyMessages: 1_000, topDailyMessages: 25, incognitoDailyMessages: 1_000, includedCreditsEur: 2, maxContextTokens: 128_000, maxOutputTokens: 8_192, requestsPerMinute: 30, agentMaxSteps: 8 },
  max: { id: "max", name: "Max", priceEurMonth: 49, dailyMessages: 5_000, topDailyMessages: 100, incognitoDailyMessages: 5_000, includedCreditsEur: 8, maxContextTokens: 1_000_000, maxOutputTokens: 16_384, requestsPerMinute: 60, agentMaxSteps: 15 },
};

const n = (x: number) => x.toLocaleString("en");
/** What a plan includes, for the Settings plan cards. */
export function planLines(id: TierId): string[] {
  const t = TIERS[id];
  return [
    `${n(t.dailyMessages)} Max Privacy messages a day`,
    ...(t.topDailyMessages ? [`${n(t.topDailyMessages)} top Max Privacy messages a day`] : []),
    `${n(t.incognitoDailyMessages)} private and incognito messages a day`,
    t.includedCreditsEur ? `€${t.includedCreditsEur} frontier credit a month, then pay as you go` : "Top frontier models on paid plans",
    `${t.maxContextTokens >= 1_000_000 ? `${t.maxContextTokens / 1_000_000}M` : `${t.maxContextTokens / 1000}k`} context, ${t.agentMaxSteps}-step agent`,
  ];
}

/** Paid plans, cheapest first. */
export const PAID_TIERS = ["plus", "pro", "max"] as const satisfies readonly TierId[];

/** Models above this blended price leave the everyday quotas: TEE ones go to the top quota, the rest to credits. */
export const GROUP_CUTOFF_USD = 2;

/**
 * Which quota a model uses: "tee" (everyday Max Privacy), "top" (top Max Privacy), "incognito" (cheap private
 * and anonymized), "credits" (frontier, pay as you go).
 */
export type ModelGroup = "tee" | "top" | "incognito" | "credits";
export function modelGroup(m: Pick<ModelEntry, "tee" | "price">): ModelGroup {
  // shortcut: an unpriced model (Privatemode, a Venice model no other gateway lists) counts as cheap; price them before they get busy.
  const cheap = !m.price || blendedPrice(m.price) <= GROUP_CUTOFF_USD;
  return m.tee ? (cheap ? "tee" : "top") : cheap ? "incognito" : "credits";
}

/** Top frontier models, by canonical (Liquid) id: paid plans only. Venice aliases map via canonicalModelId. */
export const PAID_ONLY_MODELS = new Set(["gemini-4-argon", "claude-fable-5-1", "gpt-6-astra"]);
/** Frontier models the landing page names: the paid-only ones plus Grok, which stays open to every plan on credits. */
export const FRONTIER_MODELS = new Set([...PAID_ONLY_MODELS, "grok-4-7"]);

/**
 * What a signed-out (anonymous) session on the free plan may use: the curated Auto line-up (an `auto:` entry or one
 * of its provider routes, which the web client sends once Auto has picked one) on TEE. Sessions are free to mint, so a
 * fixed list bounds what they can spend; any other model, frontier, paid-only and incognito ones included, needs an account.
 * The mock provider is dev/test only (MOCK_PROVIDER=1) and answers for free.
 */
export const anonAllowed = (m: Pick<ModelEntry, "privacy" | "paid" | "provider" | "id">) =>
  m.privacy === "tee" && !m.paid && (m.provider === "auto" || m.provider === "mock" || isCuratedRoute(m));

/** Output cap for those anonymous sessions, below the free plan's. */
export const ANON_MAX_OUTPUT_TOKENS = 2_048;

/** max_tokens sent upstream when the client sets none (never above the tier cap). */
export const DEFAULT_OUTPUT_TOKENS = 4_096;

/** Conservative: UTF-8 bytes / 3, so CJK and other non-Latin text is not undercounted. */
export const estimateTokens = (s: string) => Math.ceil(new TextEncoder().encode(s).length / 3);

/** Flat cost per inline image: its base64 bytes say nothing about the tokens a vision model spends on it. */
export const IMAGE_TOKENS = 1_500;
/** estimateTokens of a request body, with each image_url counted as IMAGE_TOKENS instead of its bytes. */
export function estimateBodyTokens(body: unknown): number {
  let images = 0;
  const json = JSON.stringify(body, (k, v) => {
    if (k !== "image_url") return v;
    images++;
    return undefined;
  });
  return estimateTokens(json) + images * IMAGE_TOKENS;
}
