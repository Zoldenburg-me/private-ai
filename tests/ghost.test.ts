import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { persist } from "../lib/persist";
import { loadChats, saveChat, deleteChat, wipeAll, replaceChats, type Chat, type KV } from "../lib/storage";
import { savePersona, deletePersona, replacePersonas } from "../lib/personas";

const spyKV = () => {
  const m = new Map<string, string>(); const writes: string[] = [];
  const kv: KV = {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => { writes.push(`set ${k}`); m.set(k, v); },
    removeItem: (k) => { writes.push(`remove ${k}`); m.delete(k); },
  };
  return { kv, writes, m };
};
const chat: Chat = { id: "g1", title: "secret ghost chat", messages: [{ role: "user", content: "GHOST-CONTENT-123" }], updatedAt: 1 };

describe("ghost chat: one persistence gate", () => {
  it("ghost mode performs zero storage writes for every write operation", () => {
    const { kv, writes, m } = spyKV();
    const ghost = { ghost: true };
    const ops = [
      persist(kv, ghost, (w) => saveChat(w, chat)),
      persist(kv, ghost, (w) => deleteChat(w, "g1")),
      persist(kv, ghost, (w) => replaceChats(w, [chat])),
      persist(kv, ghost, (w) => wipeAll(w)),
      persist(kv, ghost, (w) => savePersona(w, { id: "p", name: "P", systemPrompt: "x", createdAt: 1 })),
      persist(kv, ghost, (w) => deletePersona(w, "p")),
      persist(kv, ghost, (w) => replacePersonas(w, [])),
    ];
    expect(ops.every((r) => r === undefined)).toBe(true);
    expect(writes).toEqual([]);
    expect(m.size).toBe(0);
    expect(loadChats(kv)).toEqual([]);
  });

  it("normal mode writes through the same gate", () => {
    const { kv, writes, m } = spyKV();
    expect(persist(kv, { ghost: false }, (w) => saveChat(w, chat))).toHaveLength(1);
    expect(writes).toEqual(["set pai.chats.v1"]);
    expect([...m.values()].join("")).toContain("GHOST-CONTENT-123");
  });

  it("writers cannot be called with raw storage (type-level gate)", () => {
    const { kv } = spyKV();
    // @ts-expect-error a plain KV/localStorage is not a Writer; only persist() hands one out
    expect(() => saveChat(kv, chat)).not.toThrow();
  });

  it("no code path writes browser storage outside the gated writers", () => {
    const root = join(__dirname, "..");
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => {
      const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
    });
    const offenders: string[] = [];
    for (const f of [...walk(join(root, "app")), ...walk(join(root, "lib"))]) {
      const rel = relative(root, f).split("\\").join("/");
      const src = readFileSync(f, "utf8");
      if (rel === "lib/client/vault.ts") {
        // The encrypted KV *underneath* the gate: it may only write to the KV it wraps (`backing`, which
        // receives what a Writer hands the vault, plus the plaintext->ciphertext migration) and may only
        // open IndexedDB for its key. Anything else is checked like every other file.
        for (const m of src.matchAll(/([\w.]+)\.(setItem|removeItem|clear)\s*\(/g)) {
          if (!["backing", "this.backing"].includes(m[1])) offenders.push(`${rel}: storage write outside the wrapped KV (${m[0]})`);
        }
        if (/\.clear\s*\(/.test(src)) offenders.push(`${rel}: clears storage`);
        if (/\b(sessionStorage|document\.cookie\s*=)/.test(src) || /\bindexedDB\b(?!\.open\()/.test(src)) offenders.push(`${rel}: other browser storage`);
        if (/\blocalStorage\s*[.[]/.test(src)) offenders.push(`${rel}: uses localStorage directly`);
      } else if (rel === "lib/client/ui-prefs.ts") {
        // UI preferences (sidebar collapsed, privacy mode), never content: exactly these localStorage keys, nothing else.
        const writes = [...src.matchAll(/([\w.]+)\.(setItem|removeItem|clear)\s*\(([^,)]*)/g)];
        if (writes.some((m) => !["localStorage.setItem(SIDEBAR_KEY", "localStorage.setItem(MODE_KEY"].includes(m[0]))) offenders.push(`${rel}: writes something other than SIDEBAR_KEY or MODE_KEY`);
        for (const k of ["SIDEBAR_KEY", "MODE_KEY"]) if (!new RegExp(`export const ${k} = "pai\\.ui\\.[\\w-]+";`).test(src)) offenders.push(`${rel}: ${k} is not a pai.ui.* literal`);
        if (/\b(sessionStorage|indexedDB|document\.cookie\s*=)/.test(src)) offenders.push(`${rel}: other browser storage`);
      } else {
        // Only the gated writer modules may call setItem/removeItem, and only on a Writer.
        if (/\.(setItem|removeItem|clear)\s*\(/.test(src) && !["lib/storage.ts", "lib/personas.ts"].includes(rel)) offenders.push(`${rel}: direct storage write`);
        if (/\b(sessionStorage|indexedDB|document\.cookie\s*=)/.test(src)) offenders.push(`${rel}: other browser storage`);
      }
      if (rel === "lib/persist.ts") continue;
      if (/as\s+Writer\b/.test(src)) offenders.push(`${rel}: forges a Writer`);
    }
    expect(offenders).toEqual([]);
    for (const rel of ["lib/storage.ts", "lib/personas.ts"]) {
      const src = readFileSync(join(root, rel), "utf8");
      for (const m of src.matchAll(/export function (\w+)\((\w+): (\w+)/g)) {
        if (/^(save|delete|wipe|replace)/.test(m[1])) expect(`${rel}:${m[1]}:${m[3]}`).toBe(`${rel}:${m[1]}:Writer`);
      }
    }
  });
});
