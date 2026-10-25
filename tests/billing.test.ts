import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Stripe from "stripe";
import { _setStores, type Stores } from "../lib/store";
import { _setStripe, recomputeEntitlement, type StripeLike } from "../lib/billing";
import { createSession, tierOf } from "../lib/session";
import { POST as checkoutPOST } from "../app/api/billing/checkout/route";
import { POST as portalPOST } from "../app/api/billing/portal/route";
import { POST as webhookPOST } from "../app/api/billing/webhook/route";
import { GET as billingGET } from "../app/api/billing/route";

const WH_SECRET = "whsec_test_secret";
const PRICES = { STRIPE_PRICE_PRO_MONTHLY: "price_pro_m", STRIPE_PRICE_PRO_YEARLY: "price_pro_y", STRIPE_PRICE_MAX_MONTHLY: "price_max_m", STRIPE_PRICE_MAX_YEARLY: "price_max_y" };
// Real signing/verification code from the SDK; no network.
const real = new Stripe("sk_test_dummy");

let subs: Map<string, Stripe.Subscription>;
let checkoutCalls: Stripe.Checkout.SessionCreateParams[];
let checkoutKeys: (string | undefined)[];
let st: Stores;
const sub = (id: string, account: string | null, price: string, status: Stripe.Subscription.Status, periodEnd = Math.floor(Date.now() / 1000) + 30 * 86400) => {
  const s = { id, object: "subscription", customer: "cus_123", status, metadata: account ? { pai_account: account } : {},
    items: { object: "list", data: [{ price: { id: price }, current_period_end: periodEnd }] } } as unknown as Stripe.Subscription;
  subs.set(id, s); return s;
};
const mock = (): StripeLike => ({
  checkout: { sessions: { create: async (p, o) => { checkoutCalls.push(p); checkoutKeys.push(o?.idempotencyKey); return { url: "https://checkout.stripe.com/c/pay/cs_test_1" }; } } },
  billingPortal: { sessions: { create: async (p) => ({ url: `https://billing.stripe.com/p/session/${p.customer}` }) } },
  subscriptions: { retrieve: async (id) => { const s = subs.get(id); if (!s) throw new Error("no such subscription"); return s; } },
  customers: { del: async (id) => ({ id, deleted: true }) },
  webhooks: real.webhooks,
});

function signed(event: object, secret = WH_SECRET) {
  const payload = JSON.stringify(event);
  const header = real.webhooks.generateTestHeaderString({ payload, secret });
  return new Request("http://app/api/billing/webhook", { method: "POST", headers: { "stripe-signature": header, "content-type": "application/json" }, body: payload });
}
const evt = (type: string, object: object) => ({ id: `evt_${Math.random()}`, object: "event", type, data: { object } });
const authed = (path: string, token: string, body?: unknown) =>
  new Request(`http://app${path}`, { method: body === undefined ? "GET" : "POST", headers: { Cookie: `pai_session=${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

beforeEach(() => {
  st = _setStores(); subs = new Map(); checkoutCalls = []; checkoutKeys = [];
  _setStripe(mock());
  for (const [k, v] of Object.entries({ ...PRICES, STRIPE_WEBHOOK_SECRET: WH_SECRET, STRIPE_SECRET_KEY: "sk_test_dummy" })) vi.stubEnv(k, v);
});
afterEach(() => { vi.unstubAllEnvs(); _setStripe(undefined); });

describe("stripe checkout", () => {
  it("creates a subscription checkout carrying only the opaque account id", async () => {
    const { id, token } = await createSession();
    const res = await checkoutPOST(authed("/api/billing/checkout", token, { plan: "pro", interval: "year" }));
    expect(res.status).toBe(200);
    expect((await res.json()).url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    const p = checkoutCalls[0];
    expect(p).toMatchObject({ mode: "subscription", client_reference_id: id, line_items: [{ price: "price_pro_y", quantity: 1 }], subscription_data: { metadata: { pai_account: id } } });
    expect(p).not.toHaveProperty("customer_email");
  });
  it("sends the same idempotency key for repeat requests", async () => {
    const { id, token } = await createSession();
    const body = { plan: "pro", interval: "month" };
    await Promise.all([checkoutPOST(authed("/api/billing/checkout", token, body)), checkoutPOST(authed("/api/billing/checkout", token, body))]);
    expect(checkoutKeys).toHaveLength(2);
    expect(checkoutKeys[0]).toMatch(new RegExp(`^checkout:${id}:pro:month:[0-9a-f]{16}:\\d+$`));
    expect(checkoutKeys[1]).toBe(checkoutKeys[0]);
    await checkoutPOST(authed("/api/billing/checkout", token, { plan: "max", interval: "month" }));
    expect(checkoutKeys[2]).not.toBe(checkoutKeys[0]);
  });
  it("sends a different idempotency key once the request carries a customer", async () => {
    const { id, token } = await createSession();
    const body = { plan: "pro", interval: "month" };
    await checkoutPOST(authed("/api/billing/checkout", token, body));
    await st.accounts.upsertSubscription({ stripeSubscriptionId: "sub_old", accountId: id, stripeCustomerId: "cus_old", tier: "pro", status: "canceled", currentPeriodEnd: null });
    expect((await checkoutPOST(authed("/api/billing/checkout", token, body))).status).toBe(200);
    expect(checkoutCalls[1]).toMatchObject({ customer: "cus_old" });
    expect(checkoutKeys[1]).not.toBe(checkoutKeys[0]);
  });
  it("validates input, auth and configuration", async () => {
    const { token } = await createSession();
    expect((await checkoutPOST(authed("/api/billing/checkout", token, { plan: "gold" }))).status).toBe(400);
    expect((await checkoutPOST(new Request("http://app/x", { method: "POST", body: "{}" }))).status).toBe(401);
    vi.stubEnv("STRIPE_PRICE_MAX_YEARLY", "");
    expect((await checkoutPOST(authed("/api/billing/checkout", token, { plan: "max", interval: "year" }))).status).toBe(400);
    _setStripe(undefined); vi.stubEnv("STRIPE_SECRET_KEY", "");
    expect((await checkoutPOST(authed("/api/billing/checkout", token, { plan: "pro" }))).status).toBe(503);
  });
});

describe("stripe webhook", () => {
  it("checkout completed upgrades to Pro; cancellation downgrades", async () => {
    const { id, token } = await createSession();
    expect(await tierOf(id)).toBe("free");
    sub("sub_1", null, "price_pro_m", "active"); // metadata missing: client_reference_id is used
    const r = await webhookPOST(signed(evt("checkout.session.completed", { id: "cs_1", object: "checkout.session", mode: "subscription", subscription: "sub_1", client_reference_id: id })));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ received: true, handled: true });
    expect(await tierOf(id)).toBe("pro");
    expect(await st.accounts.getSubscription("sub_1")).toMatchObject({ accountId: id, stripeCustomerId: "cus_123", tier: "pro", status: "active" });

    const status = await (await billingGET(authed("/api/billing", token))).json();
    expect(status.subscription).toMatchObject({ tier: "pro", status: "active" });

    // upgrade to Max through the portal
    sub("sub_1", id, "price_max_m", "active");
    await webhookPOST(signed(evt("customer.subscription.updated", subs.get("sub_1")!)));
    expect(await tierOf(id)).toBe("max");

    // cancel: Stripe sends deleted with status canceled
    sub("sub_1", id, "price_max_m", "canceled");
    await webhookPOST(signed(evt("customer.subscription.deleted", subs.get("sub_1")!)));
    expect(await tierOf(id)).toBe("free");
  });
  it("re-reads the subscription so out-of-order events cannot resurrect access", async () => {
    const { id } = await createSession();
    sub("sub_2", id, "price_pro_m", "canceled");
    const stale = { ...subs.get("sub_2")!, status: "active" };
    await webhookPOST(signed(evt("customer.subscription.updated", stale)));
    expect(await tierOf(id)).toBe("free");
  });
  it("rejects bad signatures and ignores foreign subscriptions", async () => {
    const { id } = await createSession();
    sub("sub_3", id, "price_pro_m", "active");
    expect((await webhookPOST(signed(evt("customer.subscription.updated", subs.get("sub_3")!), "whsec_wrong"))).status).toBe(400);
    expect((await webhookPOST(new Request("http://app/x", { method: "POST", body: "{}" }))).status).toBe(400);
    expect(await tierOf(id)).toBe("free");
    sub("sub_4", null, "price_pro_m", "active");
    expect((await webhookPOST(signed(evt("customer.subscription.updated", subs.get("sub_4")!)))).status).toBe(200);
    expect(await st.accounts.getSubscription("sub_4")).toBeNull();
    expect((await (await webhookPOST(signed(evt("invoice.created", { id: "in_1" })))).json()).handled).toBe(false);
  });
  it("unknown price grants nothing; manual entitlement is never overwritten", async () => {
    const { id } = await createSession();
    sub("sub_5", id, "price_unknown", "active");
    await webhookPOST(signed(evt("customer.subscription.created", subs.get("sub_5")!)));
    expect(await tierOf(id)).toBe("free");
    await st.accounts.setEntitlement(id, { tier: "max", source: "manual", expiresAt: null });
    sub("sub_5", id, "price_pro_m", "canceled");
    await webhookPOST(signed(evt("customer.subscription.deleted", subs.get("sub_5")!)));
    expect(await tierOf(id)).toBe("max");
  });
  it("subscription metadata cannot move an existing subscription to another account", async () => {
    const a = await createSession(); const b = await createSession();
    sub("sub_8", a.id, "price_pro_m", "active");
    await webhookPOST(signed(evt("customer.subscription.created", subs.get("sub_8")!)));
    expect(await tierOf(a.id)).toBe("pro");
    sub("sub_8", b.id, "price_max_m", "active"); // metadata edited to point at B
    await webhookPOST(signed(evt("customer.subscription.updated", subs.get("sub_8")!)));
    expect(await st.accounts.getSubscription("sub_8")).toMatchObject({ accountId: a.id, tier: "max" });
    expect(await tierOf(a.id)).toBe("max");
    expect(await tierOf(b.id)).toBe("free");
  });
  it("a manual free override does not block a later Stripe purchase", async () => {
    const { id } = await createSession();
    await st.accounts.setEntitlement(id, { tier: "free", source: "manual", expiresAt: null });
    sub("sub_9", id, "price_pro_m", "active");
    await webhookPOST(signed(evt("customer.subscription.created", subs.get("sub_9")!)));
    expect(await tierOf(id)).toBe("pro");
  });
  it("access lapses after period end + grace even if webhooks are missed", async () => {
    const { id } = await createSession();
    const end = Math.floor(Date.now() / 1000) + 10 * 86400;
    sub("sub_6", id, "price_pro_m", "active", end);
    await webhookPOST(signed(evt("customer.subscription.created", subs.get("sub_6")!)));
    expect(await tierOf(id, end * 1000)).toBe("pro");
    expect(await tierOf(id, end * 1000 + 4 * 86_400_000)).toBe("free");
    await recomputeEntitlement(id, end * 1000 + 4 * 86_400_000);
    expect(await st.accounts.getEntitlement(id)).toBeNull();
  });
});

describe("billing status", () => {
  it("reports the entitled subscription even when an older one was canceled more recently", async () => {
    const { id, token } = await createSession();
    sub("sub_new", id, "price_pro_m", "active");
    await webhookPOST(signed(evt("customer.subscription.created", subs.get("sub_new")!)));
    sub("sub_old", id, "price_pro_m", "canceled");
    await st.accounts.upsertSubscription({ stripeSubscriptionId: "sub_old", accountId: id, stripeCustomerId: "cus_123", tier: "pro", status: "canceled", currentPeriodEnd: null });
    const status = await (await billingGET(authed("/api/billing", token))).json();
    expect(status.subscription).toMatchObject({ status: "active" });
  });
  it("lists which plans can actually be bought", async () => {
    vi.stubEnv("STRIPE_PRICE_MAX_YEARLY", "");
    const { token } = await createSession();
    const { plans } = await (await billingGET(authed("/api/billing", token))).json();
    expect(plans).toContainEqual({ plan: "max", interval: "year", available: false });
    expect(plans).toContainEqual({ plan: "pro", interval: "month", available: true });
  });
});

describe("customer portal", () => {
  it("returns a portal link for subscribers only; checkout blocked while subscribed", async () => {
    const { id, token } = await createSession();
    expect((await portalPOST(authed("/api/billing/portal", token, {}))).status).toBe(404);
    sub("sub_7", id, "price_pro_m", "active");
    await webhookPOST(signed(evt("customer.subscription.created", subs.get("sub_7")!)));
    expect((await (await portalPOST(authed("/api/billing/portal", token, {}))).json()).url).toBe("https://billing.stripe.com/p/session/cus_123");
    expect((await checkoutPOST(authed("/api/billing/checkout", token, { plan: "max" }))).status).toBe(409);
  });
});

describe("credit top-ups", () => {
  const paid = (id: string, over: object = {}) => ({ id: "cs_credit_1", object: "checkout.session", mode: "payment", payment_status: "paid", amount_total: 1000,
    client_reference_id: id, metadata: { pai_account: id, pai_credits_eur: "10" }, ...over });
  it("creates a one-time checkout for an allowed amount only", async () => {
    vi.stubEnv("STRIPE_PRICE_CREDIT_EUR", "price_credit");
    const { id } = await createSession();
    const { createCreditCheckout } = await import("../lib/billing");
    await createCreditCheckout(id, 25, "http://app");
    expect(checkoutCalls[0]).toMatchObject({ mode: "payment", line_items: [{ price: "price_credit", quantity: 25 }], metadata: { pai_account: id, pai_credits_eur: "25" } });
    await expect(createCreditCheckout(id, 7, "http://app")).rejects.toThrow(/amount/);
  });
  it("credits a paid session once, and never more than Stripe says was paid", async () => {
    const { id } = await createSession();
    await st.accounts.touchSession(id); // top-ups are for signed-in accounts, which always have a row
    expect(await (await webhookPOST(signed(evt("checkout.session.completed", paid(id))))).json()).toEqual({ received: true, handled: true });
    expect(await (await webhookPOST(signed(evt("checkout.session.completed", paid(id))))).json()).toEqual({ received: true, handled: false }); // replay
    expect((await st.accounts.getCredits(id))?.purchased).toBe(10_000_000);
    await webhookPOST(signed(evt("checkout.session.completed", paid(id, { id: "cs_credit_2", amount_total: 500, metadata: { pai_account: id, pai_credits_eur: "50" } }))));
    expect((await st.accounts.getCredits(id))?.purchased).toBe(15_000_000);
    await webhookPOST(signed(evt("checkout.session.completed", paid(id, { id: "cs_credit_3", payment_status: "unpaid" }))));
    expect((await st.accounts.getCredits(id))?.purchased).toBe(15_000_000);
  });
});
