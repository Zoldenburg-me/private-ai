import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { TIERS, type TierId } from "./tiers";
import { stores } from "./store";

/**
 * Anonymous server-issued identity. Token = "pai_<id>.<hmac>". No email, no PII.
 * Tier comes from the server-side entitlement store, never from the client.
 */
const secret = () => {
  const s = process.env.SESSION_SECRET;
  if (s && s.length >= 16) return s;
  if (process.env.NODE_ENV === "production") throw new Error("SESSION_SECRET required in production");
  return "dev-only-insecure-session-secret";
};

const sign = (id: string) => createHmac("sha256", secret()).update(id).digest("base64url").slice(0, 32);

export function issueToken(): { id: string; token: string } {
  const id = randomBytes(16).toString("base64url");
  return { id, token: `pai_${id}.${sign(id)}` };
}

export function verifyToken(token: string | undefined | null): string | null {
  if (!token) return null;
  const m = /^pai_([A-Za-z0-9_-]{10,64})\.([A-Za-z0-9_-]{32})$/.exec(token.trim());
  if (!m) return null;
  const a = Buffer.from(m[2]); const b = Buffer.from(sign(m[1]));
  return a.length === b.length && timingSafeEqual(a, b) ? m[1] : null;
}

/** Read identity from Bearer header (API) or cookie (web app). */
export function identityFrom(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return verifyToken(auth.slice(7));
  const cookie = req.headers.get("cookie") ?? "";
  const c = /(?:^|;\s*)pai_session=([^;]+)/.exec(cookie);
  return verifyToken(c ? decodeURIComponent(c[1]) : null);
}

/** Issue a token for an existing opaque account id (e.g. after passkey login on a new device). */
export function issueTokenFor(id: string): string {
  if (!/^[A-Za-z0-9_-]{10,64}$/.test(id)) throw new Error("invalid account id");
  return `pai_${id}.${sign(id)}`;
}

/** New anonymous session, persisted (opaque id + timestamps only). */
export async function createSession(): Promise<{ id: string; token: string }> {
  const s = issueToken();
  await (await stores()).accounts.touchSession(s.id);
  return s;
}

/** Record that the account was seen today (day granularity, nothing else). */
export async function touchSession(id: string): Promise<void> { await (await stores()).accounts.touchSession(id); }

export const sessionCookie = (token: string) =>
  `pai_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;

/**
 * Entitlements live in the AccountStore (Postgres in production), set by Stripe webhooks or
 * manually. Env seed for dev/ops: ENTITLEMENTS='{"<id>":"pro"}'.
 */
export async function setTier(id: string, tier: TierId): Promise<void> {
  const { accounts } = await stores();
  if (tier === "free") await accounts.clearEntitlement(id);
  else await accounts.setEntitlement(id, { tier, source: "manual", expiresAt: null });
}

export async function tierOf(id: string, now = Date.now()): Promise<TierId> {
  const e = await (await stores()).accounts.getEntitlement(id);
  if (e && (e.expiresAt == null || e.expiresAt > now)) return e.tier;
  try {
    const seed = JSON.parse(process.env.ENTITLEMENTS || "{}") as Record<string, TierId>;
    if (seed[id] && seed[id] in TIERS) return seed[id];
  } catch { /* ignore */ }
  return "free";
}
