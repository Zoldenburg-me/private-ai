import type { KV } from "@/lib/storage";

/**
 * Encrypted-at-rest local history. Wraps localStorage: values for the managed keys are stored as
 * "enc1:" + base64(iv || AES-256-GCM ciphertext). The AES key is generated in the browser as a
 * NON-EXTRACTABLE CryptoKey and kept in IndexedDB, so it never appears as bytes in JS or storage.
 * Reads are served from a decrypted in-memory copy (sync, as lib/storage.ts expects);
 * writes update memory immediately and are encrypted to storage asynchronously: flush() awaits them
 * (and rejects while a key's latest write failed), pending() counts them, onError reports each failure.
 * Removals are synchronous. reload() picks up another tab's change so a stale tab cannot overwrite it.
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
  /** Keys whose latest write failed and has not been superseded by a successful write, removal or reload. */
  private failed = new Map<string, Error>();
  /** Per-key change counter, so an async reload() never overrides a local change made meanwhile. */
  private gen = new Map<string, number>();
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
    this.mem.set(k, val); this.bump(k);
    this.enqueue(k, async () => {
      const ct = await encryptString(this.key, val);
      if (this.mem.get(k) !== val) return; // a newer write, a removal or another tab's change wins
      this.backing.setItem(k, ct); this.failed.delete(k);
    });
  }
  removeItem(k: string): void {
    if (this.managed.includes(k)) { this.mem.set(k, null); this.bump(k); this.failed.delete(k); }
    this.backing.removeItem(k);
  }
  /**
   * Another tab changed storage: re-read key k so this tab's copy (and its next write) builds on that change
   * instead of overwriting it. Resolves true if the in-memory value changed.
   */
  async reload(k: string): Promise<boolean> {
    if (!this.managed.includes(k)) return false;
    const g = this.bump(k);
    const raw = this.backing.getItem(k);
    let val: string | null = null;
    if (raw != null) {
      if (!raw.startsWith(PREFIX)) return false;
      try { val = await decryptString(this.key, raw); } catch { return false; }
    }
    if (this.gen.get(k) !== g || this.mem.get(k) === val) return false; // a local change made meanwhile wins
    this.mem.set(k, val); this.failed.delete(k);
    return true;
  }
  /** Resolves when every write queued so far reached storage; rejects while a key's latest write failed. */
  async flush(): Promise<void> {
    await Promise.allSettled([...this.outstanding]);
    if (this.failed.size) {
      const [first] = this.failed.values();
      throw new Error(`Not saved to encrypted history (${[...this.failed.keys()].join(", ")}): ${first.message}`);
    }
  }
  /** Number of writes not yet in storage, including failed ones (used to warn before the page unloads). */
  pending(): number { return this.outstanding.size + this.failed.size; }

  private bump(k: string): number { const g = (this.gen.get(k) ?? 0) + 1; this.gen.set(k, g); return g; }
  private enqueue(k: string, write: () => Promise<void>) {
    const op = this.tail.then(write);
    this.outstanding.add(op);
    // A failed write is reported and remembered, and must not block the writes queued after it.
    this.tail = op
      .catch((e: unknown) => {
        const err = e instanceof Error ? e : new Error(String(e));
        this.failed.set(k, err); this.onError?.(err);
      })
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
