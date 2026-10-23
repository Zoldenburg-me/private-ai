import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { TIERS, type TierId } from "./tiers";
import { stores } from "./store";
import { kek } from "./keyvault";

/**
 * Anonymous server-issued identity. Token = "pai_<id>.<hmac>". No email, no PII.
 * Tier comes from the server-side entitlement store, never from the client.
 */
export const sessionSecret = () => {
  const s = process.env.SESSION_SECRET;
  if (s && s.length >= 16) return s;
  if (process.env.NODE_ENV === "production") throw new Error("SESSION_SECRET required in production");
  return "dev-only-insecure-session-secret";
};

/**
 * Refuse to boot a production server with a weak session secret, the mock enclave (which would
 * show a fake "TEE-attested" provider) or an open signup gate (free anonymous accounts with no
 * instance-wide cap on the shared provider keys). PAI_ALLOW_MOCK_PROVIDER=1 is for local e2e runs on `next start` only.
 */
export function assertProductionConfig(env: Record<string, string | undefined> = process.env): void {
  if (env.NODE_ENV !== "production") return;
  if ((env.SESSION_SECRET ?? "").length < 32) throw new Error("SESSION_SECRET must be at least 32 characters in production");
  if (env.MOCK_PROVIDER === "1" && env.PAI_ALLOW_MOCK_PROVIDER !== "1") throw new Error("MOCK_PROVIDER=1 is not allowed in production");
  if (!(env.INVITE_CODES ?? "").split(",").some((c) => c.trim()) && env.INVITE_ONLY !== "1") throw new Error("INVITE_CODES or INVITE_ONLY=1 is required in production");
  kek(env); // throws if ADMIN_KEY_KEK is set but not 32 bytes
}

const sign = (id: string) => createHmac("sha256", sessionSecret()).update(id).digest("base64url").slice(0, 32);

export function issueToken(): { id: string; token: string } {
  const id = randomBytes(16).toString("base64url");
  return { id, token: `pai_${id}.${sign(id)}` };
}

/**
 * Two token shapes: "pai_<account>.<hmac>" (anonymous, stateless) and
 * "pai_<account>.<device>.<hmac>" (signed in; valid only while the device row exists).
 */
export function parseToken(token: string | undefined | null): { accountId: string; deviceId: string | null } | null {
  if (!token) return null;
  const m = /^pai_([A-Za-z0-9_-]{10,64})(?:\.([A-Za-z0-9_-]{16,64}))?\.([A-Za-z0-9_-]{32})$/.exec(token.trim());
  if (!m) return null;
  const a = Buffer.from(m[3]); const b = Buffer.from(sign(m[2] ? `${m[1]}.${m[2]}` : m[1]));
  return a.length === b.length && timingSafeEqual(a, b) ? { accountId: m[1], deviceId: m[2] ?? null } : null;
}

/** Signature check only (no store lookup): the account id, or null. */
export const verifyToken = (token: string | undefined | null): string | null => parseToken(token)?.accountId ?? null;

export function issueDeviceToken(accountId: string, deviceId: string): string {
  if (!/^[A-Za-z0-9_-]{10,64}$/.test(accountId) || !/^[A-Za-z0-9_-]{16,64}$/.test(deviceId)) throw new Error("invalid id");
  return `pai_${accountId}.${deviceId}.${sign(`${accountId}.${deviceId}`)}`;
}

function tokenFrom(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  const c = /(?:^|;\s*)pai_session=([^;]+)/.exec(req.headers.get("cookie") ?? "");
  return c ? decodeURIComponent(c[1]) : null;
}

/**
 * Identity from Bearer header (API) or cookie (web app). A device token needs its device row
 * (sign-out and device removal revoke it); an anonymous token stops working once the account
 * has a passkey or a device, so a copied pre-sign-in token cannot outlive a sign-out. Every
 * accepted token marks the account as seen today, so API-only use is not purged as inactive.
 */
export async function resolveIdentity(req: Request): Promise<{ accountId: string; deviceId: string | null } | null> {
  const t = parseToken(tokenFrom(req));
  if (!t) return null;
  const { accounts } = await stores();
  const ok = t.deviceId ? await accounts.touchDevice(t.accountId, t.deviceId) : !(await accounts.hasSignIn(t.accountId));
  if (!ok) return null;
  await accounts.touchSession(t.accountId);
  return t;
}

export const identityFrom = async (req: Request): Promise<string | null> => (await resolveIdentity(req))?.accountId ?? null;

/** Sign this browser in to `accountId`: a new device row and its token. */
export async function signInDevice(accountId: string): Promise<string> {
  const id = randomBytes(16).toString("base64url");
  await (await stores()).accounts.addDevice({ id, accountId, createdAt: Date.now() });
  return issueDeviceToken(accountId, id);
}

/** Issue a token for an existing opaque account id (e.g. after passkey login on a new device). */
export function issueTokenFor(id: string): string {
  if (!/^[A-Za-z0-9_-]{10,64}$/.test(id)) throw new Error("invalid account id");
  return `pai_${id}.${sign(id)}`;
}

/**
 * New anonymous session. Nothing is written: the account row appears on the first request that
 * carries the token (touchSession), so minting tokens in a loop cannot grow the database.
 */
export async function createSession(): Promise<{ id: string; token: string }> {
  return issueToken();
}

/** Record that the account was seen today (day granularity, nothing else). */
export async function touchSession(id: string): Promise<void> { await (await stores()).accounts.touchSession(id); }

/** Expires the session cookie (after account deletion). */
export const clearedSessionCookie = () =>
  `pai_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;

export const sessionCookie = (token: string) =>
  `pai_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;

/**
 * Entitlements live in the AccountStore (Postgres in production), set by Stripe webhooks or
 * manually. Env seed for dev/ops: ENTITLEMENTS='{"<id>":"pro"}'.
 */
export async function setTier(id: string, tier: TierId): Promise<void> {
  const { accounts } = await stores();
  // A stored manual "free" (not just clearing) so a paid ENTITLEMENTS seed cannot win again.
  await accounts.setEntitlement(id, { tier, source: "manual", expiresAt: null });
}

export async function tierOf(id: string, now = Date.now()): Promise<TierId> {
  let e = await (await stores()).accounts.getEntitlement(id);
  if (e?.source === "manual" && e.expiresAt != null && e.expiresAt <= now) {
    // An expired ops override hands back to the Stripe subscription it may have replaced.
    await (await import("./billing")).recomputeEntitlement(id, now);
    e = await (await stores()).accounts.getEntitlement(id);
  }
  if (e && (e.expiresAt == null || e.expiresAt > now)) return e.tier;
  try {
    const seed = JSON.parse(process.env.ENTITLEMENTS || "{}") as Record<string, TierId>;
    if (seed[id] && seed[id] in TIERS) return seed[id];
  } catch { /* ignore */ }
  return "free";
}
