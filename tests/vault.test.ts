import { describe, it, expect } from "vitest";
import { Vault, PREFIX, type KeyStore } from "@/lib/client/vault";
import type { KV } from "@/lib/storage";
import { loadChats, saveChat, deleteChat } from "@/lib/storage";
import { persist } from "@/lib/persist";

const mem = (): KV & { m: Map<string, string> } => { const m = new Map<string, string>(); return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) }; };
const keys = (): KeyStore => { let k: CryptoKey | undefined; return { get: async () => k, add: async (x) => (k ??= x) }; };
const chatsKey = "pai.chats.v1";

describe("encrypted local vault", () => {
  it("stores chats only as ciphertext and reads them back", async () => {
    const back = mem(); const ks = keys();
    const v = await Vault.open(back, ks);
    persist(v, { ghost: false }, (w) => saveChat(w, { id: "1", title: "SECRET-TITLE", messages: [{ role: "user", content: "SECRET-BODY" }], updatedAt: 1 }));
    await v.flush();
    const raw = back.getItem("pai.chats.v1")!;
    expect(raw.startsWith(PREFIX)).toBe(true);
    expect(raw).not.toContain("SECRET");
    const v2 = await Vault.open(back, ks);
    expect(loadChats(v2)[0].messages[0].content).toBe("SECRET-BODY");
  });

  it("migrates legacy plaintext and leaves unmanaged keys alone", async () => {
    const back = mem();
    back.setItem("pai.chats.v1", JSON.stringify([{ id: "x", title: "old", messages: [], updatedAt: 1 }]));
    back.setItem("other", "plain");
    const v = await Vault.open(back, keys());
    expect(loadChats(v)[0].title).toBe("old");
    expect(back.getItem("pai.chats.v1")!.startsWith(PREFIX)).toBe(true);
    expect(v.getItem("other")).toBe("plain");
  });

  it("a different key cannot read the history", async () => {
    const back = mem(); const v = await Vault.open(back, keys());
    v.setItem("pai.chats.v1", "[1]"); await v.flush();
    const other = await Vault.open(back, keys());
    expect(other.getItem("pai.chats.v1")).toBeNull();
  });

  it("ghost mode still cannot write through the vault", async () => {
    const back = mem(); const v = await Vault.open(back, keys());
    persist(v, { ghost: true }, (w) => saveChat(w, { id: "g", title: "g", messages: [], updatedAt: 1 }));
    await v.flush();
    expect(back.getItem("pai.chats.v1")).toBeNull();
  });

  it("two tabs opening a fresh profile at once end up with the same key", async () => {
    const back = mem(); const ks = keys();
    const [a, b] = await Promise.all([Vault.open(back, ks), Vault.open(back, ks)]); // both get() see no key
    a.setItem(chatsKey, "[\"from-a\"]"); await a.flush();
    expect((await Vault.open(back, ks)).getItem(chatsKey)).toBe("[\"from-a\"]");
    b.setItem(chatsKey, "[\"from-b\"]"); await b.flush();
    expect((await Vault.open(back, ks)).getItem(chatsKey)).toBe("[\"from-b\"]");
  });

  it("a failed write is reported, flush() rejects, and later writes still reach storage", async () => {
    const back = mem(); const ks = keys(); const errors: string[] = [];
    const v = await Vault.open(back, ks, { onError: (e) => errors.push(e.message) });
    const setItem = back.setItem; let fail = true;
    back.setItem = (k, val) => { if (fail) { fail = false; throw new Error("QuotaExceededError"); } setItem(k, val); };
    v.setItem(chatsKey, "[1]");
    await expect(v.flush()).rejects.toThrow("QuotaExceededError");
    expect(errors).toEqual(["QuotaExceededError"]);
    v.setItem(chatsKey, "[2]");
    await v.flush();
    expect((await Vault.open(back, ks)).getItem(chatsKey)).toBe("[2]");
  });

  it("pending() counts unsaved writes until they reach storage", async () => {
    const back = mem(); const v = await Vault.open(back, keys());
    v.setItem(chatsKey, "[1]"); v.setItem(chatsKey, "[2]");
    expect(v.pending()).toBe(2);
    await v.flush();
    expect(v.pending()).toBe(0);
  });

  it("removal (wipe) is immediate and a queued write cannot bring the data back", async () => {
    const back = mem(); const v = await Vault.open(back, keys());
    v.setItem(chatsKey, "[1]"); await v.flush();
    v.setItem(chatsKey, "[2]");
    v.removeItem(chatsKey);
    expect(back.getItem(chatsKey)).toBeNull();
    await v.flush();
    expect(back.getItem(chatsKey)).toBeNull();
    expect(v.getItem(chatsKey)).toBeNull();
  });

  it("opening already-encrypted history writes nothing to storage", async () => {
    const back = mem(); const ks = keys();
    const v = await Vault.open(back, ks); v.setItem(chatsKey, "[1]"); await v.flush();
    const writes: string[] = []; const setItem = back.setItem;
    back.setItem = (k, val) => { writes.push(k); setItem(k, val); };
    await Vault.open(back, ks);
    expect(writes).toEqual([]);
  });
  it("a failed write keeps flush() rejecting and pending() non-zero until a later write of that key succeeds", async () => {
    const back = mem(); const v = await Vault.open(back, keys(), { onError: () => {} });
    const setItem = back.setItem; let fail = true;
    back.setItem = (k, val) => { if (fail) throw new Error("QuotaExceededError"); setItem(k, val); };
    v.setItem(chatsKey, "[1]");
    await expect(v.flush()).rejects.toThrow("QuotaExceededError");
    await expect(v.flush()).rejects.toThrow(chatsKey); // still unsaved: a second flush must not report success
    expect(v.pending()).toBe(1);
    fail = false; v.setItem(chatsKey, "[2]");
    await v.flush();
    expect(v.pending()).toBe(0);
  });

  it("a stale tab adopts another tab's deletion instead of writing the chat back", async () => {
    const back = mem(); const ks = keys();
    const a = await Vault.open(back, ks);
    persist(a, { ghost: false }, (w) => saveChat(w, { id: "keep", title: "k", messages: [], updatedAt: 1 }));
    persist(a, { ghost: false }, (w) => saveChat(w, { id: "gone", title: "g", messages: [], updatedAt: 2 }));
    await a.flush();
    const b = await Vault.open(back, ks); // second tab, same history
    persist(b, { ghost: false }, (w) => deleteChat(w, "gone")); await b.flush();
    expect(await a.reload(chatsKey)).toBe(true); // the storage event in tab a
    persist(a, { ghost: false }, (w) => saveChat(w, { id: "new", title: "n", messages: [], updatedAt: 3 })); await a.flush();
    expect(loadChats(await Vault.open(back, ks)).map((c) => c.id).sort()).toEqual(["keep", "new"]);
  });

  it("reload() does not override a local change made while it was decrypting", async () => {
    const back = mem(); const ks = keys();
    const a = await Vault.open(back, ks); const b = await Vault.open(back, ks);
    b.setItem(chatsKey, "[\"from-b\"]"); await b.flush();
    const r = a.reload(chatsKey);
    a.setItem(chatsKey, "[\"from-a\"]");
    expect(await r).toBe(false);
    await a.flush();
    expect(a.getItem(chatsKey)).toBe("[\"from-a\"]");
    expect((await Vault.open(back, ks)).getItem(chatsKey)).toBe("[\"from-a\"]");
  });
});
