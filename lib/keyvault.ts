import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM for provider API keys at rest. The key-encryption key comes from ADMIN_KEY_KEK
 * (32 bytes, base64) and is never stored in the database, so a database dump or backup alone
 * does not reveal provider keys. Layout: version (1) | iv (12) | tag (16) | ciphertext.
 * `aad` binds a ciphertext to its row ("<provider>:<key id>"), so rows cannot be swapped.
 */
const VERSION = 1;

/** The KEK, or null if unset. Throws if set but not 32 bytes (assertProductionConfig checks at boot). */
export function kek(env: Record<string, string | undefined> = process.env): Buffer | null {
  const v = env.ADMIN_KEY_KEK;
  if (!v) return null;
  const k = Buffer.from(v, "base64");
  if (k.length !== 32) throw new Error("ADMIN_KEY_KEK must be 32 bytes, base64-encoded");
  return k;
}

export function sealKey(plain: string, aad: string, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv).setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, c.getAuthTag(), ct]);
}

/** Throws on a wrong key, wrong aad or any tampering. */
export function openKey(blob: Uint8Array, aad: string, key: Buffer): string {
  const b = Buffer.from(blob);
  if (b.length < 30 || b[0] !== VERSION) throw new Error("unknown key format");
  const d = createDecipheriv("aes-256-gcm", key, b.subarray(1, 13)).setAAD(Buffer.from(aad, "utf8"));
  d.setAuthTag(b.subarray(13, 29));
  return Buffer.concat([d.update(b.subarray(29)), d.final()]).toString("utf8");
}
