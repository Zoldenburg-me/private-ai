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
/** How long a passkey login counts as fresh for sensitive account actions. */
export const STEP_UP_TTL_MS = 5 * 60_000;
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
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
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
    v = await verifyRegistrationResponse({ response, expectedChallenge: challenge, expectedOrigin: rp.origins, expectedRPID: rp.rpID, requireUserVerification: true });
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

/**
 * Login: discoverable credentials, no allowCredentials list, so nothing about accounts is revealed.
 * Step-up (`stepUpFor` = the signed-in browser): only that account's passkeys are offered and
 * accepted, so confirming an action can never switch to, or act on, a different account. The
 * challenge remembers the asking device, and only that device gets the step-up.
 */
export async function authenticationOptions(rp: RpConfig, stepUpFor?: Identity) {
  const { accounts, counters } = await stores();
  const allow = stepUpFor ? (await accounts.listCredentials(stepUpFor.accountId)).map((c) => ({ id: c.credentialId, transports: transports(c.transports) })) : undefined;
  const options = await generateAuthenticationOptions({ rpID: rp.rpID, userVerification: "required", ...(allow ? { allowCredentials: allow } : {}) });
  await counters.putOnce(`webauthn:auth:${options.challenge}`, stepUpFor ? `step:${stepUpKey(stepUpFor)}` : "1", CHALLENGE_TTL_MS);
  return options;
}

export async function verifyAuthentication(response: AuthenticationResponseJSON, rp: RpConfig): Promise<Result<{ accountId: string; stepUp: boolean }>> {
  const challenge = signedChallenge(response?.response?.clientDataJSON);
  if (!challenge || typeof response.id !== "string" || response.id.length > 1024) return { ok: false, status: 400, message: "malformed response" };
  const { accounts, counters } = await stores();
  const pending = await counters.takeOnce(`webauthn:auth:${challenge}`);
  if (pending !== "1" && !pending?.startsWith("step:")) return { ok: false, status: 400, message: "challenge expired or unknown" };
  const cred = await accounts.getCredential(response.id);
  if (!cred) return { ok: false, status: 401, message: "unknown passkey" };
  const step = pending === "1" ? null : pending.slice(5);
  if (step && cred.accountId !== step.split(":")[0]) return { ok: false, status: 401, message: "passkey belongs to another account" };
  let v;
  try {
    v = await verifyAuthenticationResponse({
      response, expectedChallenge: challenge, expectedOrigin: rp.origins, expectedRPID: rp.rpID, requireUserVerification: true,
      credential: { id: cred.credentialId, publicKey: cred.publicKey as Uint8Array<ArrayBuffer>, counter: cred.counter, transports: transports(cred.transports) },
    });
  } catch { return { ok: false, status: 401, message: "passkey verification failed" }; }
  if (!v.verified) return { ok: false, status: 401, message: "passkey verification failed" };
  // If the response carries a user handle it must match the stored owner.
  const handle = response.response.userHandle;
  if (handle && Buffer.from(handle, "base64url").toString("utf8") !== cred.accountId) return { ok: false, status: 401, message: "passkey owner mismatch" };
  await accounts.updateCredentialCounter(cred.credentialId, v.authenticationInfo.newCounter);
  // A plain sign-in grants no step-up: it would otherwise unlock every other device's cookie too.
  if (step) await counters.putOnce(`webauthn:stepup:${step}`, "1", STEP_UP_TTL_MS);
  return { ok: true, accountId: cred.accountId, stepUp: step !== null };
}

/**
 * Sensitive actions (adding or removing a passkey, deleting the account) on an account that has
 * a passkey need a passkey login within STEP_UP_TTL_MS, so a copied session cookie alone cannot
 * take the account over or destroy it. Accounts without a passkey have nothing stronger than the
 * cookie, so the cookie suffices. Each step-up belongs to the device that confirmed it and is
 * consumed by one action.
 */
export async function consumeStepUp(me: Identity): Promise<boolean> {
  const { accounts, counters } = await stores();
  if ((await accounts.listCredentials(me.accountId)).length === 0) return true;
  return (await counters.takeOnce(`webauthn:stepup:${stepUpKey(me)}`)) === "1";
}

/** Give a consumed step-up back when the action failed, so a retry needs no second passkey prompt. */
export async function restoreStepUp(me: Identity): Promise<void> {
  const { accounts, counters } = await stores();
  if ((await accounts.listCredentials(me.accountId)).length > 0) await counters.putOnce(`webauthn:stepup:${stepUpKey(me)}`, "1", STEP_UP_TTL_MS);
}

type Identity = { accountId: string; deviceId: string | null };
/** `<account>:<device>`; anonymous tokens have no device and keep the account-only form. */
const stepUpKey = (me: Identity) => (me.deviceId ? `${me.accountId}:${me.deviceId}` : me.accountId);
