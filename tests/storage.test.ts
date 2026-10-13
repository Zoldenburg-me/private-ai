import { describe, it, expect } from "vitest";
import { loadChats, saveChat, deleteChat, wipeAll, type KV } from "../lib/storage";
import { parseSseChunk } from "../lib/sse";
const mem = (): KV => { const m = new Map<string, string>(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) }; };
describe("local storage", () => {
  it("saves, sorts, deletes, wipes", () => {
    const kv = mem();
    saveChat(kv, { id: "a", title: "A", messages: [], updatedAt: 1 });
    saveChat(kv, { id: "b", title: "B", messages: [], updatedAt: 2 });
    expect(loadChats(kv).map((c) => c.id)).toEqual(["b", "a"]);
    expect(deleteChat(kv, "b").map((c) => c.id)).toEqual(["a"]);
    wipeAll(kv); expect(loadChats(kv)).toEqual([]);
  });
});
describe("sse", () => {
  it("parses deltas and keeps partial", () => {
    const r = parseSseChunk('data: {"choices":[{"delta":{"content":"He"}}]}\ndata: {"choices":[{"delta":{"content":"y"}}]}\ndata: [DONE]\ndata: {"cho');
    expect(r.deltas.join("")).toBe("Hey"); expect(r.done).toBe(true); expect(r.rest).toBe('data: {"cho');
  });
});
