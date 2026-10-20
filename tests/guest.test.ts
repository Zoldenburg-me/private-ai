import { describe, it, expect } from "vitest";
import { openHistory, readHandoff } from "../lib/client/guest";
import { MANAGED, type KeyStore } from "../lib/client/vault";
import type { KV } from "../lib/storage";
import { SIDEBAR_KEY } from "../lib/client/ui-prefs";
import { DATA_INVENTORY } from "../lib/data-inventory";

const spyKV = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init)); const writes: string[] = [];
  const kv: KV = {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => { writes.push(`set ${k}`); m.set(k, v); },
    removeItem: (k) => { writes.push(`remove ${k}`); m.delete(k); },
  };
  return { kv, writes };
};
const spyKeys = () => {
  const calls: string[] = []; let key: CryptoKey | undefined;
  const keys: KeyStore = {
    get: async () => { calls.push("get"); return key; },
    add: async (c) => { calls.push("add"); key = c; return c; },
  };
  return { keys, calls };
};

describe("signed-out visitor: ghost chat writes nothing", () => {
  it("no account and no history: no vault, no key in IndexedDB, no localStorage write", async () => {
    const { kv, writes } = spyKV(); const { keys, calls } = spyKeys();
    expect(await openHistory(kv, keys, false)).toBeNull();
    expect(calls).toEqual([]); // the key store (IndexedDB) is never even opened
    expect(writes).toEqual([]);
  });

  it("signed in: the vault opens and creates its key", async () => {
    const { kv } = spyKV(); const { keys, calls } = spyKeys();
    expect(await openHistory(kv, keys, true)).not.toBeNull();
    expect(calls).toEqual(["get", "add"]);
  });

  it("signed out but this browser already has history: it stays reachable", async () => {
    const { kv } = spyKV({ [MANAGED[0]]: "[]" }); const { keys } = spyKeys();
    expect(await openHistory(kv, keys, false)).not.toBeNull();
  });
});

describe("sidebar preference", () => {
  it("is listed in the data inventory (DE + EN)", () => {
    const f = DATA_INVENTORY.find((x) => x.store === "browser" && x.container.includes(SIDEBAR_KEY));
    expect(f?.en && f.de).toBeTruthy();
  });
});

describe("homepage hand-off: /chat?ghost=1#q=<prompt>", () => {
  it("reads ghost from the query and the prompt from the fragment", () => {
    expect(readHandoff({ search: "?ghost=1", hash: `#q=${encodeURIComponent("Hi & bye + 100% ü")}` }))
      .toEqual({ ghost: true, prompt: "Hi & bye + 100% ü" });
  });

  it("no hand-off: normal start, no prompt", () => {
    expect(readHandoff({ search: "", hash: "" })).toEqual({ ghost: false, prompt: "" });
    expect(readHandoff({ search: "?ghost=0", hash: "#q=%20%20" })).toEqual({ ghost: false, prompt: "" });
  });

  it("a prompt in the query string is ignored: it must never travel to the server in a URL", () => {
    expect(readHandoff({ search: "?ghost=1&q=secret", hash: "" })).toEqual({ ghost: true, prompt: "" });
  });

  it("malformed percent-encoding does not throw", () => {
    expect(readHandoff({ search: "", hash: "#q=%E0%A4%A" }).prompt).toBeTypeOf("string");
  });
});
