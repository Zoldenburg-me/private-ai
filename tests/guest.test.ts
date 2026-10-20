import { describe, it, expect } from "vitest";
import { openHistory, readHandoff, inviteLink, withInvite } from "../lib/client/guest";
import { MANAGED, type KeyStore } from "../lib/client/vault";
import type { KV } from "../lib/storage";
import { SIDEBAR_KEY, sidebarHidden } from "../lib/client/ui-prefs";
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

describe("sidebar visibility on wide screens", () => {
  const wide = { narrow: false, cramped: false, drawer: false, collapsed: false };
  it("1025-1279px: an open proof drawer takes the sidebar's place so the header fits", () => {
    expect(sidebarHidden({ ...wide, cramped: true, drawer: true })).toBe(true);
    expect(sidebarHidden({ ...wide, cramped: true, drawer: false })).toBe(false);
  });
  it("1280px and up: the sidebar stays next to the drawer unless the user collapsed it", () => {
    expect(sidebarHidden({ ...wide, drawer: true })).toBe(false);
    expect(sidebarHidden({ ...wide, drawer: true, collapsed: true })).toBe(true);
  });
  it("narrow screens use the off-canvas drawer instead", () => {
    expect(sidebarHidden({ ...wide, narrow: true, cramped: true, drawer: true })).toBe(false);
    expect(sidebarHidden({ ...wide, narrow: true, collapsed: true })).toBe(false); // the desktop preference does not apply
  });
});

describe("homepage hand-off: /chat?ghost=1#q=<prompt>", () => {
  it("reads ghost from the query and the prompt from the fragment", () => {
    expect(readHandoff({ search: "?ghost=1", hash: `#q=${encodeURIComponent("Hi & bye + 100% ü")}` }))
      .toEqual({ ghost: true, prompt: "Hi & bye + 100% ü", invite: "" });
  });

  it("no hand-off: normal start, no prompt", () => {
    expect(readHandoff({ search: "", hash: "" })).toEqual({ ghost: false, prompt: "", invite: "" });
    expect(readHandoff({ search: "?ghost=0", hash: "#q=%20%20" })).toEqual({ ghost: false, prompt: "", invite: "" });
  });

  it("a prompt in the query string is ignored: it must never travel to the server in a URL", () => {
    expect(readHandoff({ search: "?ghost=1&q=secret", hash: "" })).toEqual({ ghost: true, prompt: "", invite: "" });
  });

  it("malformed percent-encoding does not throw", () => {
    expect(readHandoff({ search: "", hash: "#q=%E0%A4%A" }).prompt).toBe("\uFFFD%A"); // replacement char, no exception
  });
});

describe("invite link: /chat#invite=<code>", () => {
  it("reads the code from the fragment, alone or next to a hand-off prompt", () => {
    expect(readHandoff({ search: "", hash: "#invite=Ab-c_9" }).invite).toBe("Ab-c_9");
    expect(readHandoff({ search: "?ghost=1", hash: "#q=hi&invite=%20Ab-c_9%20" })).toEqual({ ghost: true, prompt: "hi", invite: "Ab-c_9" });
  });

  it("an invite in the query string is ignored: codes never travel to the server in a URL", () => {
    expect(readHandoff({ search: "?invite=secret", hash: "" }).invite).toBe("");
  });

  it("malformed or oversized fragments do not throw and give no code", () => {
    expect(readHandoff({ search: "", hash: "#invite=%E0%A4%A" }).invite).toBe("\uFFFD%A");
    expect(readHandoff({ search: "", hash: `#invite=${"x".repeat(129)}` }).invite).toBe(""); // the server accepts at most 128
    expect(readHandoff({ search: "", hash: `#invite=${"x".repeat(128)}` }).invite).toBe("x".repeat(128));
  });

  it("the admin link round-trips any code through the fragment", () => {
    const code = "a+b/c=d&e";
    const url = new URL(inviteLink("https://hiddensee.app", code));
    expect(url.pathname).toBe("/chat");
    expect(url.search).toBe("");
    expect(readHandoff({ search: url.search, hash: url.hash }).invite).toBe(code);
  });
});

describe("signup with an invite link", () => {
  const required = (message = "invite code required") => Response.json({ error: { message, code: "invite_required" } }, { status: 403 });
  const ok = () => Response.json({ challenge: "c" });
  const fake = (answers: Response[]) => {
    const sent: (string | undefined)[] = []; const asked: string[] = [];
    return {
      sent, asked,
      send: async (invite?: string) => { sent.push(invite); return answers.shift()!; },
      ask: (reply: string | null) => (m: string) => { asked.push(m); return reply; },
    };
  };

  it("uses the held code automatically: no prompt", async () => {
    const f = fake([ok()]);
    expect((await withInvite(f.send, "Ab-c_9", f.ask("unused")))?.ok).toBe(true);
    expect(f.sent).toEqual(["Ab-c_9"]);
    expect(f.asked).toEqual([]);
  });

  it("a rejected code falls back to the prompt with a clear message", async () => {
    const f = fake([required("invalid invite code"), ok()]);
    expect((await withInvite(f.send, "used-up", f.ask("typed")))?.ok).toBe(true);
    expect(f.sent).toEqual(["used-up", "typed"]);
    expect(f.asked).toHaveLength(1);
    expect(f.asked[0]).toMatch(/invite link.*not accepted/i);
  });

  it("a rejected link code is forgotten, so a retry does not send it again", async () => {
    let forgotten = 0;
    const f = fake([required("invalid invite code"), ok()]);
    await withInvite(f.send, "used-up", f.ask(null), () => forgotten++);
    expect(forgotten).toBe(1);
    const g = fake([ok()]);
    await withInvite(g.send, "Ab-c_9", g.ask("unused"), () => forgotten++);
    expect(forgotten).toBe(1); // an accepted code is kept until the account exists
  });

  it("no link: asks for the code as before; cancelling gives null", async () => {
    const f = fake([required()]);
    expect(await withInvite(f.send, "", f.ask(null))).toBeNull();
    expect(f.sent).toEqual([undefined]);
    expect(f.asked).toEqual(["Invite code"]);
    const g = fake([required(), ok()]);
    expect(await withInvite(g.send, "", g.ask("   "))).toBeNull(); // an empty answer is a cancel, not a failed guess
    const h = fake([required(), ok()]);
    await withInvite(h.send, "", h.ask(" typed "));
    expect(h.sent).toEqual([undefined, "typed"]);
  });

  it("not gated (or already signed in): one request, no prompt", async () => {
    const f = fake([ok()]);
    await withInvite(f.send, "", f.ask("unused"));
    expect(f.asked).toEqual([]);
  });
});
