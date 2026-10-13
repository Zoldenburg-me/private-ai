import type { ChatMessage } from "./providers";

export interface Chat { id: string; title: string; messages: ChatMessage[]; updatedAt: number }
export interface KV { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

const KEY = "pai.chats.v1";

/** Local-first history: lives only in the browser (localStorage). Server never stores chats. */
export function loadChats(kv: KV): Chat[] {
  try { const raw = kv.getItem(KEY); return raw ? (JSON.parse(raw) as Chat[]) : []; } catch { return []; }
}
export function saveChat(kv: KV, chat: Chat): Chat[] {
  const rest = loadChats(kv).filter((c) => c.id !== chat.id);
  const next = [chat, ...rest].sort((a, b) => b.updatedAt - a.updatedAt);
  kv.setItem(KEY, JSON.stringify(next));
  return next;
}
export function deleteChat(kv: KV, id: string): Chat[] {
  const next = loadChats(kv).filter((c) => c.id !== id);
  kv.setItem(KEY, JSON.stringify(next));
  return next;
}
export function wipeAll(kv: KV) { kv.removeItem(KEY); }
