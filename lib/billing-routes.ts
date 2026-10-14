import { appBaseUrl, BillingError, createCheckout, createPortal, handleWebhook, priceId, stripe, type Interval, type Plan } from "./billing";
import { identityFrom } from "./session";
import { stores, withStores } from "./store";
import { metaLogger } from "./log";

/** HTTP glue for app/api/billing/*. */
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const fail = (status: number, message: string) => json({ error: { message } }, status);
const billing = (fn: (req: Request) => Promise<Response>) => withStores(async (req: Request) => {
  try { return await fn(req); } catch (e) { if (e instanceof BillingError) return fail(e.status, e.message); throw e; }
});

export const billingStatus = billing(async (req) => {
  const id = identityFrom(req); if (!id) return fail(401, "missing or invalid session token");
  const sub = await (await stores()).accounts.latestSubscriptionFor(id);
  const plans = (["pro", "max"] as Plan[]).flatMap((plan) => (["month", "year"] as Interval[]).map((interval) => ({ plan, interval, available: !!priceId(plan, interval) })));
  return json({
    configured: !!stripe(), plans,
    subscription: sub ? { tier: sub.tier, status: sub.status, currentPeriodEnd: sub.currentPeriodEnd } : null,
  });
});

export const checkout = billing(async (req) => {
  const id = identityFrom(req); if (!id) return fail(401, "missing or invalid session token");
  const b = (await req.json().catch(() => null)) as { plan?: unknown; interval?: unknown } | null;
  const plan = b?.plan; const interval = b?.interval ?? "month";
  if ((plan !== "pro" && plan !== "max") || (interval !== "month" && interval !== "year")) return fail(400, "plan must be pro|max, interval month|year");
  return json({ url: await createCheckout(id, plan, interval, appBaseUrl(req)) });
});

export const portal = billing(async (req) => {
  const id = identityFrom(req); if (!id) return fail(401, "missing or invalid session token");
  return json({ url: await createPortal(id, appBaseUrl(req)) });
});

export const webhook = billing(async (req) => {
  const raw = await req.text(); // signature is over the exact raw bytes
  const r = await handleWebhook(raw, req.headers.get("stripe-signature"));
  metaLogger({ route: "/api/billing/webhook", event: `stripe:${r.type}`.slice(0, 60), status: 200 });
  return json({ received: true, handled: r.handled });
});
