import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { TierId } from "./tiers";

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

/** Entitlement store. TODO(payments): back with DB + Stripe/x402 webhooks. Env seed: ENTITLEMENTS='{"<id>":"pro"}'. */
const g = globalThis as unknown as { __paiEnt?: Map<string, TierId> };
const entitlements = (g.__paiEnt ??= new Map<string, TierId>());
export function setTier(id: string, tier: TierId) { entitlements.set(id, tier); }
export function tierOf(id: string): TierId {
  if (entitlements.has(id)) return entitlements.get(id)!;
  try {
    const seed = JSON.parse(process.env.ENTITLEMENTS || "{}") as Record<string, TierId>;
    if (seed[id]) return seed[id];
  } catch { /* ignore */ }
  return "free";
}
