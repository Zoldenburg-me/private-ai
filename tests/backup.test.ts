import { describe, it, expect } from "vitest";
import { encryptBackup, decryptBackup } from "../lib/backup";
import { loadPersonas, savePersona, deletePersona } from "../lib/personas";
import type { Writer } from "../lib/persist";

describe("encrypted backup", () => {
  it("round-trips and hides plaintext", async () => {
    const data = { chats: [{ id: "1", title: "secret plans", messages: [] }] };
    const f = await encryptBackup(data, "correct horse", 1000);
    expect(JSON.stringify(f)).not.toContain("secret plans");
    expect(await decryptBackup(f, "correct horse")).toEqual(data);
  });
  it("fails on wrong passphrase and short passphrase", async () => {
    const f = await encryptBackup({ a: 1 }, "correct horse", 1000);
    await expect(decryptBackup(f, "wrong horse!")).rejects.toThrow(/wrong passphrase/);
    await expect(encryptBackup({}, "short")).rejects.toThrow();
  });
});

describe("personas (local only)", () => {
  it("save / delete / validate", () => {
    const m = new Map<string, string>();
    const kv = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) } as Writer;
    savePersona(kv, { id: "p", name: "Tutor", systemPrompt: "Be a patient tutor", createdAt: 1 });
    expect(loadPersonas(kv)).toHaveLength(1);
    expect(() => savePersona(kv, { id: "q", name: "", systemPrompt: "x", createdAt: 1 })).toThrow();
    expect(deletePersona(kv, "p")).toEqual([]);
  });
});
