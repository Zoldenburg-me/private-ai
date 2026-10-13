"use client";
import { useEffect, useRef, useState } from "react";
import { loadChats, saveChat, deleteChat, wipeAll, type Chat } from "@/lib/storage";
import { parseSseChunk } from "@/lib/sse";
import { TIERS, type TierId } from "@/lib/tiers";

const newChat = (): Chat => ({ id: crypto.randomUUID(), title: "New chat", messages: [], updatedAt: Date.now() });

export default function Home() {
  const [chats, setChats] = useState<Chat[]>([]);
  const [chat, setChat] = useState<Chat>(newChat);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [tier, setTier] = useState<TierId>("free");
  const [providers, setProviders] = useState<{ id: string; name: string; privacy: string }[]>([]);
  const [provider, setProvider] = useState<string>("");
  const used = useRef(0);

  useEffect(() => { setChats(loadChats(localStorage)); fetch("/api/providers").then((r) => r.json()).then(setProviders).catch(() => {}); }, []);

  async function send() {
    if (!input.trim() || busy) return;
    const messages = [...chat.messages, { role: "user" as const, content: input }];
    let current: Chat = { ...chat, title: chat.messages.length ? chat.title : input.slice(0, 40), messages: [...messages, { role: "assistant", content: "" }], updatedAt: Date.now() };
    setChat(current); setInput(""); setBusy(true);
    try {
      const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages, tier, provider: provider || undefined, usedToday: used.current }) });
      if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      used.current++;
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = ""; let text = "";
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        const parsed = parseSseChunk(buf + dec.decode(value, { stream: true })); buf = parsed.rest;
        text += parsed.deltas.join("");
        current = { ...current, messages: [...messages, { role: "assistant", content: text }] }; setChat(current);
      }
    } catch (e) {
      current = { ...current, messages: [...messages, { role: "assistant", content: `⚠️ ${(e as Error).message}` }] }; setChat(current);
    } finally { setBusy(false); setChats(saveChat(localStorage, current)); }
  }

  return (
    <main style={{ display: "flex", height: "100vh" }}>
      <aside style={{ width: 240, borderRight: "1px solid #222", padding: 12, overflowY: "auto" }}>
        <button onClick={() => setChat(newChat())}>+ New chat</button>
        <p style={{ fontSize: 12, opacity: 0.7 }}>History is stored only in this browser.</p>
        {chats.map((c) => (
          <div key={c.id} style={{ display: "flex", gap: 4, margin: "6px 0" }}>
            <a style={{ flex: 1, cursor: "pointer" }} onClick={() => setChat(c)}>{c.title}</a>
            <button aria-label="delete" onClick={() => setChats(deleteChat(localStorage, c.id))}>×</button>
          </div>
        ))}
        <button onClick={() => { wipeAll(localStorage); setChats([]); setChat(newChat()); }}>Wipe all</button>
      </aside>
      <section style={{ flex: 1, display: "flex", flexDirection: "column", padding: 16 }}>
        <header style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <select value={provider} onChange={(e) => setProvider(e.target.value)}>
            <option value="">Default provider</option>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.privacy})</option>)}
          </select>
          <select value={tier} onChange={(e) => setTier(e.target.value as TierId)}>
            {Object.values(TIERS).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </header>
        <div style={{ flex: 1, overflowY: "auto", whiteSpace: "pre-wrap" }}>
          {chat.messages.map((m, i) => <p key={i}><b>{m.role === "user" ? "You" : "AI"}:</b> {m.content}</p>)}
        </div>
        <form onSubmit={(e) => { e.preventDefault(); send(); }} style={{ display: "flex", gap: 8 }}>
          <input style={{ flex: 1, padding: 8 }} value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask privately…" />
          <button disabled={busy}>Send</button>
        </form>
      </section>
    </main>
  );
}
