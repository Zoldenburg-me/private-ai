"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { loadChats, saveChat, deleteChat, wipeAll, replaceChats, type Chat } from "@/lib/storage";
import { persist } from "@/lib/persist";
import { loadPersonas, savePersona, deletePersona, replacePersonas, type Persona } from "@/lib/personas";
import { encryptBackup, decryptBackup, type BackupFile } from "@/lib/backup";
import { newNonce, verifySignedResponse } from "@/lib/attestation";
import type { ModelEntry } from "@/lib/catalog";
import type { Tier } from "@/lib/tiers";
import type { Receipt } from "@/lib/sse";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { Vault, idbKeyStore, MANAGED } from "@/lib/client/vault";
import { proofFromResponse, signatureLevel, LEVEL_LABEL, type Proof } from "@/lib/client/proof";
import { visibleModels, defaultModelRef } from "@/lib/client/providers";
import { ChatThread, type Signed } from "@/components/app/ChatThread";
import { ProofBadge } from "@/components/app/ProofBadge";
import { ProofDrawer } from "@/components/app/ProofDrawer";
import { ModelPicker } from "@/components/app/ModelPicker";
import { PersonaGallery } from "@/components/app/PersonaGallery";
import { SettingsView, type AccountInfo, type Billing, type DeviceInfo } from "@/components/app/SettingsView";
import type { Usage } from "@/components/app/UsageMeter";
import { Sidebar } from "@/components/app/Sidebar";
import { ChatScope } from "@/lib/chat-scope";
import { ChatsCircle, GearSix, Ghost, List, UserFocus, X } from "@phosphor-icons/react";

type View = "chat" | "personas" | "settings";
const newChat = (): Chat => ({ id: crypto.randomUUID(), title: "New chat", messages: [], updatedAt: Date.now() });
const SUGGESTIONS = ["Summarise a document without it leaving the enclave", "Draft a sensitive email for me", "Explain how this app proves privacy"];

export default function Home() {
  const [kv, setKv] = useState<Vault | null>(null);
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
  const [navOpen, setNavOpen] = useState(false); // mobile only: rail + sidebar as a sheet
  const [notice, setNotice] = useState("");
  const [passkeys, setPasskeys] = useState<{ id: string; label: string; createdAt: number }[]>([]);
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [ghost, setGhost] = useState(false);
  const [billing, setBilling] = useState<Billing | null>(null);
  const [sessionReady, setSessionReady] = useState(false); // evidence needs the session cookie
  const [scope] = useState(() => new ChatScope());
  /** Every chat switch goes through here so a running reply cannot follow into the next chat. */
  function openChat(next: Chat, nextGhost = ghost) { scope.switch(); setGhost(nextGhost); setChat(next); }

  // Open the encrypted local vault (non-extractable key in IndexedDB); fall back to read-nothing if unavailable.
  useEffect(() => {
    Vault.open(localStorage, idbKeyStore(), { onError: (e) => setNotice(`Not saved to encrypted history: ${e.message}`) }).then((v) => {
      setKv(v); setChats(loadChats(v)); setPersonas(loadPersonas(v));
    }).catch((e) => setVaultError(`Encrypted storage unavailable (${(e as Error).message}). Use ghost chat.`));
    refreshSession();
    fetch("/api/models").then((r) => r.json()).then((all: ModelEntry[]) => {
      const m = visibleModels(all); setModels(m); setModelRef((cur) => cur || defaultModelRef(m));
    }).catch(() => setNotice("Could not load models"));
  }, []);

  // Vault writes finish asynchronously; warn before a reload or close would drop one.
  useEffect(() => {
    if (!kv) return;
    const onUnload = (e: BeforeUnloadEvent) => { if (kv.pending()) e.preventDefault(); };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [kv]);

  // Another tab changed the encrypted history: adopt it, so this tab's next write cannot undo it (e.g. a deletion).
  useEffect(() => {
    if (!kv) return;
    const onStorage = (e: StorageEvent) => {
      if (e.storageArea !== localStorage) return;
      const keys = e.key === null ? MANAGED : MANAGED.filter((k) => k === e.key);
      void Promise.all(keys.map((k) => kv.reload(k))).then((changed) => {
        if (!changed.some(Boolean)) return;
        const cs = loadChats(kv); setChats(cs); setPersonas(loadPersonas(kv));
        // The open chat was deleted or wiped in the other tab: close it instead of saving it back.
        if (!ghost && chat.messages.length && !cs.some((c) => c.id === chat.id)) { scope.forget(chat.id); openChat(newChat()); }
      });
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  });

  function refreshSession() {
    fetch("/api/session").then((r) => r.json()).then((s) => {
      if (!s.error) setSessionReady(true); // a 429/503 sets no cookie, so evidence would only 401
      setTier(s.tier); setAccount(s.account ?? null);
      if (s.usage) setUsage({ remaining: s.usage.remainingToday, limit: s.tier?.dailyMessages });
      fetch("/api/billing").then((r) => r.json()).then(setBilling).catch(() => {});
      if (s.account?.signedIn) fetch("/api/account/devices").then((r) => r.json()).then((d) => setDevices(d.devices ?? [])).catch(() => {});
      else setDevices([]);
      return fetch("/api/auth/passkey").then((r) => r.json()).then((p) => setPasskeys(p.passkeys ?? []));
    }).catch(() => {});
  }

  const checkProof = useCallback(async (ref: string): Promise<Proof | null> => {
    if (!ref) return null;
    const nonce = newNonce();
    let proof: Proof;
    try {
      const r = await fetch(`/api/attestation?model=${encodeURIComponent(ref)}&nonce=${nonce}`);
      if (r.status === 401) return null; // no session yet: do not cache, the next check retries
      proof = r.ok ? proofFromResponse(ref, await r.json(), nonce)
        : { modelRef: ref, level: "unavailable", label: LEVEL_LABEL.unavailable, chainVerified: false, checkedAt: Date.now(), reports: [], notVerified: [] };
    } catch {
      proof = { modelRef: ref, level: "unavailable", label: LEVEL_LABEL.unavailable, chainVerified: false, checkedAt: Date.now(), reports: [], notVerified: [] };
    }
    setProofs((p) => ({ ...p, [ref]: proof }));
    return proof;
  }, []);

  useEffect(() => { if (sessionReady && modelRef && !proofs[modelRef]) void checkProof(modelRef); }, [sessionReady, modelRef, proofs, checkProof]);

  const verifySignature = useCallback(async (receipt: Receipt): Promise<Signed> => {
    const ref = `${receipt.provider}:${receipt.model}`;
    const a = proofs[ref] ?? await checkProof(ref);
    if (!a || a.level === "failed" || a.level === "unavailable" || !a.signingAddress || !receipt.chat_id) return "n/a";
    const r = await fetch(`/api/signature?model=${encodeURIComponent(ref)}&chat_id=${encodeURIComponent(receipt.chat_id)}`);
    if (!r.ok) return "n/a";
    return signatureLevel(a, verifySignedResponse(await r.json(), a.signingAddress, { reqSha256: receipt.req_sha256, respSha256: receipt.resp_sha256 }).ok);
  }, [proofs, checkProof]);

  const onSaved = useCallback((c: Chat, wasGhost: boolean, isCurrent: boolean) => {
    if (isCurrent) setChat(c);
    if (!kv) return;
    const saved = persist(kv, { ghost: wasGhost }, (w) => saveChat(w, c)); if (saved) setChats(saved);
  }, [kv]);

  function startChat(opts: { ghost?: boolean; personaId?: string } = {}) {
    if (opts.personaId !== undefined) setPersonaId(opts.personaId);
    openChat(newChat(), !!opts.ghost); setView("chat");
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
      // Show what the vault now holds even if one of the two writes failed (flush() names the unsaved key).
      try { await kv.flush(); setNotice("Backup restored"); }
      finally { setChats(loadChats(kv)); setPersonas(loadPersonas(kv)); }
    } catch (e) { setNotice((e as Error).message); }
  }
  async function wipe() {
    if (!kv || ghost) return;
    scope.discardAll(); // a reply still streaming or finishing must not write a wiped chat back
    persist(kv, { ghost }, (w) => wipeAll(w));
    setChats([]); openChat(newChat());
    try { await kv.flush(); setNotice("All chats wiped from this browser"); } catch (e) { setNotice((e as Error).message); }
  }
  async function goBilling(path: string, body: object = {}) {
    try {
      const r = await withStepUp(() => fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
      const j = await r.json(); if (!r.ok) throw new Error(j.error?.message ?? `HTTP ${r.status}`);
      window.location.href = j.url;
    } catch (e) { setNotice(`Billing: ${(e as Error).message}`); }
  }
  const errorOf = async (r: Response) => (await r.json().catch(() => null))?.error?.message ?? `HTTP ${r.status}`;
  /** Sensitive account actions: if the server asks for a fresh passkey login, do it and retry once. */
  async function withStepUp(run: () => Promise<Response>): Promise<Response> {
    const r = await run();
    if (r.status !== 403 || (await r.clone().json().catch(() => null))?.error?.code !== "step_up_required") return r;
    setNotice("Confirm with one of your passkeys");
    return (await loginPasskey(true)) ? run() : r;
  }
  /** The first passkey creates the account (this browser becomes a signed-in device); no email or username. */
  async function addPasskey() {
    try {
      const o = await withStepUp(() => fetch("/api/auth/passkey/register/options", { method: "POST" }));
      if (!o.ok) throw new Error((await o.json()).error?.message ?? `HTTP ${o.status}`);
      const att = await startRegistration({ optionsJSON: await o.json() });
      const v = await fetch("/api/auth/passkey/register/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(att) });
      if (!v.ok) throw new Error((await v.json()).error?.message ?? `HTTP ${v.status}`);
      setNotice(account?.signedIn ? "Passkey added." : "Account created. Sign in with this passkey on your other devices."); refreshSession();
    } catch (e) { setNotice(`Passkey: ${(e as Error).message}`); }
  }
  async function loginPasskey(stepUp = false): Promise<boolean> {
    try {
      const o = await fetch("/api/auth/passkey/login/options", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stepUp }) });
      if (!o.ok) throw new Error(`HTTP ${o.status}`);
      const asr = await startAuthentication({ optionsJSON: await o.json() });
      const v = await fetch("/api/auth/passkey/login/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(asr) });
      if (!v.ok) throw new Error((await v.json()).error?.message ?? `HTTP ${v.status}`);
      if (!stepUp) { setNotice("Signed in"); refreshSession(); }
      return true;
    } catch (e) { setNotice(`Passkey: ${(e as Error).message}`); return false; }
  }
  async function removePasskey(id: string) {
    const r = await withStepUp(() => fetch("/api/auth/passkey", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) }));
    if (r.ok) { setNotice("Passkey removed"); refreshSession(); } else setNotice(`Passkey: ${await errorOf(r)}`);
  }
  /** Revokes this browser's device token server-side. Local chats stay: they were never tied to the account. */
  async function signOut() {
    const r = await fetch("/api/auth/signout", { method: "POST" });
    if (!r.ok) { setNotice(`Sign out: ${await errorOf(r)}`); return; }
    setNotice("Signed out. Chats in this browser are kept.");
    setBilling(null); setPasskeys([]); setDevices([]); refreshSession();
  }
  async function removeDevice(id: string) {
    const r = await withStepUp(() => fetch("/api/account/devices", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) }));
    if (!r.ok) { setNotice(`Device: ${await errorOf(r)}`); return; }
    const wasMe = devices.some((d) => d.id === id && d.current);
    setNotice(wasMe ? "Signed out. Chats in this browser are kept." : "Device signed out.");
    if (wasMe) { setBilling(null); setPasskeys([]); }
    refreshSession();
  }
  /** GDPR Art. 15/20: everything the server holds for this account, as a JSON file. */
  async function downloadAccountData() {
    const r = await withStepUp(() => fetch("/api/account/export"));
    if (!r.ok) { setNotice(`Export: ${await errorOf(r)}`); return; }
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement("a"); a.href = url; a.download = "private-ai-account.json"; a.click();
    URL.revokeObjectURL(url);
  }
  /** GDPR Art. 17: deletes the server-side account and its Stripe customer. Local chats stay until wiped. */
  async function deleteAccount() {
    const r = await withStepUp(() => fetch("/api/account", { method: "DELETE" }));
    if (!r.ok) { setNotice(`Delete: ${await errorOf(r)}`); return; }
    setNotice("Account deleted on the server. Chats in this browser are kept until you wipe them.");
    setBilling(null); setPasskeys([]); setDevices([]); refreshSession();
  }

  const persona = personas.find((p) => p.id === personaId);
  const proof = proofs[modelRef] ?? null;
  const filtered = useMemo(() => chats.filter((c) => c.title.toLowerCase().includes(query.toLowerCase())), [chats, query]);
  const onUsage = useCallback((rem: string | null) => { if (rem != null) setUsage((u) => ({ remaining: Number(rem), limit: u?.limit })); }, []);

  const go = (v: View) => { setView(v); setNavOpen(false); };

  // Below 820px the nav is an off-canvas sheet and the proof drawer a bottom sheet: keep focus out of
  // whatever is hidden or covered, move it into the sheet on open and back to the menu button on close.
  const sheetRef = useRef<HTMLDivElement>(null); const mainRef = useRef<HTMLElement>(null); const menuRef = useRef<HTMLButtonElement>(null);
  const navWasOpen = useRef(false);
  useEffect(() => {
    const mq = matchMedia("(max-width: 820px)");
    const apply = () => {
      if (sheetRef.current) sheetRef.current.inert = mq.matches && !navOpen;
      if (mainRef.current) mainRef.current.inert = mq.matches && (navOpen || drawer);
    };
    apply(); mq.addEventListener("change", apply);
    if (navOpen && mq.matches) sheetRef.current?.querySelector<HTMLElement>(".rail-btn")?.focus();
    if (!navOpen && navWasOpen.current && mq.matches) menuRef.current?.focus();
    navWasOpen.current = navOpen;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && navOpen) setNavOpen(false); };
    addEventListener("keydown", onKey);
    return () => { mq.removeEventListener("change", apply); removeEventListener("keydown", onKey); };
  }, [navOpen, drawer]);
  const NAV = [
    { v: "chat" as const, label: "Chats", Icon: ChatsCircle },
    { v: "personas" as const, label: "Personas", Icon: UserFocus },
  ];
  const navBtn = ({ v, label, Icon }: { v: View; label: string; Icon: typeof ChatsCircle }) => (
    <button key={v} type="button" className={`rail-btn ${view === v ? "on" : ""}`} data-testid={`nav-${v}`} onClick={() => go(v)}
      aria-label={label} aria-current={view === v ? "page" : undefined} title={label}><Icon weight={view === v ? "fill" : "regular"} aria-hidden /></button>
  );

  return (
    <div className={`app ${drawer ? "with-drawer" : ""} ${ghost ? "is-ghost" : ""} ${navOpen ? "nav-open" : ""}`}>
      <div className="nav-sheet" ref={sheetRef}>
        <nav className="rail" aria-label="Main">
          <Link href="/" className="brand" aria-label="Private AI home"><Image src="/brand/narwhal.svg" alt="" width={28} height={15} unoptimized /></Link>
          {NAV.map(navBtn)}
          <div className="grow" />
          {navBtn({ v: "settings", label: "Settings", Icon: GearSix })}
        </nav>
        <Sidebar ghost={ghost} query={query} onQuery={setQuery} chats={filtered} currentId={chat.id} vaultError={vaultError}
          tier={tier} usage={usage} onUpgrade={() => go("settings")} account={account} onAccount={() => go("settings")}
          onNew={() => { startChat(); setNavOpen(false); }}
          onToggleGhost={() => { startChat({ ghost: !ghost }); setNavOpen(false); }}
          onOpen={(c) => { openChat(c, false); go("chat"); }}
          onDelete={(c) => { if (!kv) return; scope.forget(c.id); const n = persist(kv, { ghost }, (w) => deleteChat(w, c.id)); if (n) setChats(n); if (c.id === chat.id) openChat(newChat()); }} />
      </div>
      <button type="button" className="nav-scrim" aria-label="Close menu" tabIndex={navOpen ? 0 : -1} onClick={() => setNavOpen(false)} />

      <main className="main" ref={mainRef}>
        <header className="topbar">
          <button type="button" className="icon-btn menu-btn" ref={menuRef} aria-label="Open menu" aria-expanded={navOpen} onClick={() => setNavOpen(true)}><List aria-hidden /></button>
          <ModelPicker models={models} value={modelRef} onChange={(r) => setModelRef(r)} />
          {persona && <span className="chip" data-testid="persona-chip"><UserFocus aria-hidden />{persona.name}<button type="button" className="chip-x" aria-label="Clear persona" onClick={() => setPersonaId("")}><X aria-hidden /></button></span>}
          {ghost && <span className="chip ghost-chip"><Ghost aria-hidden />Ghost chat</span>}
          <div className="grow" />
          <ProofBadge proof={proof} onOpen={() => setDrawer(true)} />
        </header>
        {/* The live region stays mounted so screen readers announce text added to it. */}
        <div role="status" className="notice-slot">
          {notice && (
            <div className="notice" data-testid="notice">
              <span>{notice}</span>
              <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => setNotice("")}><X aria-hidden /></button>
            </div>
          )}
        </div>

        {view === "chat" && (
          kv || ghost
            ? <ChatThread key={chat.id + (ghost ? ":g" : "")} scope={scope} chat={chat} modelRef={modelRef} persona={persona} ghost={ghost}
                onSaved={onSaved} onUsage={onUsage} verifySignature={verifySignature} suggestions={SUGGESTIONS} />
            : <div className="loading muted">Unlocking encrypted history…</div>
        )}
        {view === "personas" && (
          <PersonaGallery personas={personas} disabled={ghost || !kv} onAdd={addPersona} onDelete={removePersona}
            onUse={(id) => startChat({ personaId: id })} />
        )}
        {view === "settings" && (
          <SettingsView tier={tier} usage={usage} billing={billing} passkeys={passkeys} ghost={ghost}
            account={account} devices={devices} onSignOut={signOut} onRemoveDevice={removeDevice}
            onCheckout={(plan, interval) => goBilling("/api/billing/checkout", { plan, interval })}
            onPortal={() => goBilling("/api/billing/portal")}
            onAddPasskey={addPasskey} onLoginPasskey={() => void loginPasskey()} onRemovePasskey={removePasskey}
            onExportAccount={downloadAccountData} onDeleteAccount={deleteAccount}
            onExport={exportBackup} onImport={importBackup} onWipe={wipe} />
        )}
      </main>

      <ProofDrawer proof={proof} open={drawer} onClose={() => setDrawer(false)} onRecheck={() => void checkProof(modelRef)} />
    </div>
  );
}
