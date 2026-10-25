import { clearedSessionCookie, identityFrom, resolveIdentity, sessionCookie, signInDevice, tierOf, touchSession } from "./session";
import { authenticationOptions, consumeStepUp, registrationOptions, restoreStepUp, rpConfig, verifyAuthentication, verifyRegistration, type RpConfig } from "./passkey";
import { stores, withStores } from "./store";
import { TIERS } from "./tiers";
import { LIMITS, overLimit } from "./limits";
import { metaLogger } from "./log";
import { admitPendingInvite, inviteAccepted, inviteGateOn } from "./invite";

/** HTTP glue for app/api/auth/passkey/*. Bodies are WebAuthn JSON only; nothing is logged. */
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
const fail = (status: number, message: string) => json({ error: { message } }, status);
/** 403 the UI answers by running a passkey login, then retrying the action once. */
export const stepUpRequired = () => json({ error: { message: "confirm with one of your passkeys first", code: "step_up_required" } }, 403);

function rp(req: Request): RpConfig | Response {
  try { return rpConfig(req); } catch { return fail(503, "passkeys not configured"); }
}
async function body<T>(req: Request): Promise<T | null> {
  try { return (await req.json()) as T; } catch { return null; }
}

export const listPasskeys = withStores(async (req: Request) => {
  const id = await identityFrom(req); if (!id) return fail(401, "missing or invalid session token");
  const creds = await (await stores()).accounts.listCredentials(id);
  // Credential ids are public (the browser sends them on every login); the full id is needed to remove one.
  return json({ passkeys: creds.map((c) => ({ id: c.credentialId, label: c.credentialId.slice(0, 8), createdAt: c.createdAt })) });
});

export const removePasskey = withStores(async (req: Request) => {
  const me = await resolveIdentity(req); if (!me) return fail(401, "missing or invalid session token");
  const id = me.accountId;
  const b = await body<{ id?: unknown }>(req);
  if (typeof b?.id !== "string" || !/^[A-Za-z0-9_-]{1,1024}$/.test(b.id)) return fail(400, "id required");
  const limited = await overLimit(LIMITS.accountAction, `acct:${id}`); if (limited) return limited;
  const { accounts } = await stores();
  if ((await accounts.getCredential(b.id))?.accountId !== id) return fail(404, "no such passkey on this account");
  // Without a passkey a pre-sign-in anonymous token would work again once the last device signs out.
  // Checked here so a refusal keeps the step-up; the store re-checks atomically against concurrent removals.
  const onlyOne = () => fail(409, "this is your only passkey: add another passkey first or delete the account");
  if ((await accounts.listCredentials(id)).length <= 1) return onlyOne();
  if (!(await consumeStepUp(me))) return stepUpRequired();
  const deleted = await accounts.deleteCredential(id, b.id).catch(async (e) => { await restoreStepUp(me); throw e; });
  if (deleted) return json({ deleted: true });
  await restoreStepUp(me);
  return (await accounts.getCredential(b.id))?.accountId === id ? onlyOne() : fail(404, "no such passkey on this account");
});

export const registerOptions = withStores(async (req: Request) => {
  const me = await resolveIdentity(req); if (!me) return fail(401, "missing or invalid session token");
  const id = me.accountId;
  const r = rp(req); if (r instanceof Response) return r;
  const limited = await overLimit(LIMITS.accountAction, `acct:${id}`); if (limited) return limited;
  // Only the first passkey creates an account; verify needs this route's challenge, so one check suffices.
  if (!me.deviceId && inviteGateOn()) {
    const invite = (await body<{ invite?: unknown }>(req))?.invite;
    // No code is the UI asking whether to prompt: answered before a stored code could be used up.
    if (invite === undefined) return json({ error: { message: "invite code required", code: "invite_required" } }, 403);
    // Every code counts against the guessing cap before it is checked, so a capped guess is never evaluated.
    const capped = await overLimit(LIMITS.inviteFail, "invite-fail"); if (capped) return capped;
    if (!(await inviteAccepted(invite, id))) return json({ error: { message: "invalid invite code", code: "invite_required" } }, 403);
  }
  if (!(await consumeStepUp(me))) return stepUpRequired();
  const o = await registrationOptions(id, r);
  if (o.ok) return json(o.options);
  await restoreStepUp(me);
  return fail(o.status, o.message);
});

export const registerVerify = withStores(async (req: Request) => {
  const me = await resolveIdentity(req); if (!me) return fail(401, "missing or invalid session token");
  const r = rp(req); if (r instanceof Response) return r;
  const b = await body<Parameters<typeof verifyRegistration>[1]>(req); if (!b) return fail(400, "invalid JSON");
  // Invite-only: the first passkey needs the admission registerOptions recorded. Its use is counted
  // before verifying (so a used-up code never creates an account) and given back if verification fails.
  const release = !me.deviceId && inviteGateOn() ? await admitPendingInvite(me.accountId) : async () => {};
  if (!release) return json({ error: { message: "invite code required or used up; start again", code: "invite_required" } }, 403);
  // Giving the use back is best effort: its failure must not hide why verification failed.
  const giveBack = () => release().catch(() => metaLogger({ route: "/api/auth/passkey/register/verify", event: "invite_release_failed" }));
  const v = await verifyRegistration(me.accountId, b, r).catch(async (e) => { await giveBack(); throw e; });
  if (!v.ok) { await giveBack(); return fail(v.status, v.message); }
  if (me.deviceId) return json({ registered: true });
  // First passkey: the anonymous token is now dead, so this browser becomes a signed-in device.
  const token = await signInDevice(me.accountId);
  return json({ registered: true, apiToken: token }, 200, { "Set-Cookie": sessionCookie(token) });
});

export const loginOptions = withStores(async (req: Request) => {
  const r = rp(req); if (r instanceof Response) return r;
  const b = await body<{ stepUp?: unknown }>(req);
  const me = b?.stepUp === true ? await resolveIdentity(req) : null;
  if (b?.stepUp === true && !me) return fail(401, "missing or invalid session token");
  // Step-up counts against the account, so a flood of anonymous logins cannot block account actions.
  const limited = me ? await overLimit(LIMITS.accountAction, `acct:${me.accountId}`) : await overLimit(LIMITS.passkeyLogin, "passkey-login");
  if (limited) return limited;
  return json(await authenticationOptions(r, me ?? undefined));
});

export const loginVerify = withStores(async (req: Request) => {
  // Not capped: verification needs a stored challenge, and challenges are capped by loginOptions.
  const r = rp(req); if (r instanceof Response) return r;
  const b = await body<Parameters<typeof verifyAuthentication>[0]>(req); if (!b) return fail(400, "invalid JSON");
  const v = await verifyAuthentication(b, r);
  if (!v.ok) return fail(v.status, v.message);
  // Step-up only confirms an action on this browser's account: no new device, no new cookie.
  if (v.stepUp) return json({ confirmed: true });
  await touchSession(v.accountId);
  // Signing in again on this browser replaces its old device instead of leaving it behind; the
  // old one goes only after the new one exists, so a failed sign-in leaves this browser signed in.
  const prev = await resolveIdentity(req);
  const token = await signInDevice(v.accountId);
  // Clean-up only: if it fails the old device stays listed under Settings, but the sign-in stands.
  if (prev?.deviceId) await (await stores()).accounts.deleteDevice(prev.accountId, prev.deviceId)
    .catch(() => metaLogger({ route: "/api/auth/passkey/login/verify", event: "old_device_cleanup_failed", status: 200 }));
  return json({ tier: TIERS[await tierOf(v.accountId)], apiToken: token }, 200, { "Set-Cookie": sessionCookie(token) });
});

/** Sign this browser out: its device row goes, so the token stops working everywhere. */
export const signOut = withStores(async (req: Request) => {
  const me = await resolveIdentity(req); if (!me) return fail(401, "missing or invalid session token");
  // An anonymous account has no way back in; dropping its token would lose it.
  if (!me.deviceId) return fail(400, "not signed in");
  await (await stores()).accounts.deleteDevice(me.accountId, me.deviceId);
  return json({ signedOut: true }, 200, { "Set-Cookie": clearedSessionCookie() });
});
