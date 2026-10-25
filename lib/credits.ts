import type { ModelEntry } from "./catalog";
import { canonicalModelId } from "./provider-models";
import { stores } from "./store";
import { monthKey } from "./store/types";
import { TIERS, type TierId } from "./tiers";

/**
 * Frontier credits (pay as you go). Balances are micro-euros; a call costs the provider's USD list price for its
 * tokens, in euros, times CREDIT_MARKUP. The markup covers 19% VAT and Stripe fees and leaves about 25% margin.
 */
// shortcut: fixed rate, move to env or a daily feed once EUR/USD drifts more than 5% from it.
export const USD_EUR = 0.92;
export const CREDIT_MARKUP = 1.6;
export const MICROS_PER_EUR = 1_000_000;
/** Top-up sizes in euros (a Stripe price of €1 times this quantity). */
export const TOPUP_EUR = [10, 25, 50] as const;

const priceKey = (id: string) => (canonicalModelId(id).split("/").pop() ?? "").toLowerCase().replace(/[._]/g, "-");
/** The model's own list price, else the same model's price at another gateway in the catalog (Venice lists none). */
export function priceFor(catalog: ModelEntry[], m: Pick<ModelEntry, "id" | "price">): ModelEntry["price"] {
  if (m.price) return m.price;
  const k = priceKey(m.id);
  return catalog.find((x) => x.price && priceKey(x.id) === k)?.price;
}

/** Micro-euros a call costs: USD per 1M tokens times tokens is micro-USD, then the rate and markup. */
export const costMicros = (p: { in: number; out: number }, inTokens: number, outTokens: number) =>
  Math.ceil((inTokens * p.in + outTokens * p.out) * USD_EUR * CREDIT_MARKUP);

const allowanceOf = (tier: TierId) => TIERS[tier].includedCreditsEur * MICROS_PER_EUR;

/** Spendable micro-euros: this month's included credit (the full allowance if the stored month is over) plus bought credit. */
export async function creditsAvailable(accountId: string, tier: TierId, now = Date.now()) {
  const c = await (await stores()).accounts.getCredits(accountId);
  const included = c && c.includedMonth === monthKey(now) ? c.included : allowanceOf(tier);
  const purchased = c?.purchased ?? 0;
  return { included, purchased, total: included + purchased };
}

export async function chargeCredits(accountId: string, tier: TierId, micros: number, now = Date.now()): Promise<void> {
  if (micros > 0) await (await stores()).accounts.spendCredits(accountId, micros, monthKey(now), allowanceOf(tier));
}

/**
 * Token counts of the last OpenAI-style `usage` object in raw response text, or null. Model text cannot fake one:
 * inside a JSON string every quote is escaped, so `"prompt_tokens":` never matches there.
 */
export function usageIn(text: string): { prompt: number; completion: number } | null {
  const p = [...text.matchAll(/"prompt_tokens"\s*:\s*(\d+)/g)].pop();
  const c = [...text.matchAll(/"completion_tokens"\s*:\s*(\d+)/g)].pop();
  return p && c ? { prompt: Number(p[1]), completion: Number(c[1]) } : null;
}
