import { BillingError, deleteStripeCustomers } from "./billing";
import { consumeStepUp, restoreStepUp } from "./passkey";
import { stepUpRequired } from "./passkey-routes";
import { clearedSessionCookie, resolveIdentity, tierOf } from "./session";
import { usage } from "./ratelimit";
import { stores, withStores } from "./store";
import { LIMITS, overLimit } from "./limits";
import { metaLogger } from "./log";

/** HTTP glue for app/api/account/*: data-subject rights (GDPR Art. 15, 17, 20) without email. */
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
const fail = (status: number, message: string) => json({ error: { message } }, status);
const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());

/** Everything the server holds for this account, as a JSON download. Needs step-up once the account has a passkey. */
export const exportAccount = withStores(async (req: Request) => {
  const me = await resolveIdentity(req); if (!me) return fail(401, "missing or invalid session token");
  const limited = await overLimit(LIMITS.accountAction, `acct:${me.accountId}`); if (limited) return limited;
  if (!(await consumeStepUp(me))) return stepUpRequired();
  try { return await exportData(me.accountId); } catch (e) { await restoreStepUp(me); throw e; }
});

async function exportData(id: string): Promise<Response> {
  const { accounts } = await stores();
  const [session, entitlement, subscriptions, passkeys, devices] = await Promise.all([
    accounts.getSession(id), accounts.getEntitlement(id), accounts.listSubscriptionsFor(id), accounts.listCredentials(id), accounts.listDevices(id),
  ]);
  const tier = await tierOf(id);
  const data = {
    exportedAt: new Date().toISOString(),
    account: { id, createdAt: iso(session?.createdAt ?? null), lastSeenOn: session?.lastSeenOn ?? null },
    entitlement: entitlement && { ...entitlement, expiresAt: iso(entitlement.expiresAt) },
    subscriptions: subscriptions.map((s) => ({ ...s, currentPeriodEnd: iso(s.currentPeriodEnd) })),
    passkeys: passkeys.map((c) => ({
      credentialId: c.credentialId, publicKey: Buffer.from(c.publicKey).toString("base64url"),
      counter: c.counter, transports: c.transports, createdAt: iso(c.createdAt),
    })),
    devices: devices.map((d) => ({ id: d.id, createdAt: iso(d.createdAt), lastSeenOn: d.lastSeenOn })),
    usage: await usage(id, tier),
    incognitoUsage: await usage(id, tier, Date.now(), "incognito"),
    topUsage: await usage(id, tier, Date.now(), "top"),
    credits: await (await stores()).accounts.getCredits(id),
    notStoredHere: "Chats and personas live only in your browser. Payment details are held by Stripe; see /datenschutz.",
  };
  return json(data, 200, { "Content-Disposition": `attachment; filename="private-ai-account-${id.slice(0, 8)}.json"` });
}

/**
 * Art. 17 erasure, shared by the user's own delete and the admin panel: Stripe customer(s) first,
 * so a failure there leaves everything intact; then the account row, recorded in the erasure ledger.
 */
export async function eraseAccount(id: string): Promise<void> {
  await deleteStripeCustomers(id);
  await (await stores()).accounts.deleteAccount(id);
}

/**
 * Delete the account: Stripe customer(s) first, so a failure there leaves everything intact and
 * the user can retry; then the account row, which cascades to plan, subscriptions and passkeys.
 * Usage counters in Redis carry only the opaque id and expire within 2 days.
 */
export const deleteAccount = withStores(async (req: Request) => {
  const me = await resolveIdentity(req); if (!me) return fail(401, "missing or invalid session token");
  const id = me.accountId;
  const limited = await overLimit(LIMITS.accountAction, `acct:${id}`); if (limited) return limited;
  if (!(await consumeStepUp(me))) return stepUpRequired();
  try { await eraseAccount(id); } catch (e) {
    await restoreStepUp(me);
    if (e instanceof BillingError) return fail(e.status, e.message);
    throw e;
  }
  metaLogger({ route: "/api/account", event: "account_deleted", status: 200 });
  return json({ deleted: true }, 200, { "Set-Cookie": clearedSessionCookie() });
});

/** Signed-in browsers of this account. Ids only: there is no name, model or location to show. */
export const listDevices = withStores(async (req: Request) => {
  const me = await resolveIdentity(req); if (!me) return fail(401, "missing or invalid session token");
  const devices = await (await stores()).accounts.listDevices(me.accountId);
  return json({ devices: devices.map((d) => ({ id: d.id, createdAt: d.createdAt, lastSeenOn: d.lastSeenOn, current: d.id === me.deviceId })) });
});

/** Sign a device out remotely. Needs step-up, like removing a passkey. */
export const removeDevice = withStores(async (req: Request) => {
  const me = await resolveIdentity(req); if (!me) return fail(401, "missing or invalid session token");
  let b: { id?: unknown } | null = null;
  try { b = (await req.json()) as { id?: unknown }; } catch { /* handled below */ }
  const id = b?.id;
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(id)) return fail(400, "id required");
  const limited = await overLimit(LIMITS.accountAction, `acct:${me.accountId}`); if (limited) return limited;
  const { accounts } = await stores();
  if (!(await accounts.listDevices(me.accountId)).some((d) => d.id === id)) return fail(404, "no such device on this account");
  if (!(await consumeStepUp(me))) return stepUpRequired();
  if (!(await accounts.deleteDevice(me.accountId, id))) { await restoreStepUp(me); return fail(404, "no such device on this account"); }
  return json({ deleted: true }, 200, id === me.deviceId ? { "Set-Cookie": clearedSessionCookie() } : {});
});
