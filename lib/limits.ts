import { stores } from "./store";

/**
 * Abuse limits for endpoints that do not go through the per-account fair-use gate.
 * Counts only, keyed by a route name (global) or the opaque account id; never by IP.
 * Per-client (IP) limits belong in the TLS reverse proxy, which keeps them in memory.
 * Limits are read from the environment on every call so ops can tune them without a rebuild.
 */
interface LimitSpec { env: string; fallback: number; windowMs: number }

export const LIMITS = {
  /** New anonymous sessions per minute, whole instance. */
  newSession: { env: "PAI_LIMIT_NEW_SESSIONS_PER_MIN", fallback: 600, windowMs: 60_000 },
  /** Anonymous passkey login options per minute, whole instance (bounds stored challenges). */
  passkeyLogin: { env: "PAI_LIMIT_PASSKEY_LOGINS_PER_MIN", fallback: 300, windowMs: 60_000 },
  /** Failed invite codes per minute, whole instance (caps guessing across fresh sessions). */
  inviteFail: { env: "PAI_LIMIT_INVITE_FAILS_PER_MIN", fallback: 30, windowMs: 60_000 },
  /** Export, delete, passkey add/remove per account per hour. */
  accountAction: { env: "PAI_LIMIT_ACCOUNT_ACTIONS_PER_HOUR", fallback: 20, windowMs: 3_600_000 },
  /** Attestation / signature fetches per account per minute (each spends the shared provider key). */
  evidence: { env: "PAI_LIMIT_EVIDENCE_PER_MIN", fallback: 30, windowMs: 60_000 },
  /** Attestation / signature fetches per minute, whole instance (fresh anonymous sessions are free to mint). */
  evidenceAll: { env: "PAI_LIMIT_EVIDENCE_ALL_PER_MIN", fallback: 600, windowMs: 60_000 },
} satisfies Record<string, LimitSpec>;

function limitOf(spec: LimitSpec, env: Record<string, string | undefined>): number {
  const n = Number(env[spec.env]);
  return Number.isInteger(n) && n > 0 ? n : spec.fallback;
}

/** Count one request against `bucket`; returns a 429 response when over the limit, else null. */
export async function overLimit(spec: LimitSpec, bucket: string, now = Date.now(), env: Record<string, string | undefined> = process.env): Promise<Response | null> {
  const r = await (await stores()).counters.hit(bucket, limitOf(spec, env), spec.windowMs, now);
  if (r.allowed) return null;
  return Response.json({ error: { message: "too many requests, retry later" } }, {
    status: 429, headers: { "Cache-Control": "no-store", "Retry-After": String(Math.max(1, Math.ceil((r.resetAt - now) / 1000))) },
  });
}
