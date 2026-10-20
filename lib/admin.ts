import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { consumeStepUp, restoreStepUp, rpConfig } from "./passkey";
import { stepUpRequired } from "./passkey-routes";
import { sessionSecret } from "./session";
import { stores, withStores } from "./store";
import { LIMITS, overLimit } from "./limits";

/**
 * Admin sessions, separate from user sessions: a passkey login by an account listed in
 * ADMIN_ACCOUNT_IDS gets a short-lived signed `pai_admin` cookie scoped to /api/admin. Every
 * request re-checks the allowlist, so removing an id ends its session at once. Writes need a
 * passkey step-up bound to this admin session (consumeStepUp with device "adm.<session>").
 */
export const ADMIN_COOKIE = "pai_admin";
export const ADMIN_SESSION_MS = 2 * 3_600_000;
export interface Admin { accountId: string; deviceId: string }

const ID = /^[A-Za-z0-9_-]{10,64}$/;
export function adminIds(env: Record<string, string | undefined> = process.env): Set<string> {
  return new Set((env.ADMIN_ACCOUNT_IDS ?? "").split(",").map((s) => s.trim()).filter((s) => ID.test(s)));
}

// "admin:" keeps these signatures apart from user tokens, whose signed ids never contain ":".
const sign = (payload: string) => createHmac("sha256", sessionSecret()).update(`admin:${payload}`).digest("base64url");

export function issueAdminToken(accountId: string, now = Date.now()): string {
  const payload = `${accountId}.${randomBytes(12).toString("base64url")}.${now + ADMIN_SESSION_MS}`;
  return `adm_${payload}.${sign(payload)}`;
}

function tokenFrom(req: Request): string | null {
  const c = new RegExp(`(?:^|;\\s*)${ADMIN_COOKIE}=([^;]+)`).exec(req.headers.get("cookie") ?? "");
  try { return c ? decodeURIComponent(c[1]) : null; } catch { return null; }
}

/** The admin behind this request, or null (bad signature, expired, or not on the allowlist). */
export function parseAdmin(req: Request, now = Date.now()): Admin | null {
  const m = /^adm_([A-Za-z0-9_-]{10,64})\.([A-Za-z0-9_-]{16})\.(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(tokenFrom(req) ?? "");
  if (!m) return null;
  const a = Buffer.from(m[4]); const b = Buffer.from(sign(`${m[1]}.${m[2]}.${m[3]}`));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (Number(m[3]) <= now || !adminIds().has(m[1])) return null;
  return { accountId: m[1], deviceId: `adm.${m[2]}` };
}

const secure = () => (process.env.NODE_ENV === "production" ? "; Secure" : "");
export const adminCookie = (token: string) =>
  `${ADMIN_COOKIE}=${encodeURIComponent(token)}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=${ADMIN_SESSION_MS / 1000}${secure()}`;
export const clearedAdminCookie = () => `${ADMIN_COOKIE}=; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=0${secure()}`;

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
export const fail = (status: number, message: string) => json({ error: { message } }, status);

/** Defence in depth next to SameSite=Strict: a write that names a foreign Origin is refused. */
function sameOrigin(req: Request): boolean {
  const o = req.headers.get("origin");
  if (!o) return true;
  try { return rpConfig(req).origins.includes(o); } catch { return false; }
}

/**
 * Wrap an admin handler: admin session, per-admin rate limit, and for writes a passkey step-up
 * (given back if the action fails, so a retry needs no second prompt). Fails closed with 503.
 */
export function adminRoute(fn: (req: Request, admin: Admin) => Promise<Response>, opts: { write?: boolean } = {}) {
  return withStores(async (req: Request) => {
    const admin = parseAdmin(req);
    if (!admin) return fail(401, "admin sign-in required");
    const { accounts } = await stores();
    // Without a passkey consumeStepUp would pass; an admin account always has one.
    if ((await accounts.listCredentials(admin.accountId)).length === 0) return fail(401, "admin sign-in required");
    const limited = await overLimit(LIMITS.admin, `admin:${admin.accountId}`); if (limited) return limited;
    if (!opts.write) return fn(req, admin);
    if (!sameOrigin(req)) return fail(403, "cross-origin request refused");
    if (!(await consumeStepUp(admin))) return stepUpRequired();
    try {
      const r = await fn(req, admin);
      if (r.status >= 400) await restoreStepUp(admin);
      return r;
    } catch (e) { await restoreStepUp(admin); throw e; }
  });
}
