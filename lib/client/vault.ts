import type { KV } from "@/lib/storage";

/**
 * Encrypted-at-rest local history. Wraps localStorage: values for the managed keys are stored as
 * "enc1:" + base64(iv || AES-256-GCM ciphertext). The AES key is generated in the browser as a
 * NON-EXTRACTABLE CryptoKey and kept in IndexedDB, so it never appears as bytes in JS or storage.
 * Reads are served from a decrypted in-memory copy (sync, as lib/storage.ts expects);
 * writes update memory immediately and are encrypted to storage asynchronously: flush() awaits them
 * (and rejects if one fails), pending() counts them, onError reports each failure. Removals are synchronous.
 *
 * Honest scope: protects history from anything that reads localStorage as text (other scripts' dumps,
 * sync/backup tools, casual disk inspection). It does not protect against code running in this origin
 * or a fully compromised device, since the key lives in the same browser profile.
 */
export const PREFIX = "enc1:";
export const MANAGED = ["pai.chats.v1", "pai.personas.v1"];

/** add() stores the candidate only if the slot is empty (atomically) and returns whichever key occupies it. */
export interface KeyStore { get(): Promise<CryptoKey | undefined>; add(candidate: CryptoKey): Promise<CryptoKey> }
export interface VaultOptions { managed?: string[]; onError?: (e: Error) => void }

const b64 = (u: Uint8Array) => { let s = ""; for (const c of u) s += String.fromCharCode(c); return btoa(s); };
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function encryptString(key: CryptoKey, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain)));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
  return PREFIX + b64(out);
}
export async function decryptString(key: CryptoKey, stored: string): Promise<string> {
  const raw = unb64(stored.slice(PREFIX.length));
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12) }, key, raw.slice(12));
  return new TextDecoder().decode(pt);
}

export class Vault implements KV {
  private mem = new Map<string, string | null>();
  private tail: Promise<void> = Promise.resolve();
  private outstanding = new Set<Promise<void>>();
  private constructor(private backing: KV, private key: CryptoKey, private managed: string[], private onError?: (e: Error) => void) {}

  static async open(backing: KV, keys: KeyStore, { managed = MANAGED, onError }: VaultOptions = {}): Promise<Vault> {
    let key = await keys.get();
    if (!key) key = await keys.add(await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]));
    const v = new Vault(backing, key, managed, onError);
    for (const k of managed) {
      const raw = backing.getItem(k);
      if (raw == null) { v.mem.set(k, null); continue; }
      if (raw.startsWith(PREFIX)) {
        try { v.mem.set(k, await decryptString(key, raw)); } catch { v.mem.set(k, null); /* undecryptable (key lost): treat as empty, keep ciphertext untouched */ continue; }
      } else {
        v.mem.set(k, raw); // legacy plaintext: migrate now
        backing.setItem(k, await encryptString(key, raw));
      }
    }
    return v;
  }

  getItem(k: string): string | null {
    return this.managed.includes(k) ? this.mem.get(k) ?? null : this.backing.getItem(k);
  }
  setItem(k: string, val: string): void {
    if (!this.managed.includes(k)) return this.backing.setItem(k, val);
    this.mem.set(k, val);
    this.enqueue(async () => {
      const ct = await encryptString(this.key, val);
      if (this.mem.get(k) === val) this.backing.setItem(k, ct); // a newer write or a removal wins
    });
  }
  removeItem(k: string): void {
    if (this.managed.includes(k)) this.mem.set(k, null);
    this.backing.removeItem(k);
  }
  /** Resolves when every write queued so far reached storage; rejects if one of them failed. */
  async flush(): Promise<void> { await Promise.all([...this.outstanding]); }
  /** Number of writes not yet in storage (used to warn before the page unloads). */
  pending(): number { return this.outstanding.size; }

  private enqueue(write: () => Promise<void>) {
    const op = this.tail.then(write);
    this.outstanding.add(op);
    // A failed write is reported and must not block the writes queued after it.
    this.tail = op
      .catch((e: unknown) => { this.onError?.(e instanceof Error ? e : new Error(String(e))); })
      .finally(() => { this.outstanding.delete(op); });
  }
}

/** IndexedDB key store for the browser (CryptoKey objects are structured-cloneable). */
export function idbKeyStore(dbName = "pai-vault", store = "keys", id = "history-v1"): KeyStore {
  const open = () => new Promise<IDBDatabase>((res, rej) => {
    const r = indexedDB.open(dbName, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(store);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const tx = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) => {
    const db = await open();
    return new Promise<T>((res, rej) => { const q = fn(db.transaction(store, mode).objectStore(store)); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  };
  return {
    get: () => tx<CryptoKey | undefined>("readonly", (s) => s.get(id) as IDBRequest<CryptoKey | undefined>),
    // One readwrite transaction (serialised across tabs): two tabs opening a fresh profile get the same key.
    add: async (candidate) => {
      const db = await open();
      return new Promise<CryptoKey>((res, rej) => {
        const t = db.transaction(store, "readwrite"); const s = t.objectStore(store);
        let key = candidate;
        const q = s.get(id) as IDBRequest<CryptoKey | undefined>;
        q.onsuccess = () => { if (q.result) key = q.result; else s.put(candidate, id); };
        t.oncomplete = () => res(key); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
      });
    },
  };
}
