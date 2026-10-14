import { identityFrom, issueTokenFor, sessionCookie, tierOf, touchSession } from "./session";
import { authenticationOptions, registrationOptions, rpConfig, verifyAuthentication, verifyRegistration, type RpConfig } from "./passkey";
import { stores, withStores } from "./store";
import { TIERS } from "./tiers";

/** HTTP glue for app/api/auth/passkey/*. Bodies are WebAuthn JSON only; nothing is logged. */
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
const fail = (status: number, message: string) => json({ error: { message } }, status);

function rp(req: Request): RpConfig | Response {
  try { return rpConfig(req); } catch { return fail(503, "passkeys not configured"); }
}
async function body<T>(req: Request): Promise<T | null> {
  try { return (await req.json()) as T; } catch { return null; }
}

export const listPasskeys = withStores(async (req: Request) => {
  const id = identityFrom(req); if (!id) return fail(401, "missing or invalid session token");
  const creds = await (await stores()).accounts.listCredentials(id);
  return json({ passkeys: creds.map((c) => ({ id: c.credentialId.slice(0, 8), createdAt: c.createdAt })) });
});

export const registerOptions = withStores(async (req: Request) => {
  const id = identityFrom(req); if (!id) return fail(401, "missing or invalid session token");
  const r = rp(req); if (r instanceof Response) return r;
  const o = await registrationOptions(id, r);
  return o.ok ? json(o.options) : fail(o.status, o.message);
});

export const registerVerify = withStores(async (req: Request) => {
  const id = identityFrom(req); if (!id) return fail(401, "missing or invalid session token");
  const r = rp(req); if (r instanceof Response) return r;
  const b = await body<Parameters<typeof verifyRegistration>[1]>(req); if (!b) return fail(400, "invalid JSON");
  const v = await verifyRegistration(id, b, r);
  return v.ok ? json({ registered: true }) : fail(v.status, v.message);
});

export const loginOptions = withStores(async (req: Request) => {
  const r = rp(req); if (r instanceof Response) return r;
  return json(await authenticationOptions(r));
});

export const loginVerify = withStores(async (req: Request) => {
  const r = rp(req); if (r instanceof Response) return r;
  const b = await body<Parameters<typeof verifyAuthentication>[0]>(req); if (!b) return fail(400, "invalid JSON");
  const v = await verifyAuthentication(b, r);
  if (!v.ok) return fail(v.status, v.message);
  await touchSession(v.accountId);
  const token = issueTokenFor(v.accountId);
  return json({ tier: TIERS[await tierOf(v.accountId)], apiToken: token }, 200, { "Set-Cookie": sessionCookie(token) });
});
