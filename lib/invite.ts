import { createHash, timingSafeEqual } from "node:crypto";
import { stores } from "./store";

const norm = (s: string) => s.normalize("NFKC").trim();

/** INVITE_CODES, comma-separated. Empty = signup and anonymous chat open (dev; production refuses to boot, lib/session.ts). */
export const inviteCodes = (): string[] => (process.env.INVITE_CODES ?? "").split(",").map(norm).filter(Boolean);

/**
 * Signup is invite-only when INVITE_CODES has codes or INVITE_ONLY=1. Codes created in the admin
 * panel are accepted alongside the env codes but never switch the gate on by themselves, so
 * revoking the last one cannot silently open signup.
 */
export const inviteGateOn = () => inviteCodes().length > 0 || process.env.INVITE_ONLY === "1";

/** Plain codes in env, like the other secrets. Equal-length digests; every code is always checked. */
export function inviteOk(code: unknown): boolean {
  const codes = inviteCodes();
  if (codes.length === 0) return true;
  if (typeof code !== "string" || !norm(code)) return false;
  const sha = (s: string) => createHash("sha256").update(s).digest();
  const d = sha(norm(code));
  return codes.reduce((ok, c) => timingSafeEqual(sha(c), d) || ok, false);
}

/** Stored form of an admin-panel invite code (the code itself is shown once and never stored). */
export const inviteHash = (code: string) => createHash("sha256").update(norm(code)).digest("hex");

/** The admission outlives the registration challenge (CHALLENGE_TTL_MS, 5 minutes) it belongs to. */
const PENDING_MS = 6 * 60_000;
const pendingKey = (accountId: string) => `invite:${accountId}`;

/**
 * Gate check when a new account asks for passkey options. An accepted code is remembered for this
 * account ("env", or the admin-panel code's hash); registerVerify requires that admission, so
 * nobody can create an account without passing here first. An admin-panel code's use is counted
 * only at registerVerify, so a cancelled prompt spends nothing.
 */
export async function inviteAccepted(code: unknown, accountId: string): Promise<boolean> {
  const { accounts, counters } = await stores();
  if (inviteCodes().length > 0 && inviteOk(code)) { await counters.putOnce(pendingKey(accountId), "env", PENDING_MS); return true; }
  if (typeof code !== "string" || !norm(code) || code.length > 128) return false;
  const h = inviteHash(code);
  if (!(await accounts.inviteUsable(h))) return false;
  await counters.putOnce(pendingKey(accountId), h, PENDING_MS);
  return true;
}

/**
 * At account creation (gate on): take this account's admission and count an admin-panel code's
 * use. Returns a release function to give the use back if the passkey then fails to verify, or
 * null if there is no admission or the code was used up or revoked meanwhile.
 */
export async function admitPendingInvite(accountId: string): Promise<(() => Promise<void>) | null> {
  const { accounts, counters } = await stores();
  const p = await counters.takeOnce(pendingKey(accountId));
  if (p === null) return null;
  if (p === "env") return async () => {};
  if (!(await accounts.redeemInvite(p))) return null;
  return async () => { await accounts.releaseInvite(p); };
}
