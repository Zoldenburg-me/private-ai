import { createHash, generateKeyPairSync, randomBytes, sign as edSign, type KeyObject } from "node:crypto";

/** Minimal software WebAuthn authenticator (ES256, "none" attestation) for tests. */
type Cbor = number | string | Uint8Array | Cbor[] | Map<Cbor, Cbor> | { [k: string]: Cbor };
function head(major: number, n: number): number[] {
  if (n < 24) return [(major << 5) | n];
  if (n < 256) return [(major << 5) | 24, n];
  if (n < 65536) return [(major << 5) | 25, n >> 8, n & 255];
  return [(major << 5) | 26, (n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function cbor(v: Cbor): Uint8Array {
  const out: number[] = [];
  const enc = (x: Cbor) => {
    if (typeof x === "number") out.push(...(x >= 0 ? head(0, x) : head(1, -1 - x)));
    else if (typeof x === "string") { const b = new TextEncoder().encode(x); out.push(...head(3, b.length), ...b); }
    else if (x instanceof Uint8Array) out.push(...head(2, x.length), ...x);
    else if (Array.isArray(x)) { out.push(...head(4, x.length)); x.forEach(enc); }
    else { const entries = x instanceof Map ? [...x.entries()] : Object.entries(x); out.push(...head(5, entries.length)); for (const [k, val] of entries) { enc(k); enc(val); } }
  };
  enc(v); return Uint8Array.from(out);
}

const b64u = (b: Uint8Array | Buffer) => Buffer.from(b).toString("base64url");
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest();
const u32 = (n: number) => Buffer.from([(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255]);

export class SoftAuthenticator {
  private creds = new Map<string, { key: KeyObject; userHandle: string; rpId: string; counter: number }>();
  /** `uv: false` simulates a presence-only authenticator (no PIN/biometric): the UV flag is not set. */
  constructor(private opts: { uv?: boolean } = {}) {}
  private flags(base: number) { return this.opts.uv === false ? base & ~0x04 : base; }

  /** navigator.credentials.create() equivalent; returns RegistrationResponseJSON. */
  create(opts: { challenge: string; rp: { id?: string }; user: { id: string } }, origin: string, credId = randomBytes(16)) {
    const rpId = opts.rp.id ?? new URL(origin).hostname;
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" });
    const cose = cbor(new Map<Cbor, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, "base64url")], [-3, Buffer.from(jwk.y!, "base64url")]]));
    const authData = Buffer.concat([sha256(rpId), Buffer.from([this.flags(0x45)]), u32(0), Buffer.alloc(16), Buffer.from([0, credId.length]), credId, Buffer.from(cose)]);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: opts.challenge, origin, crossOrigin: false }));
    this.creds.set(b64u(credId), { key: privateKey, userHandle: opts.user.id, rpId, counter: 0 });
    return {
      id: b64u(credId), rawId: b64u(credId), type: "public-key" as const, clientExtensionResults: {},
      response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(cbor({ fmt: "none", attStmt: {}, authData })), transports: ["internal" as const] },
    };
  }

  /** navigator.credentials.get() with a discoverable credential; returns AuthenticationResponseJSON. */
  get(opts: { challenge: string; rpId?: string }, origin: string, credentialId = [...this.creds.keys()][0]) {
    const c = this.creds.get(credentialId)!;
    c.counter += 1;
    const authData = Buffer.concat([sha256(opts.rpId ?? c.rpId), Buffer.from([this.flags(0x05)]), u32(c.counter)]);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: opts.challenge, origin, crossOrigin: false }));
    const signature = edSign("sha256", Buffer.concat([authData, sha256(clientDataJSON)]), c.key);
    return {
      id: credentialId, rawId: credentialId, type: "public-key" as const, clientExtensionResults: {},
      response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(signature), userHandle: c.userHandle },
    };
  }
}
