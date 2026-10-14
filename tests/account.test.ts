import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Stripe from "stripe";
import { _setStores, type Stores } from "../lib/store";
import { _setStripe, type StripeLike } from "../lib/billing";
import { createSession, setTier, touchSession } from "../lib/session";
import { GET as exportGET } from "../app/api/account/export/route";
import { DELETE as accountDELETE } from "../app/api/account/route";
import { GET as sessionGET } from "../app/api/session/route";
import { POST as webhookPOST } from "../app/api/billing/webhook/route";
import { POST as regOptions } from "../app/api/auth/passkey/register/options/route";
import { POST as regVerify } from "../app/api/auth/passkey/register/verify/route";
import { POST as loginOptions } from "../app/api/auth/passkey/login/options/route";
import { POST as loginVerify } from "../app/api/auth/passkey/login/verify/route";
import { SoftAuthenticator } from "./helpers/soft-authenticator";

const ORIGIN = "http://localhost:3000";
const WH_SECRET = "whsec_test_secret";
const real = new Stripe("sk_test_dummy");
const req = (path: string, method: string, token?: string, body?: unknown) => new Request(`${ORIGIN}${path}`, {
  method, headers: { "Content-Type": "application/json", ...(token ? { Cookie: `pai_session=${encodeURIComponent(token)}` } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

let st: Stores;
let deletedCustomers: string[];
let failDelete: Error | null;
let lastAccount = "";
const mockStripe = (): StripeLike => ({
  checkout: { sessions: { create: async () => ({ url: "https://checkout.stripe.com/x" }) } },
  billingPortal: { sessions: { create: async () => ({ url: "https://billing.stripe.com/x" }) } },
  subscriptions: { retrieve: async (id) => ({ id, status: "canceled", customer: "cus_del", metadata: { pai_account: lastAccount }, items: { data: [{ price: { id: "price_pro_m" } }] } }) as unknown as Stripe.Subscription },
  customers: { del: async (id) => { if (failDelete) throw failDelete; deletedCustomers.push(id); return { id, deleted: true }; } },
  webhooks: real.webhooks,
});

async function subscribed() {
  const { id, token } = await createSession(); lastAccount = id;
  await touchSession(id);
  await st.accounts.upsertSubscription({ stripeSubscriptionId: "sub_del", accountId: id, stripeCustomerId: "cus_del", tier: "pro", status: "active", currentPeriodEnd: null });
  await st.accounts.setEntitlement(id, { tier: "pro", source: "stripe", expiresAt: null });
  return { id, token };
}
async function withPasskey(token: string) {
  const auth = new SoftAuthenticator();
  const opts = await (await regOptions(req("/r", "POST", token, {}))).json();
  expect((await regVerify(req("/r", "POST", token, auth.create(opts, ORIGIN)))).status).toBe(200);
  return auth;
}
async function passkeyLogin(auth: SoftAuthenticator) {
  const opts = await (await loginOptions(req("/l", "POST", undefined, {}))).json();
  expect((await loginVerify(req("/l", "POST", undefined, auth.get(opts, ORIGIN)))).status).toBe(200);
}

beforeEach(() => {
  st = _setStores(); deletedCustomers = []; failDelete = null;
  _setStripe(mockStripe());
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_dummy"); vi.stubEnv("STRIPE_WEBHOOK_SECRET", WH_SECRET); vi.stubEnv("STRIPE_PRICE_PRO_MONTHLY", "price_pro_m");
});
afterEach(() => { vi.unstubAllEnvs(); _setStripe(undefined); });

describe("GET /api/account/export (Art. 15 / 20)", () => {
  it("needs a session", async () => {
    expect((await exportGET(req("/api/account/export", "GET"))).status).toBe(401);
  });
  it("returns everything stored server-side for the account, as a download", async () => {
    const { id, token } = await subscribed();
    await withPasskey(token);
    const r = await exportGET(req("/api/account/export", "GET", token));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-disposition")).toMatch(/^attachment; filename="private-ai-account-/);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const d = await r.json();
    expect(d.account.id).toBe(id);
    expect(typeof d.account.createdAt).toBe("string");
    expect(d.entitlement).toMatchObject({ tier: "pro", source: "stripe" });
    expect(d.subscriptions).toEqual([expect.objectContaining({ stripeSubscriptionId: "sub_del", stripeCustomerId: "cus_del", status: "active" })]);
    expect(d.passkeys).toHaveLength(1);
    expect(typeof d.passkeys[0].publicKey).toBe("string");
    expect(d.usage).toMatchObject({ usedToday: 0 });
    expect(d.notStoredHere).toBeDefined();
  });
  it("is rate-limited per account", async () => {
    vi.stubEnv("PAI_LIMIT_ACCOUNT_ACTIONS_PER_HOUR", "2");
    const { token } = await createSession();
    expect((await exportGET(req("/e", "GET", token))).status).toBe(200);
    expect((await exportGET(req("/e", "GET", token))).status).toBe(200);
    expect((await exportGET(req("/e", "GET", token))).status).toBe(429);
  });
});

describe("DELETE /api/account (Art. 17)", () => {
  it("needs a session", async () => {
    expect((await accountDELETE(req("/api/account", "DELETE"))).status).toBe(401);
  });
  it("deletes the account, its Stripe customer and the cookie; late webhooks do not resurrect it", async () => {
    const { id, token } = await subscribed();
    const r = await accountDELETE(req("/api/account", "DELETE", token));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ deleted: true });
    expect(r.headers.get("set-cookie")).toMatch(/^pai_session=; Path=\/; HttpOnly; SameSite=Strict; Max-Age=0/);
    expect(deletedCustomers).toEqual(["cus_del"]);
    expect(await st.accounts.sessionExists(id)).toBe(false);
    expect(await st.accounts.getSubscription("sub_del")).toBeNull();

    // Stripe sends customer.subscription.deleted after the customer is removed
    const payload = JSON.stringify({ id: "evt_1", object: "event", type: "customer.subscription.deleted", data: { object: { id: "sub_del" } } });
    const header = real.webhooks.generateTestHeaderString({ payload, secret: WH_SECRET });
    expect((await webhookPOST(new Request(`${ORIGIN}/api/billing/webhook`, { method: "POST", headers: { "stripe-signature": header }, body: payload }))).status).toBe(200);
    expect(await st.accounts.sessionExists(id)).toBe(false);
  });
  it("tolerates a Stripe customer that is already gone", async () => {
    const { id, token } = await subscribed();
    failDelete = Object.assign(new Error("No such customer"), { code: "resource_missing" });
    expect((await accountDELETE(req("/a", "DELETE", token))).status).toBe(200);
    expect(await st.accounts.sessionExists(id)).toBe(false);
  });
  it("fails closed when Stripe cannot delete the customer: nothing is deleted locally", async () => {
    const { id, token } = await subscribed();
    failDelete = new Error("stripe down");
    expect((await accountDELETE(req("/a", "DELETE", token))).status).toBe(502);
    expect(await st.accounts.sessionExists(id)).toBe(true);
    _setStripe(undefined); vi.stubEnv("STRIPE_SECRET_KEY", "");
    expect((await accountDELETE(req("/a", "DELETE", token))).status).toBe(503);
    expect(await st.accounts.sessionExists(id)).toBe(true);
  });
  it("a failed Stripe deletion gives the step-up back, so the retry needs no second passkey prompt", async () => {
    const { id, token } = await subscribed();
    const auth = await withPasskey(token);
    await passkeyLogin(auth);
    failDelete = new Error("stripe down");
    expect((await accountDELETE(req("/a", "DELETE", token))).status).toBe(502);
    failDelete = null;
    expect((await accountDELETE(req("/a", "DELETE", token))).status).toBe(200);
    expect(await st.accounts.sessionExists(id)).toBe(false);
  });
  it("with a passkey, needs a fresh passkey login (a stolen cookie cannot delete the account)", async () => {
    const { id, token } = await createSession();
    await setTier(id, "pro");
    const auth = await withPasskey(token);
    const denied = await accountDELETE(req("/a", "DELETE", token));
    expect(denied.status).toBe(403);
    expect((await denied.json()).error.code).toBe("step_up_required");
    expect(await st.accounts.sessionExists(id)).toBe(true);
    await passkeyLogin(auth);
    expect((await accountDELETE(req("/a", "DELETE", token))).status).toBe(200);
    expect(await st.accounts.sessionExists(id)).toBe(false);
    expect(await st.accounts.listCredentials(id)).toEqual([]);
  });
});

describe("anonymous session minting is capped", () => {
  it("new sessions are limited per minute; requests with a session are not", async () => {
    vi.stubEnv("PAI_LIMIT_NEW_SESSIONS_PER_MIN", "2");
    expect((await sessionGET(req("/api/session", "GET"))).status).toBe(200);
    const second = await sessionGET(req("/api/session", "GET"));
    expect(second.status).toBe(200);
    const token = (await second.json()).apiToken as string;
    const third = await sessionGET(req("/api/session", "GET"));
    expect(third.status).toBe(429);
    expect(Number(third.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await sessionGET(req("/api/session", "GET", token))).status).toBe(200);
  });
});
