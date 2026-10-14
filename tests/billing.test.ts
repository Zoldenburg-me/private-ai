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
let st: Stores;
const sub = (id: string, account: string | null, price: string, status: Stripe.Subscription.Status, periodEnd = Math.floor(Date.now() / 1000) + 30 * 86400) => {
  const s = { id, object: "subscription", customer: "cus_123", status, metadata: account ? { pai_account: account } : {},
    items: { object: "list", data: [{ price: { id: price }, current_period_end: periodEnd }] } } as unknown as Stripe.Subscription;
  subs.set(id, s); return s;
};
const mock = (): StripeLike => ({
  checkout: { sessions: { create: async (p) => { checkoutCalls.push(p); return { url: "https://checkout.stripe.com/c/pay/cs_test_1" }; } } },
  billingPortal: { sessions: { create: async (p) => ({ url: `https://billing.stripe.com/p/session/${p.customer}` }) } },
  subscriptions: { retrieve: async (id) => { const s = subs.get(id); if (!s) throw new Error("no such subscription"); return s; } },
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
  st = _setStores(); subs = new Map(); checkoutCalls = [];
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
