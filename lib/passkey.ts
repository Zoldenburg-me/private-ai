import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type AuthenticatorTransport, type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { stores } from "./store";

/**
 * Passkey (WebAuthn) upgrade of an anonymous session. The passkey's user handle is the opaque
 * account id; no email or username is collected. Logging in with the passkey on another device
 * yields a session token for the same account id, so the plan follows the user.
 * Challenges live in the CounterStore (Redis) with a TTL and are single-use.
 */
export const CHALLENGE_TTL_MS = 5 * 60_000;
export const MAX_PASSKEYS = 10;

export interface RpConfig { rpID: string; rpName: string; origins: string[] }
export type Result<T> = ({ ok: true } & T) | { ok: false; status: number; message: string };

export function rpConfig(req: Request, env: Record<string, string | undefined> = process.env): RpConfig {
  const rpName = env.WEBAUTHN_RP_NAME || "Private AI";
  if (env.WEBAUTHN_RP_ID && env.WEBAUTHN_ORIGIN) {
    return { rpID: env.WEBAUTHN_RP_ID, rpName, origins: env.WEBAUTHN_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean) };
  }
  // Never trust the Host header for the relying party in production.
  if (env.NODE_ENV === "production") throw new Error("WEBAUTHN_RP_ID and WEBAUTHN_ORIGIN must be set in production");
  const u = new URL(req.url);
  return { rpID: u.hostname, rpName, origins: [u.origin] };
}

/** The challenge the browser signed, read from clientDataJSON (verified again by the library). */
function signedChallenge(clientDataJSON: unknown): string | null {
  if (typeof clientDataJSON !== "string" || clientDataJSON.length > 4096) return null;
  try {
    const c = JSON.parse(Buffer.from(clientDataJSON, "base64url").toString("utf8")) as { challenge?: unknown };
    return typeof c.challenge === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(c.challenge) ? c.challenge : null;
  } catch { return null; }
}

const transports = (t: string[]) => t as AuthenticatorTransport[];

export async function registrationOptions(accountId: string, rp: RpConfig) {
  const { accounts, counters } = await stores();
  const existing = await accounts.listCredentials(accountId);
  if (existing.length >= MAX_PASSKEYS) return { ok: false as const, status: 409, message: "too many passkeys on this account" };
  const options = await generateRegistrationOptions({
    rpName: rp.rpName, rpID: rp.rpID,
    // Not shown as PII: a fixed label plus a short prefix of the opaque id so users can tell accounts apart.
    userName: `Private AI ${accountId.slice(0, 6)}`, userID: new TextEncoder().encode(accountId),
    attestationType: "none",
    excludeCredentials: existing.map((c) => ({ id: c.credentialId, transports: transports(c.transports) })),
    authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
  });
  await counters.putOnce(`webauthn:reg:${options.challenge}`, accountId, CHALLENGE_TTL_MS);
  return { ok: true as const, options };
}

export async function verifyRegistration(accountId: string, response: RegistrationResponseJSON, rp: RpConfig): Promise<Result<{ credentialId: string }>> {
  const challenge = signedChallenge(response?.response?.clientDataJSON);
  if (!challenge) return { ok: false, status: 400, message: "malformed response" };
  const { accounts, counters } = await stores();
  // Single use, bound to the account that requested it.
  if ((await counters.takeOnce(`webauthn:reg:${challenge}`)) !== accountId) return { ok: false, status: 400, message: "challenge expired or unknown" };
  let v;
  try {
    v = await verifyRegistrationResponse({ response, expectedChallenge: challenge, expectedOrigin: rp.origins, expectedRPID: rp.rpID, requireUserVerification: false });
  } catch { return { ok: false, status: 400, message: "passkey verification failed" }; }
  if (!v.verified) return { ok: false, status: 400, message: "passkey verification failed" };
  const c = v.registrationInfo.credential;
  if (await accounts.getCredential(c.id)) return { ok: false, status: 409, message: "passkey already registered" };
  await accounts.addCredential({
    credentialId: c.id, accountId, publicKey: c.publicKey, counter: c.counter,
    transports: (c.transports ?? []).filter((t) => /^[a-z-]{1,16}$/.test(t)).slice(0, 8), createdAt: Date.now(),
  });
  return { ok: true, credentialId: c.id };
}

export async function authenticationOptions(rp: RpConfig) {
  // Discoverable credentials: no allowCredentials list, so nothing about accounts is revealed.
  const options = await generateAuthenticationOptions({ rpID: rp.rpID, userVerification: "preferred" });
  await (await stores()).counters.putOnce(`webauthn:auth:${options.challenge}`, "1", CHALLENGE_TTL_MS);
  return options;
}

export async function verifyAuthentication(response: AuthenticationResponseJSON, rp: RpConfig): Promise<Result<{ accountId: string }>> {
  const challenge = signedChallenge(response?.response?.clientDataJSON);
  if (!challenge || typeof response.id !== "string" || response.id.length > 1024) return { ok: false, status: 400, message: "malformed response" };
  const { accounts, counters } = await stores();
  if ((await counters.takeOnce(`webauthn:auth:${challenge}`)) !== "1") return { ok: false, status: 400, message: "challenge expired or unknown" };
  const cred = await accounts.getCredential(response.id);
  if (!cred) return { ok: false, status: 401, message: "unknown passkey" };
  let v;
  try {
    v = await verifyAuthenticationResponse({
      response, expectedChallenge: challenge, expectedOrigin: rp.origins, expectedRPID: rp.rpID, requireUserVerification: false,
      credential: { id: cred.credentialId, publicKey: cred.publicKey as Uint8Array<ArrayBuffer>, counter: cred.counter, transports: transports(cred.transports) },
    });
  } catch { return { ok: false, status: 401, message: "passkey verification failed" }; }
  if (!v.verified) return { ok: false, status: 401, message: "passkey verification failed" };
  // If the response carries a user handle it must match the stored owner.
  const handle = response.response.userHandle;
  if (handle && Buffer.from(handle, "base64url").toString("utf8") !== cred.accountId) return { ok: false, status: 401, message: "passkey owner mismatch" };
  await accounts.updateCredentialCounter(cred.credentialId, v.authenticationInfo.newCounter);
  return { ok: true, accountId: cred.accountId };
}
