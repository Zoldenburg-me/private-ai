import Stripe from "stripe";
import { stores, ENTITLED_STATUSES } from "./store";
import type { TierId } from "./tiers";

/**
 * Stripe subscriptions. We never see card data (Stripe Checkout + Customer Portal are hosted by
 * Stripe) and we store only Stripe customer/subscription ids, tier, status and period end, keyed
 * by the opaque account id (passed as client_reference_id and subscription metadata).
 */
export type Plan = "pro" | "max";
export type Interval = "month" | "year";
const ENV_KEYS: Record<`${Plan}:${Interval}`, string> = {
  "pro:month": "STRIPE_PRICE_PRO_MONTHLY", "pro:year": "STRIPE_PRICE_PRO_YEARLY",
  "max:month": "STRIPE_PRICE_MAX_MONTHLY", "max:year": "STRIPE_PRICE_MAX_YEARLY",
};
/** Stripe retries failed renewals; keep access while it does. */
const ENTITLED = new Set<string>(ENTITLED_STATUSES);
/** Grace after period end in case a renewal webhook is late; afterwards access lapses on its own. */
export const GRACE_MS = 3 * 86_400_000;
const RANK: Record<TierId, number> = { free: 0, pro: 1, max: 2 };
const ACCOUNT_RE = /^[A-Za-z0-9_-]{10,64}$/;

type Env = Record<string, string | undefined>;
export function priceId(plan: Plan, interval: Interval, env: Env = process.env): string | null { return env[ENV_KEYS[`${plan}:${interval}`]] || null; }
export function tierForPrice(id: string | undefined | null, env: Env = process.env): TierId | null {
  if (!id) return null;
  for (const [k, v] of Object.entries(ENV_KEYS)) if (env[v] === id) return k.split(":")[0] as TierId;
  return null;
}

/** The subset of the Stripe SDK we use (lets tests inject a mock). */
export interface StripeLike {
  checkout: { sessions: { create(p: Stripe.Checkout.SessionCreateParams): Promise<{ url: string | null }> } };
  billingPortal: { sessions: { create(p: Stripe.BillingPortal.SessionCreateParams): Promise<{ url: string }> } };
  subscriptions: { retrieve(id: string): Promise<Stripe.Subscription> };
  webhooks: { constructEvent(payload: string, header: string, secret: string): Stripe.Event };
}
const g = globalThis as unknown as { __paiStripe?: StripeLike };
export function stripe(env: Env = process.env): StripeLike | null {
  if (g.__paiStripe) return g.__paiStripe;
  if (!env.STRIPE_SECRET_KEY) return null;
  return (g.__paiStripe = new Stripe(env.STRIPE_SECRET_KEY, { maxNetworkRetries: 2, telemetry: false }) as unknown as StripeLike);
}
export function _setStripe(s: StripeLike | undefined) { g.__paiStripe = s; }

export class BillingError extends Error { constructor(readonly status: number, message: string) { super(message); } }

export async function createCheckout(accountId: string, plan: Plan, interval: Interval, baseUrl: string): Promise<string> {
  const s = stripe(); if (!s) throw new BillingError(503, "payments not configured");
  const price = priceId(plan, interval); if (!price) throw new BillingError(400, "plan not available");
  const subs = await (await stores()).accounts.listSubscriptionsFor(accountId);
  if (subs.some((x) => ENTITLED.has(x.status))) throw new BillingError(409, "already subscribed; use the billing portal to change plan");
  const session = await s.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price, quantity: 1 }],
    client_reference_id: accountId,
    metadata: { pai_account: accountId },
    subscription_data: { metadata: { pai_account: accountId } },
    ...(subs[0] ? { customer: subs[0].stripeCustomerId } : {}),
    success_url: `${baseUrl}/?billing=success`,
    cancel_url: `${baseUrl}/?billing=cancelled`,
  });
  if (!session.url) throw new BillingError(502, "checkout unavailable");
  return session.url;
}

export async function createPortal(accountId: string, baseUrl: string): Promise<string> {
  const s = stripe(); if (!s) throw new BillingError(503, "payments not configured");
  const sub = await (await stores()).accounts.latestSubscriptionFor(accountId);
  if (!sub) throw new BillingError(404, "no subscription on this account");
  return (await s.billingPortal.sessions.create({ customer: sub.stripeCustomerId, return_url: `${baseUrl}/` })).url;
}

const periodEnd = (sub: Stripe.Subscription): number | null => {
  const t = sub.items?.data?.[0]?.current_period_end ?? (sub as unknown as { current_period_end?: number }).current_period_end;
  return typeof t === "number" ? t * 1000 : null;
};
const idOf = (x: string | { id: string } | null | undefined) => (typeof x === "string" ? x : x?.id ?? null);

/** Re-read the subscription from Stripe (events can arrive late or out of order), store it, recompute access. */
export async function syncSubscription(subscriptionId: string, accountHint?: string | null): Promise<string | null> {
  const s = stripe(); if (!s) throw new BillingError(503, "payments not configured");
  const { accounts } = await stores();
  const sub = await s.subscriptions.retrieve(subscriptionId);
  const known = await accounts.getSubscription(sub.id);
  const accountId = [sub.metadata?.pai_account, known?.accountId, accountHint].find((x) => typeof x === "string" && ACCOUNT_RE.test(x));
  if (!accountId) return null; // not ours (or missing reference): ignore, never guess
  const tier = tierForPrice(sub.items?.data?.[0]?.price?.id);
  const customer = idOf(sub.customer as string | { id: string });
  if (!customer) return null;
  await accounts.upsertSubscription({
    stripeSubscriptionId: sub.id, accountId, stripeCustomerId: customer,
    tier: tier ?? "free", status: sub.status, currentPeriodEnd: periodEnd(sub),
  });
  await recomputeEntitlement(accountId);
  return accountId;
}

/** Best entitled Stripe subscription wins; manual (ops) entitlements are left untouched. */
export async function recomputeEntitlement(accountId: string, now = Date.now()) {
  const { accounts } = await stores();
  const current = await accounts.getEntitlement(accountId);
  if (current?.source === "manual") return;
  const best = (await accounts.listSubscriptionsFor(accountId))
    .filter((x) => ENTITLED.has(x.status) && x.tier !== "free" && (x.currentPeriodEnd == null || x.currentPeriodEnd + GRACE_MS > now))
    .sort((a, b) => RANK[b.tier] - RANK[a.tier])[0];
  if (best) await accounts.setEntitlement(accountId, { tier: best.tier, source: "stripe", expiresAt: best.currentPeriodEnd == null ? null : best.currentPeriodEnd + GRACE_MS });
  else await accounts.clearEntitlement(accountId, "stripe");
}

/** Verify the Stripe signature over the raw body, then apply the event. Returns the event type handled. */
export async function handleWebhook(rawBody: string, signature: string | null, env: Env = process.env): Promise<{ type: string; handled: boolean }> {
  const s = stripe(env); const secret = env.STRIPE_WEBHOOK_SECRET;
  if (!s || !secret) throw new BillingError(503, "payments not configured");
  if (!signature) throw new BillingError(400, "missing signature");
  let event: Stripe.Event;
  try { event = s.webhooks.constructEvent(rawBody, signature, secret); } catch { throw new BillingError(400, "invalid signature"); }
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const cs = event.data.object as Stripe.Checkout.Session;
      const subId = idOf(cs.subscription as string | { id: string } | null);
      if (cs.mode !== "subscription" || !subId) return { type: event.type, handled: false };
      await syncSubscription(subId, cs.client_reference_id);
      return { type: event.type, handled: true };
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
    case "customer.subscription.paused":
    case "customer.subscription.resumed": {
      await syncSubscription((event.data.object as Stripe.Subscription).id);
      return { type: event.type, handled: true };
    }
    default: return { type: event.type, handled: false };
  }
}

export function appBaseUrl(req: Request, env: Env = process.env): string {
  if (env.APP_URL) return env.APP_URL.replace(/\/+$/, "");
  if (env.NODE_ENV === "production") throw new BillingError(503, "APP_URL not configured");
  return new URL(req.url).origin;
}
