import type { KV } from "./storage";

/** Private-by-default personas: stored only in this browser. Sharing = explicit export by the user. */
export interface Persona { id: string; name: string; systemPrompt: string; createdAt: number }
const KEY = "pai.personas.v1";

export function loadPersonas(kv: KV): Persona[] {
  try { return JSON.parse(kv.getItem(KEY) || "[]") as Persona[]; } catch { return []; }
}
export function savePersona(kv: KV, p: Persona): Persona[] {
  if (!p.name.trim() || !p.systemPrompt.trim()) throw new Error("name and prompt required");
  const next = [p, ...loadPersonas(kv).filter((x) => x.id !== p.id)];
  kv.setItem(KEY, JSON.stringify(next)); return next;
}
export function deletePersona(kv: KV, id: string): Persona[] {
  const next = loadPersonas(kv).filter((x) => x.id !== id); kv.setItem(KEY, JSON.stringify(next)); return next;
}
export function replacePersonas(kv: KV, list: Persona[]) { kv.setItem(KEY, JSON.stringify(list)); }
