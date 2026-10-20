import { randomBytes } from "node:crypto";
import { adminCookie, adminIds, adminRoute, clearedAdminCookie, fail, issueAdminToken, json } from "./admin";
import { eraseAccount } from "./account-routes";
import { BillingError, recomputeEntitlement } from "./billing";
import { inviteCodes, inviteGateOn, inviteHash } from "./invite";
import { authenticationOptions, rpConfig, verifyAuthentication, type RpConfig } from "./passkey";
import { invalidateKeys, KeyError, kekUsable, keyProviders, storeProviderKey } from "./provider-keys";
import { usage } from "./ratelimit";
import { tierOf } from "./session";
import { stores, withStores } from "./store";
import { erasureHash } from "./store/types";
import { TIERS, type TierId } from "./tiers";
import { LIMITS, overLimit } from "./limits";

/** HTTP glue for app/api/admin/*. Ids, plans, counters and timestamps only: there is no content to show. */
const ACCOUNT_ID = /^[A-Za-z0-9_-]{10,64}$/;
const OPAQUE_ID = /^[A-Za-z0-9_-]{4,64}$/;
const PAGE = 50;

function rp(req: Request): RpConfig | Response {
  try { return rpConfig(req); } catch { return fail(503, "passkeys not configured"); }
}
async function body(req: Request): Promise<Record<string, unknown>> {
  try { const b = await req.json(); return b && typeof b === "object" ? (b as Record<string, unknown>) : {}; } catch { return {}; }
}
const str = (v: unknown, re: RegExp) => (typeof v === "string" && re.test(v) ? v : null);
const audit = async (e: Parameters<Awaited<ReturnType<typeof stores>>["accounts"]["addAudit"]>[0]) => (await stores()).accounts.addAudit(e);

// --- sign-in -------------------------------------------------------------------------------

export const loginOptions = withStores(async (req: Request) => {
  const r = rp(req); if (r instanceof Response) return r;
  const limited = await overLimit(LIMITS.adminLogin, "admin-login"); if (limited) return limited;
  return json(await authenticationOptions(r));
});

/** Completes an admin login, or an admin step-up started by stepUpOptions. */
export const loginVerify = withStores(async (req: Request) => {
  const r = rp(req); if (r instanceof Response) return r;
  const v = await verifyAuthentication((await body(req)) as never, r);
  if (!v.ok) return fail(v.status, v.message);
  if (v.stepUp) return json({ confirmed: true });
  if (!adminIds().has(v.accountId)) return fail(403, "this passkey's account is not an admin");
  await audit({ adminId: v.accountId, action: "login" });
  return json({ admin: true, accountId: v.accountId }, 200, { "Set-Cookie": adminCookie(issueAdminToken(v.accountId)) });
});

/** Passkey challenge for confirming one write, bound to this admin session. */
export const stepUpOptions = adminRoute(async (req, admin) => {
  const r = rp(req); if (r instanceof Response) return r;
  return json(await authenticationOptions(r, admin));
});

export const logout = async () => json({ signedOut: true }, 200, { "Set-Cookie": clearedAdminCookie() });
export const me = adminRoute(async (_req, admin) => json({ accountId: admin.accountId }));

// --- user base -----------------------------------------------------------------------------

export const listAccounts = adminRoute(async (req) => {
  const u = new URL(req.url);
  const prefix = str(u.searchParams.get("q") ?? "", /^[A-Za-z0-9_-]{0,64}$/);
  const offset = Number(u.searchParams.get("offset") ?? 0);
  if (prefix === null || !Number.isInteger(offset) || offset < 0 || offset > 100_000) return fail(400, "q must be an account id prefix");
  const rows = await (await stores()).accounts.listAccounts({ prefix, limit: PAGE, offset });
  // The effective plan, as in the detail view: an expired override hands back to Stripe (tierOf), at most PAGE lookups.
  const accounts = await Promise.all(rows.map(async (a) => ({ ...a, tier: await tierOf(a.id) })));
  return json({ accounts, offset, pageSize: PAGE });
});

export const getAccount = adminRoute(async (req) => {
  const id = str(new URL(req.url).searchParams.get("id"), ACCOUNT_ID); if (!id) return fail(400, "id required");
  const { accounts } = await stores();
  const session = await accounts.getSession(id); if (!session) return fail(404, "no such account");
  const [entitlement, subs, creds, devices, tier] = await Promise.all([
    accounts.getEntitlement(id), accounts.listSubscriptionsFor(id), accounts.listCredentials(id), accounts.listDevices(id), tierOf(id),
  ]);
  return json({
    id, ...session, tier, entitlement,
    subscriptions: subs.map((s) => ({ id: s.stripeSubscriptionId, tier: s.tier, status: s.status, currentPeriodEnd: s.currentPeriodEnd })),
    passkeys: creds.length,
    devices: devices.map((d) => ({ id: d.id, createdAt: d.createdAt, lastSeenOn: d.lastSeenOn })),
    usage: await usage(id, tier),
  });
});

/** Same erasure path as the user's own delete; the audit log keeps only the erasure hash. */
export const deleteAccount = adminRoute(async (req, admin) => {
  const id = str((await body(req)).id, ACCOUNT_ID); if (!id) return fail(400, "id required");
  if (!(await (await stores()).accounts.sessionExists(id))) return fail(404, "no such account");
  // Operators are removed from ADMIN_ACCOUNT_IDS first; their own audit trail is kept (see data inventory).
  if (adminIds().has(id)) return fail(409, "remove this id from ADMIN_ACCOUNT_IDS before deleting the account");
  try { await eraseAccount(id); } catch (e) { if (e instanceof BillingError) return fail(e.status, e.message); throw e; }
  await audit({ adminId: admin.accountId, action: "delete_account", target: erasureHash(id) });
  return json({ deleted: true });
}, { write: true });

export const revokeDevice = adminRoute(async (req, admin) => {
  const b = await body(req);
  const id = str(b.id, ACCOUNT_ID); const deviceId = str(b.deviceId, /^[A-Za-z0-9_-]{16,64}$/);
  if (!id || !deviceId) return fail(400, "id and deviceId required");
  if (!(await (await stores()).accounts.deleteDevice(id, deviceId))) return fail(404, "no such device on this account");
  await audit({ adminId: admin.accountId, action: "revoke_device", accountId: id, target: deviceId });
  return json({ deleted: true });
}, { write: true });

/**
 * Manual ops entitlement (source "manual"). It replaces a Stripe entitlement while it lasts; clearing
 * it, or its expiry, recomputes the plan from the account's Stripe subscriptions.
 */
export const setEntitlement = adminRoute(async (req, admin) => {
  const b = await body(req);
  const id = str(b.id, ACCOUNT_ID); if (!id) return fail(400, "id required");
  if (typeof b.tier !== "string" || !(b.tier in TIERS)) return fail(400, `tier must be one of ${Object.keys(TIERS).join(", ")}`);
  const expiresAt = b.expiresAt ?? null;
  if (expiresAt !== null && (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt <= Date.now())) return fail(400, "expiresAt must be a future time in ms, or null");
  const { accounts } = await stores();
  if (!(await accounts.sessionExists(id))) return fail(404, "no such account");
  const tier = b.tier as TierId;
  await accounts.setEntitlement(id, { tier, source: "manual", expiresAt });
  await audit({ adminId: admin.accountId, action: "set_entitlement", accountId: id, detail: expiresAt ? `${tier} until ${new Date(expiresAt).toISOString()}` : tier });
  return json({ ok: true });
}, { write: true });

export const clearEntitlement = adminRoute(async (req, admin) => {
  const id = str((await body(req)).id, ACCOUNT_ID); if (!id) return fail(400, "id required");
  const { accounts } = await stores();
  if (!(await accounts.sessionExists(id))) return fail(404, "no such account");
  await accounts.clearEntitlement(id, "manual");
  // Hand back to an active Stripe subscription the manual plan may have replaced.
  await recomputeEntitlement(id);
  await audit({ adminId: admin.accountId, action: "clear_entitlement", accountId: id });
  return json({ ok: true });
}, { write: true });

// --- provider keys -------------------------------------------------------------------------

export const listKeys = adminRoute(async () => {
  const keys = await (await stores()).accounts.listProviderKeys();
  const providers = keyProviders().map(({ id, name, prefix }) => {
    const own = keys.filter((k) => k.provider === id);
    const envKey = Boolean(process.env[`${prefix}_API_KEY`]);
    return { id, name, envKey, inUse: own.some((k) => k.status === "active") ? "stored" : envKey ? "env" : "none", keys: own };
  });
  return json({ providers, kekConfigured: kekUsable() });
});

export const addKey = adminRoute(async (req, admin) => {
  const b = await body(req);
  try {
    const k = await storeProviderKey(b.provider, b.key);
    await audit({ adminId: admin.accountId, action: "add_key", target: k.id, detail: String(b.provider) });
    return json(k);
  } catch (e) { if (e instanceof KeyError) return fail(e.status, e.message); throw e; }
}, { write: true });

export const setKeyStatus = adminRoute(async (req, admin) => {
  const b = await body(req);
  const id = str(b.id, OPAQUE_ID); if (!id) return fail(400, "id required");
  if (b.status !== "active" && b.status !== "disabled") return fail(400, "status must be active or disabled");
  if (!(await (await stores()).accounts.setProviderKeyStatus(id, b.status))) return fail(404, "no such key");
  invalidateKeys();
  await audit({ adminId: admin.accountId, action: "set_key_status", target: id, detail: b.status });
  return json({ ok: true });
}, { write: true });

export const removeKey = adminRoute(async (req, admin) => {
  const id = str((await body(req)).id, OPAQUE_ID); if (!id) return fail(400, "id required");
  if (!(await (await stores()).accounts.deleteProviderKey(id))) return fail(404, "no such key");
  invalidateKeys();
  await audit({ adminId: admin.accountId, action: "delete_key", target: id });
  return json({ deleted: true });
}, { write: true });

// --- invite codes --------------------------------------------------------------------------

export const listInvites = adminRoute(async () =>
  json({ invites: await (await stores()).accounts.listInvites(), envCodes: inviteCodes().length, gateOn: inviteGateOn() }));

/** The code is returned once; only its hash is stored. */
export const addInvite = adminRoute(async (req, admin) => {
  const maxUses = (await body(req)).maxUses ?? 1;
  if (typeof maxUses !== "number" || !Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1000) return fail(400, "maxUses must be 1 to 1000");
  const code = randomBytes(9).toString("base64url");
  const id = `inv_${randomBytes(6).toString("base64url")}`;
  await (await stores()).accounts.addInvite({ id, codeHash: inviteHash(code), maxUses, createdAt: Date.now() });
  await audit({ adminId: admin.accountId, action: "add_invite", target: id, detail: `max ${maxUses}` });
  return json({ id, code, maxUses });
}, { write: true });

export const revokeInvite = adminRoute(async (req, admin) => {
  const id = str((await body(req)).id, OPAQUE_ID); if (!id) return fail(400, "id required");
  if (!(await (await stores()).accounts.revokeInvite(id))) return fail(404, "no such invite");
  await audit({ adminId: admin.accountId, action: "revoke_invite", target: id });
  return json({ ok: true });
}, { write: true });

// --- audit log -----------------------------------------------------------------------------

export const listAudit = adminRoute(async () => json({ entries: await (await stores()).accounts.listAudit(200) }));
