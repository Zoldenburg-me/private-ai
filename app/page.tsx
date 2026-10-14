"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { loadChats, saveChat, deleteChat, wipeAll, replaceChats, type Chat, type KV } from "@/lib/storage";
import { persist } from "@/lib/persist";
import { loadPersonas, savePersona, deletePersona, replacePersonas, type Persona } from "@/lib/personas";
import { encryptBackup, decryptBackup, type BackupFile } from "@/lib/backup";
import { newNonce, verifySignedResponse } from "@/lib/attestation";
import type { ModelEntry } from "@/lib/catalog";
import type { Tier } from "@/lib/tiers";
import type { Receipt } from "@/lib/sse";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { Vault, idbKeyStore } from "@/lib/client/vault";
import { proofFromResponse, LEVEL_LABEL, type Proof } from "@/lib/client/proof";
import { visibleModels, defaultModelRef } from "@/lib/client/providers";
import { ChatThread, type Signed } from "@/components/app/ChatThread";
import { ProofBadge } from "@/components/app/ProofBadge";
import { ProofDrawer } from "@/components/app/ProofDrawer";
import { ModelPicker } from "@/components/app/ModelPicker";
import { PersonaGallery } from "@/components/app/PersonaGallery";
import { SettingsView, type Billing } from "@/components/app/SettingsView";
import { UsageMeter, type Usage } from "@/components/app/UsageMeter";

type View = "chat" | "personas" | "settings";
const newChat = (): Chat => ({ id: crypto.randomUUID(), title: "New chat", messages: [], updatedAt: Date.now() });
const SUGGESTIONS = ["Summarise a document without it leaving the enclave", "Draft a sensitive email for me", "Explain how this app proves privacy"];

export default function Home() {
  const [kv, setKv] = useState<KV | null>(null);
  const [vaultError, setVaultError] = useState("");
  const [view, setView] = useState<View>("chat");
  const [chats, setChats] = useState<Chat[]>([]);
  const [chat, setChat] = useState<Chat>(newChat);
  const [query, setQuery] = useState("");
  const [tier, setTier] = useState<Tier | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [modelRef, setModelRef] = useState("");
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [personaId, setPersonaId] = useState("");
  const [proofs, setProofs] = useState<Record<string, Proof>>({});
  const [drawer, setDrawer] = useState(false);
  const [notice, setNotice] = useState("");
  const [passkeys, setPasskeys] = useState(0);
  const [ghost, setGhost] = useState(false);
  const [billing, setBilling] = useState<Billing | null>(null);

  // Open the encrypted local vault (non-extractable key in IndexedDB); fall back to read-nothing if unavailable.
  useEffect(() => {
    Vault.open(localStorage, idbKeyStore()).then((v) => {
      setKv(v); setChats(loadChats(v)); setPersonas(loadPersonas(v));
    }).catch((e) => setVaultError(`Encrypted storage unavailable (${(e as Error).message}). Use ghost chat.`));
    refreshSession();
    fetch("/api/models").then((r) => r.json()).then((all: ModelEntry[]) => {
      const m = visibleModels(all); setModels(m); setModelRef((cur) => cur || defaultModelRef(m));
    }).catch(() => setNotice("Could not load models"));
  }, []);

  function refreshSession() {
    fetch("/api/session").then((r) => r.json()).then((s) => {
      setTier(s.tier);
      if (s.usage) setUsage({ remaining: s.usage.remainingToday, limit: s.tier?.dailyMessages });
      fetch("/api/billing").then((r) => r.json()).then(setBilling).catch(() => {});
      return fetch("/api/auth/passkey").then((r) => r.json()).then((p) => setPasskeys(p.passkeys?.length ?? 0));
    }).catch(() => {});
  }

  const checkProof = useCallback(async (ref: string): Promise<Proof | null> => {
    if (!ref) return null;
    const nonce = newNonce();
    let proof: Proof;
    try {
      const r = await fetch(`/api/attestation?model=${encodeURIComponent(ref)}&nonce=${nonce}`);
      proof = r.ok ? proofFromResponse(ref, await r.json(), nonce)
        : { modelRef: ref, level: "unavailable", label: LEVEL_LABEL.unavailable, chainVerified: false, checkedAt: Date.now(), reports: [], notVerified: [] };
    } catch {
      proof = { modelRef: ref, level: "unavailable", label: LEVEL_LABEL.unavailable, chainVerified: false, checkedAt: Date.now(), reports: [], notVerified: [] };
    }
    setProofs((p) => ({ ...p, [ref]: proof }));
    return proof;
  }, []);

  useEffect(() => { if (modelRef && !proofs[modelRef]) void checkProof(modelRef); }, [modelRef, proofs, checkProof]);

  const verifySignature = useCallback(async (receipt: Receipt): Promise<Signed> => {
    const ref = `${receipt.provider}:${receipt.model}`;
    const a = proofs[ref] ?? await checkProof(ref);
    if (!a || a.level === "failed" || a.level === "unavailable" || !a.signingAddress || !receipt.chat_id) return "n/a";
    const r = await fetch(`/api/signature?model=${encodeURIComponent(ref)}&chat_id=${encodeURIComponent(receipt.chat_id)}`);
    if (!r.ok) return "n/a";
    return verifySignedResponse(await r.json(), a.signingAddress, { reqSha256: receipt.req_sha256, respSha256: receipt.resp_sha256 }).ok ? "ok" : "fail";
  }, [proofs, checkProof]);

  const onSaved = useCallback((c: Chat, wasGhost: boolean) => {
    setChat(c);
    if (!kv) return;
    const saved = persist(kv, { ghost: wasGhost }, (w) => saveChat(w, c)); if (saved) setChats(saved);
  }, [kv]);

  function startChat(opts: { ghost?: boolean; personaId?: string } = {}) {
    setGhost(!!opts.ghost); if (opts.personaId !== undefined) setPersonaId(opts.personaId);
    setChat(newChat()); setView("chat");
  }

  function addPersona(name: string, systemPrompt: string): boolean {
    if (!kv) return false;
    try {
      const next = persist(kv, { ghost }, (w) => savePersona(w, { id: crypto.randomUUID(), name, systemPrompt, createdAt: Date.now() }));
      if (next) { setPersonas(next); return true; }
      setNotice("Leave ghost chat to save personas"); return false;
    } catch (e) { setNotice((e as Error).message); return false; }
  }
  function removePersona(id: string) {
    if (!kv) return; const n = persist(kv, { ghost }, (w) => deletePersona(w, id)); if (n) setPersonas(n);
  }

  async function exportBackup(pass: string) {
    if (!kv) return;
    try {
      const file = await encryptBackup({ chats: loadChats(kv), personas: loadPersonas(kv) }, pass);
      const check = await decryptBackup<{ chats: Chat[] }>(file, pass);
      const url = URL.createObjectURL(new Blob([JSON.stringify(file)], { type: "application/json" }));
      const a = document.createElement("a"); a.href = url; a.download = `private-ai-backup-${new Date().toISOString().slice(0, 10)}.json`; a.click(); URL.revokeObjectURL(url);
      setNotice(`Encrypted backup exported and verified (${check.chats.length} chats)`);
    } catch (e) { setNotice((e as Error).message); }
  }
  async function importBackup(f: File, pass: string) {
    if (!kv) return;
    if (!pass) { setNotice("Enter the backup passphrase first"); return; }
    try {
      const data = await decryptBackup<{ chats: Chat[]; personas: Persona[] }>(JSON.parse(await f.text()) as BackupFile, pass);
      const ok = persist(kv, { ghost }, (w) => { replaceChats(w, data.chats ?? []); replacePersonas(w, data.personas ?? []); return true; });
      if (!ok) { setNotice("Leave ghost chat to restore a backup"); return; }
      setChats(loadChats(kv)); setPersonas(loadPersonas(kv)); setNotice("Backup restored");
    } catch (e) { setNotice((e as Error).message); }
  }
  function wipe() {
    if (!kv) return;
    if (persist(kv, { ghost }, (w) => { wipeAll(w); return true; })) { setChats([]); setChat(newChat()); setNotice("All chats wiped from this browser"); }
  }
  async function goBilling(path: string, body: object = {}) {
    try {
      const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json(); if (!r.ok) throw new Error(j.error?.message ?? `HTTP ${r.status}`);
      window.location.href = j.url;
    } catch (e) { setNotice(`Billing: ${(e as Error).message}`); }
  }
  async function addPasskey() {
    try {
      const o = await fetch("/api/auth/passkey/register/options", { method: "POST" });
      if (!o.ok) throw new Error((await o.json()).error?.message ?? `HTTP ${o.status}`);
      const att = await startRegistration({ optionsJSON: await o.json() });
      const v = await fetch("/api/auth/passkey/register/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(att) });
      if (!v.ok) throw new Error((await v.json()).error?.message ?? `HTTP ${v.status}`);
      setNotice("Passkey saved. Use it to restore your plan on other devices."); refreshSession();
    } catch (e) { setNotice(`Passkey: ${(e as Error).message}`); }
  }
  async function loginPasskey() {
    try {
      const o = await fetch("/api/auth/passkey/login/options", { method: "POST" });
      if (!o.ok) throw new Error(`HTTP ${o.status}`);
      const asr = await startAuthentication({ optionsJSON: await o.json() });
      const v = await fetch("/api/auth/passkey/login/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(asr) });
      if (!v.ok) throw new Error((await v.json()).error?.message ?? `HTTP ${v.status}`);
      setNotice("Logged in with passkey"); refreshSession();
    } catch (e) { setNotice(`Passkey: ${(e as Error).message}`); }
  }

  const persona = personas.find((p) => p.id === personaId);
  const proof = proofs[modelRef] ?? null;
  const filtered = useMemo(() => chats.filter((c) => c.title.toLowerCase().includes(query.toLowerCase())), [chats, query]);
  const onUsage = useCallback((rem: string | null) => { if (rem != null) setUsage((u) => ({ remaining: Number(rem), limit: u?.limit })); }, []);

  return (
    <div className={`app ${drawer ? "with-drawer" : ""}`}>
      <nav className="rail" aria-label="Main">
        <div className="brand" aria-hidden>◆</div>
        <button type="button" className={`rail-btn ${view === "chat" ? "on" : ""}`} data-testid="nav-chat" onClick={() => setView("chat")} title="Chats">💬</button>
        <button type="button" className={`rail-btn ${view === "personas" ? "on" : ""}`} data-testid="nav-personas" onClick={() => setView("personas")} title="Personas">🧩</button>
        <div className="grow" />
        <button type="button" className={`rail-btn ${view === "settings" ? "on" : ""}`} data-testid="nav-settings" onClick={() => setView("settings")} title="Settings">⚙︎</button>
      </nav>

      <aside className="sidebar">
        <div className="side-head">
          <button type="button" className="btn primary wide" data-testid="new-chat" onClick={() => startChat()}>+ New chat</button>
          <button type="button" className={`btn ghost-btn ${ghost ? "on" : ""}`} data-testid="ghost-toggle" aria-pressed={ghost}
            onClick={() => startChat({ ghost: !ghost })} title="Ghost chat: never saved">👻</button>
        </div>
        <input className="search" placeholder="Search chats" value={query} onChange={(e) => setQuery(e.target.value)} />
        {ghost
          ? <p className="note ghost-note" data-testid="ghost-note">Ghost chat: kept only in this tab, never saved.</p>
          : <p className="note">🔒 History is encrypted and stays in this browser.</p>}
        {vaultError && <p className="note bad">{vaultError}</p>}
        <ul className="sessions" data-testid="sessions">
          {!ghost && filtered.map((c) => (
            <li key={c.id} className={c.id === chat.id ? "on" : ""}>
              <button type="button" className="session" onClick={() => { setGhost(false); setChat(c); setView("chat"); }}>
                <span className="title">{c.title}</span>
                <span className="when">{new Date(c.updatedAt).toLocaleDateString()}</span>
              </button>
              <button type="button" className="icon-btn del" aria-label="Delete chat"
                onClick={() => { if (!kv) return; const n = persist(kv, { ghost }, (w) => deleteChat(w, c.id)); if (n) setChats(n); if (c.id === chat.id) setChat(newChat()); }}>✕</button>
            </li>
          ))}
          {!ghost && !filtered.length && <li className="empty muted">No chats yet</li>}
        </ul>
        <UsageMeter tier={tier} usage={usage} onUpgrade={() => setView("settings")} />
      </aside>

      <main className="main">
        <header className="topbar">
          <ModelPicker models={models} value={modelRef} onChange={(r) => setModelRef(r)} />
          {persona && <span className="chip" data-testid="persona-chip">🧩 {persona.name} <button type="button" className="icon-btn" aria-label="Clear persona" onClick={() => setPersonaId("")}>✕</button></span>}
          {ghost && <span className="chip ghost-chip">👻 Ghost</span>}
          <div className="grow" />
          <ProofBadge proof={proof} onOpen={() => setDrawer(true)} />
        </header>
        {notice && <div className="notice" data-testid="notice" onClick={() => setNotice("")}>{notice}</div>}

        {view === "chat" && (
          kv || ghost
            ? <ChatThread key={chat.id + (ghost ? ":g" : "")} chat={chat} modelRef={modelRef} persona={persona} ghost={ghost}
                onSaved={onSaved} onUsage={onUsage} verifySignature={verifySignature} suggestions={SUGGESTIONS} />
            : <div className="loading muted">Unlocking encrypted history…</div>
        )}
        {view === "personas" && (
          <PersonaGallery personas={personas} disabled={ghost || !kv} onAdd={addPersona} onDelete={removePersona}
            onUse={(id) => startChat({ personaId: id })} />
        )}
        {view === "settings" && (
          <SettingsView tier={tier} usage={usage} billing={billing} passkeys={passkeys} ghost={ghost}
            onCheckout={(plan, interval) => goBilling("/api/billing/checkout", { plan, interval })}
            onPortal={() => goBilling("/api/billing/portal")}
            onAddPasskey={addPasskey} onLoginPasskey={loginPasskey}
            onExport={exportBackup} onImport={importBackup} onWipe={wipe} />
        )}
      </main>

      <ProofDrawer proof={proof} open={drawer} onClose={() => setDrawer(false)} onRecheck={() => void checkProof(modelRef)} />
    </div>
  );
}
