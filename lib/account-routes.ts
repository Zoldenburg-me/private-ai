import { BillingError, deleteStripeCustomers } from "./billing";
import { consumeStepUp, restoreStepUp } from "./passkey";
import { stepUpRequired } from "./passkey-routes";
import { clearedSessionCookie, identityFrom, tierOf } from "./session";
import { usage } from "./ratelimit";
import { stores, withStores } from "./store";
import { LIMITS, overLimit } from "./limits";
import { metaLogger } from "./log";

/** HTTP glue for app/api/account/*: data-subject rights (GDPR Art. 15, 17, 20) without email. */
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
const fail = (status: number, message: string) => json({ error: { message } }, status);
const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());

/** Everything the server holds for this account, as a JSON download. */
export const exportAccount = withStores(async (req: Request) => {
  const id = identityFrom(req); if (!id) return fail(401, "missing or invalid session token");
  const limited = await overLimit(LIMITS.accountAction, `acct:${id}`); if (limited) return limited;
  const { accounts } = await stores();
  const [session, entitlement, subscriptions, passkeys] = await Promise.all([
    accounts.getSession(id), accounts.getEntitlement(id), accounts.listSubscriptionsFor(id), accounts.listCredentials(id),
  ]);
  const data = {
    exportedAt: new Date().toISOString(),
    account: { id, createdAt: iso(session?.createdAt ?? null), lastSeenOn: session?.lastSeenOn ?? null },
    entitlement: entitlement && { ...entitlement, expiresAt: iso(entitlement.expiresAt) },
    subscriptions: subscriptions.map((s) => ({ ...s, currentPeriodEnd: iso(s.currentPeriodEnd) })),
    passkeys: passkeys.map((c) => ({
      credentialId: c.credentialId, publicKey: Buffer.from(c.publicKey).toString("base64url"),
      counter: c.counter, transports: c.transports, createdAt: iso(c.createdAt),
    })),
    usage: await usage(id, await tierOf(id)),
    notStoredHere: "Chats and personas live only in your browser. Payment details are held by Stripe; see /datenschutz.",
  };
  return json(data, 200, { "Content-Disposition": `attachment; filename="private-ai-account-${id.slice(0, 8)}.json"` });
});

/**
 * Delete the account: Stripe customer(s) first, so a failure there leaves everything intact and
 * the user can retry; then the account row, which cascades to plan, subscriptions and passkeys.
 * Usage counters in Redis carry only the opaque id and expire within 2 days.
 */
export const deleteAccount = withStores(async (req: Request) => {
  const id = identityFrom(req); if (!id) return fail(401, "missing or invalid session token");
  const limited = await overLimit(LIMITS.accountAction, `acct:${id}`); if (limited) return limited;
  if (!(await consumeStepUp(id))) return stepUpRequired();
  try { await deleteStripeCustomers(id); } catch (e) {
    await restoreStepUp(id);
    if (e instanceof BillingError) return fail(e.status, e.message);
    throw e;
  }
  await (await stores()).accounts.deleteAccount(id);
  metaLogger({ route: "/api/account", event: "account_deleted", status: 200 });
  return json({ deleted: true }, 200, { "Set-Cookie": clearedSessionCookie() });
});
