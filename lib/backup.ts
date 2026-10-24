/** Encrypted local backup: PBKDF2-SHA256 -> AES-256-GCM via WebCrypto. Runs in browser and Node >= 20. */
const enc = new TextEncoder();
const dec = new TextDecoder();
// Chunked: spreading a whole large array into fromCharCode overflows the call stack (RangeError).
const b64 = (u: Uint8Array) => {
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export interface BackupFile { v: 1; kdf: "PBKDF2-SHA256"; iter: number; salt: string; iv: string; ct: string }
export const ITERATIONS = 310_000;

async function key(passphrase: string, salt: BufferSource, iter: number) {
  const base = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function encryptBackup(data: unknown, passphrase: string, iter = ITERATIONS): Promise<BackupFile> {
  if (passphrase.length < 8) throw new Error("passphrase must be at least 8 characters");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(passphrase, salt, iter), enc.encode(JSON.stringify(data))));
  return { v: 1, kdf: "PBKDF2-SHA256", iter, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
}

export async function decryptBackup<T = unknown>(file: BackupFile, passphrase: string): Promise<T> {
  if (file?.v !== 1 || file.kdf !== "PBKDF2-SHA256") throw new Error("unsupported backup format");
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(file.iv) }, await key(passphrase, unb64(file.salt), file.iter), unb64(file.ct));
    return JSON.parse(dec.decode(pt)) as T;
  } catch { throw new Error("wrong passphrase or corrupted backup"); }
}
