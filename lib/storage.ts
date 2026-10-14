import type { ChatMessage } from "./providers";
import type { Writer } from "./persist";

export interface Chat { id: string; title: string; messages: ChatMessage[]; updatedAt: number }
export interface KV { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }
/** Reads need only this; writes need a Writer from lib/persist.ts (the ghost-mode gate). */
export type KVRead = Pick<KV, "getItem">;

const KEY = "pai.chats.v1";

/** Local-first history: lives only in the browser (localStorage). Server never stores chats. */
export function loadChats(kv: KVRead): Chat[] {
  try { const raw = kv.getItem(KEY); return raw ? (JSON.parse(raw) as Chat[]) : []; } catch { return []; }
}
export function saveChat(kv: Writer, chat: Chat): Chat[] {
  const rest = loadChats(kv).filter((c) => c.id !== chat.id);
  const next = [chat, ...rest].sort((a, b) => b.updatedAt - a.updatedAt);
  kv.setItem(KEY, JSON.stringify(next));
  return next;
}
export function deleteChat(kv: Writer, id: string): Chat[] {
  const next = loadChats(kv).filter((c) => c.id !== id);
  kv.setItem(KEY, JSON.stringify(next));
  return next;
}
export function wipeAll(kv: Writer) { kv.removeItem(KEY); }
export function replaceChats(kv: Writer, chats: Chat[]) { kv.setItem(KEY, JSON.stringify(chats)); }
