import type { ModelEntry } from "./catalog";
import { isCuratedRoute } from "./routing";

export type TierId = "free" | "pro" | "max";

export interface Tier {
  id: TierId; name: string; priceEurMonth: number;
  dailyMessages: number; maxContextTokens: number; maxOutputTokens: number; requestsPerMinute: number;
  /** Separate daily quota for incognito (anonymized, non-TEE) models. */
  incognitoDailyMessages: number;
  /** Model calls per agent run (/api/agent); each one counts against the limits above. */
  agentMaxSteps: number;
}

/** PROPOSAL - not final pricing. Max "unlimited" is fair-use. */
export const TIERS: Record<TierId, Tier> = {
  free: { id: "free", name: "Free", priceEurMonth: 0, dailyMessages: 20, maxContextTokens: 8_000, maxOutputTokens: 4_096, requestsPerMinute: 5, incognitoDailyMessages: 50, agentMaxSteps: 3 },
  pro: { id: "pro", name: "Pro", priceEurMonth: 15, dailyMessages: 1_000, maxContextTokens: 128_000, maxOutputTokens: 8_192, requestsPerMinute: 30, incognitoDailyMessages: 1_000, agentMaxSteps: 8 },
  max: { id: "max", name: "Max", priceEurMonth: 49, dailyMessages: 5_000, maxContextTokens: 1_000_000, maxOutputTokens: 16_384, requestsPerMinute: 60, incognitoDailyMessages: 5_000, agentMaxSteps: 15 },
};

/** Top frontier models, by canonical (Liquid) id: paid plans only. Venice aliases map via canonicalModelId. */
export const PAID_ONLY_MODELS = new Set(["gemini-4-argon", "claude-fable-5-1", "gpt-6-astra"]);

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
