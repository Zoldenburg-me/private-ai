import { describe, it, expect } from "vitest";
import { Vault, PREFIX, type KeyStore } from "@/lib/client/vault";
import type { KV } from "@/lib/storage";
import { loadChats, saveChat } from "@/lib/storage";
import { persist } from "@/lib/persist";

const mem = (): KV & { m: Map<string, string> } => { const m = new Map<string, string>(); return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) }; };
const keys = (): KeyStore => { let k: CryptoKey | undefined; return { get: async () => k, put: async (x) => { k = x; } }; };

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
});
