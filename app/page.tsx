"use client";
import { useEffect, useState } from "react";
import { loadChats, saveChat, deleteChat, wipeAll, replaceChats, type Chat } from "@/lib/storage";
import { persist, type PersistMode } from "@/lib/persist";
import { loadPersonas, savePersona, deletePersona, replacePersonas, type Persona } from "@/lib/personas";
import { parseSseChunk, type Receipt } from "@/lib/sse";
import { encryptBackup, decryptBackup, type BackupFile } from "@/lib/backup";
import { newNonce, verifyReport, verifySignedResponse, type VerifyResult, type AttestationReport } from "@/lib/attestation";
import type { ModelEntry } from "@/lib/catalog";
import type { Tier } from "@/lib/tiers";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { SafeMarkdown } from "@/components/markdown";
import { ChatScope } from "@/lib/chat-scope";

type Msg = Chat["messages"][number] & { signed?: "ok" | "fail" | "n/a" };
const PLAN_LABELS: Record<string, string> = { "pro:month": "Pro €15/mo", "pro:year": "Pro yearly", "max:month": "Max €49/mo", "max:year": "Max yearly" };
const newChat = (): Chat => ({ id: crypto.randomUUID(), title: "New chat", messages: [], updatedAt: Date.now() });
const badgeColor: Record<string, string> = { tee: "#1f7a4d", private: "#2b5ea8", anonymized: "#7a1f1f", e2ee: "#6b3fa0" };
const Badge = ({ t }: { t: string }) => <span data-testid={`badge-${t}`} style={{ background: badgeColor[t] ?? "#444", borderRadius: 4, padding: "1px 6px", fontSize: 11, marginLeft: 4 }}>{t.toUpperCase()}</span>;

export default function Home() {
  const [chats, setChats] = useState<Chat[]>([]);
  const [chat, setChat] = useState<Chat>(newChat);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [tier, setTier] = useState<Tier | null>(null);
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [modelRef, setModelRef] = useState("");
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [personaId, setPersonaId] = useState("");
  const [att, setAtt] = useState<{ ref: string; result: VerifyResult } | null>(null);
  const [notice, setNotice] = useState("");
  const [limits, setLimits] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [pName, setPName] = useState("");
  const [pPrompt, setPPrompt] = useState("");
  const [passkeys, setPasskeys] = useState<{ id: string; label: string; createdAt: number }[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Ghost chat: the conversation lives only in React state; persist() refuses every write.
  const [ghost, setGhost] = useState(false);
  const [billing, setBilling] = useState<{ configured: boolean; plans?: { plan: string; interval: string; available: boolean }[]; subscription: { tier: string; status: string } | null } | null>(null);
  const [scope] = useState(() => new ChatScope());
  /** Every chat switch goes through here so a running reply cannot follow into the next chat. */
  function openChat(next: Chat, nextGhost = ghost) { scope.switch(); setGhost(nextGhost); setChat(next); }

  useEffect(() => {
    setChats(loadChats(localStorage)); setPersonas(loadPersonas(localStorage));
    refreshSession();
    fetch("/api/models").then((r) => r.json()).then((m: ModelEntry[]) => {
      setModels(m); const first = m.find((x) => x.selectable); if (first) setModelRef(`${first.provider}:${first.id}`);
    }).catch(() => {});
  }, []);

  function refreshSession() {
    fetch("/api/session").then((r) => r.json()).then((s) => {
      setTier(s.tier); if (s.usage) setLimits(`${s.usage.remainingToday} left today`);
      fetch("/api/billing").then((r) => r.json()).then(setBilling).catch(() => {});
      return fetch("/api/auth/passkey").then((r) => r.json()).then((p) => setPasskeys(p.passkeys ?? []));
    }).catch(() => {});
  }

  /** Stripe-hosted checkout / portal; we never see card data. */
  async function goBilling(path: string, body: object = {}) {
    try {
      const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error?.message ?? `HTTP ${r.status}`);
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

  /** Passkey = optional upgrade of this anonymous account; no email or username. */
  async function addPasskey() {
    try {
      const o = await withStepUp(() => fetch("/api/auth/passkey/register/options", { method: "POST" }));
      if (!o.ok) throw new Error((await o.json()).error?.message ?? `HTTP ${o.status}`);
      const att = await startRegistration({ optionsJSON: await o.json() });
      const v = await fetch("/api/auth/passkey/register/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(att) });
      if (!v.ok) throw new Error((await v.json()).error?.message ?? `HTTP ${v.status}`);
      setNotice("Passkey saved. Use it to restore your plan on other devices."); refreshSession();
    } catch (e) { setNotice(`Passkey: ${(e as Error).message}`); }
  }
  async function loginPasskey(stepUp = false): Promise<boolean> {
    try {
      const o = await fetch("/api/auth/passkey/login/options", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stepUp }) });
      if (!o.ok) throw new Error(`HTTP ${o.status}`);
      const asr = await startAuthentication({ optionsJSON: await o.json() });
      const v = await fetch("/api/auth/passkey/login/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(asr) });
      if (!v.ok) throw new Error((await v.json()).error?.message ?? `HTTP ${v.status}`);
      if (!stepUp) { setNotice("Logged in with passkey"); refreshSession(); }
      return true;
    } catch (e) { setNotice(`Passkey: ${(e as Error).message}`); return false; }
  }
  async function removePasskey(id: string) {
    const r = await withStepUp(() => fetch("/api/auth/passkey", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) }));
    if (r.ok) { setNotice("Passkey removed"); refreshSession(); } else setNotice(`Passkey: ${await errorOf(r)}`);
  }

  /** GDPR Art. 15/20: everything the server holds for this account, as a JSON file. */
  async function downloadAccountData() {
    const r = await fetch("/api/account/export");
    if (!r.ok) { setNotice(`Export: ${await errorOf(r)}`); return; }
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement("a"); a.href = url; a.download = "private-ai-account.json"; a.click();
    URL.revokeObjectURL(url);
  }
  /** GDPR Art. 17: deletes the server-side account and its Stripe customer. Local chats stay until wiped. */
  async function deleteAccount() {
    setConfirmDelete(false);
    const r = await withStepUp(() => fetch("/api/account", { method: "DELETE" }));
    if (!r.ok) { setNotice(`Delete: ${await errorOf(r)}`); return; }
    setNotice("Account deleted on the server. Chats in this browser are kept until you wipe them.");
    setBilling(null); setPasskeys([]); refreshSession();
  }

  async function verifyEnclave(ref = modelRef): Promise<VerifyResult | null> {
    if (!ref) return null;
    const nonce = newNonce();
    const r = await fetch(`/api/attestation?model=${encodeURIComponent(ref)}&nonce=${nonce}`);
    if (!r.ok) { setNotice("Attestation unavailable for this provider"); return null; }
    const j = (await r.json()) as { gateway_attestation?: AttestationReport; model_attestations?: AttestationReport[] } & AttestationReport;
    const reports = [j.gateway_attestation, ...(j.model_attestations ?? [])].filter(Boolean) as AttestationReport[];
    if (!reports.length && j.intel_quote) reports.push(j);
    const results = reports.map((rep) => verifyReport(rep, nonce));
    const ok = results.length > 0 && results.every((x) => x.ok);
    const result: VerifyResult = { ok, checks: results.flatMap((x) => x.checks), signingAddress: results[results.length - 1]?.signingAddress, chainVerified: false };
    setAtt({ ref, result }); return result;
  }

  async function verifySignature(receipt: Receipt): Promise<"ok" | "fail" | "n/a"> {
    const ref = `${receipt.provider}:${receipt.model}`;
    const a = att?.ref === ref ? att.result : await verifyEnclave(ref);
    if (!a?.ok || !a.signingAddress || !receipt.chat_id) return "n/a";
    const r = await fetch(`/api/signature?model=${encodeURIComponent(ref)}&chat_id=${encodeURIComponent(receipt.chat_id)}`);
    if (!r.ok) return "n/a";
    const sig = await r.json();
    return verifySignedResponse(sig, a.signingAddress, { reqSha256: receipt.req_sha256, respSha256: receipt.resp_sha256 }).ok ? "ok" : "fail";
  }

  async function send() {
    if (!input.trim() || busy || !modelRef) return;
    const mode: PersistMode = { ghost }; // fixed for this turn, even if the toggle changes mid-stream
    const turn = scope.begin(); // updates after a chat switch are dropped; the stream is aborted
    const show = (c: Chat) => { if (turn.current()) setChat(c); };
    const persona = personas.find((p) => p.id === personaId);
    const history = chat.messages.map(({ role, content }) => ({ role, content }));
    const messages = [...history, { role: "user" as const, content: input }];
    let current: Chat = { ...chat, title: chat.messages.length ? chat.title : input.slice(0, 40), messages: [...messages, { role: "assistant", content: "" }], updatedAt: Date.now() };
    setChat(current); setInput(""); setBusy(true); setNotice("");
    let receipt: Receipt | undefined;
    try {
      const res = await fetch("/api/chat", { signal: turn.signal, method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: modelRef, stream: true, messages, ...(persona ? { pai_options: { persona: { name: persona.name, system_prompt: persona.systemPrompt } } } : {}) }) });
      setLimits(`${res.headers.get("x-usage-remaining-daily") ?? "?"} left today`);
      if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({})))?.error?.message || `HTTP ${res.status}`);
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = ""; let text = "";
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        const p = parseSseChunk(buf + dec.decode(value, { stream: true })); buf = p.rest; text += p.deltas.join(""); if (p.receipt) receipt = p.receipt;
        current = { ...current, messages: [...messages, { role: "assistant", content: text }] }; show(current);
      }
      const p = parseSseChunk(buf + "\n"); if (p.receipt) receipt = p.receipt;
    } catch (e) {
      // Aborted by a chat switch: keep what streamed so far, no error text.
      if (!turn.signal.aborted) { current = { ...current, messages: [...messages, { role: "assistant", content: `⚠️ ${(e as Error).message}` }] }; show(current); }
    } finally {
      setBusy(false);
      const saved = persist(localStorage, mode, (w) => saveChat(w, current)); if (saved) setChats(saved);
    }
    if (receipt) {
      const signed = await verifySignature(receipt).catch(() => "n/a" as const);
      const msgs = [...current.messages] as Msg[]; msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], signed };
      current = { ...current, messages: msgs }; show(current);
      const saved = persist(localStorage, mode, (w) => saveChat(w, current)); if (saved) setChats(saved);
    }
  }

  async function exportBackup() {
    const pass = passphrase;
    try {
      const file = await encryptBackup({ chats: loadChats(localStorage), personas: loadPersonas(localStorage) }, pass);
      const check = await decryptBackup<{ chats: Chat[] }>(file, pass); // prove it opens before handing it out
      const url = URL.createObjectURL(new Blob([JSON.stringify(file)], { type: "application/json" }));
      const a = document.createElement("a"); a.href = url; a.download = `private-ai-backup-${new Date().toISOString().slice(0, 10)}.json`; a.click(); URL.revokeObjectURL(url);
      setNotice(`Encrypted backup exported and verified (${check.chats.length} chats)`);
    } catch (e) { setNotice((e as Error).message); }
  }
  async function importBackup(f: File) {
    const pass = passphrase; if (!pass) { setNotice("Enter the backup passphrase first"); return; }
    try {
      const data = await decryptBackup<{ chats: Chat[]; personas: Persona[] }>(JSON.parse(await f.text()) as BackupFile, pass);
      const ok = persist(localStorage, { ghost }, (w) => { replaceChats(w, data.chats ?? []); replacePersonas(w, data.personas ?? []); return true; });
      if (!ok) { setNotice("Leave ghost chat to restore a backup"); return; }
      setChats(loadChats(localStorage)); setPersonas(loadPersonas(localStorage)); setNotice("Backup restored");
    } catch (e) { setNotice((e as Error).message); }
  }
  function addPersona() {
    try {
      const next = persist(localStorage, { ghost }, (w) => savePersona(w, { id: crypto.randomUUID(), name: pName, systemPrompt: pPrompt, createdAt: Date.now() }));
      if (next) { setPersonas(next); setPName(""); setPPrompt(""); }
    } catch (e) { setNotice((e as Error).message); }
  }

  const sel = models.find((m) => `${m.provider}:${m.id}` === modelRef);
  return (
    <main style={{ display: "flex", height: "100vh" }}>
      <aside style={{ width: 260, borderRight: "1px solid #222", padding: 12, overflowY: "auto", fontSize: 14 }}>
        <button onClick={() => openChat(newChat())}>+ New chat</button>
        <button data-testid="ghost-toggle" aria-pressed={ghost} onClick={() => openChat(newChat(), !ghost)} style={{ marginLeft: 4 }}>
          {ghost ? "Leave ghost chat" : "👻 Ghost chat"}
        </button>
        {ghost
          ? <p data-testid="ghost-note" style={{ fontSize: 12, color: "#c4b5fd" }}>Ghost chat: kept only in this tab, never saved. History, personas and backup are hidden.</p>
          : <><p style={{ fontSize: 12, opacity: 0.7 }}>History is stored only in this browser.</p>
        {chats.map((c) => (
          <div key={c.id} style={{ display: "flex", gap: 4, margin: "6px 0" }}>
            <a style={{ flex: 1, cursor: "pointer" }} onClick={() => openChat(c, false)}>{c.title}</a>
            <button aria-label="delete chat" onClick={() => { const n = persist(localStorage, { ghost }, (w) => deleteChat(w, c.id)); if (n) setChats(n); }}>×</button>
          </div>
        ))}
        <hr />
        <b>Personas</b> <small>(private, local)</small>
        {personas.map((p) => <div key={p.id}>{p.name} <button aria-label="delete persona" onClick={() => { const n = persist(localStorage, { ghost }, (w) => deletePersona(w, p.id)); if (n) setPersonas(n); }}>×</button></div>)}
        <input data-testid="persona-name" placeholder="Persona name" value={pName} onChange={(e) => setPName(e.target.value)} style={{ width: "100%" }} />
        <textarea data-testid="persona-prompt" placeholder="System prompt (stays in this browser)" value={pPrompt} onChange={(e) => setPPrompt(e.target.value)} style={{ width: "100%" }} />
        <button data-testid="persona-add" onClick={addPersona}>+ Persona</button>
        <hr />
        <input data-testid="passphrase" type="password" placeholder="Backup passphrase (min 8)" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} style={{ width: "100%" }} />
        <button data-testid="export" onClick={exportBackup}>Export encrypted backup</button>
        <label style={{ display: "block", marginTop: 6 }}>Import: <input data-testid="import" type="file" accept="application/json" onChange={(e) => e.target.files?.[0] && importBackup(e.target.files[0])} /></label>
        </>}
        <hr />
        <b>Account</b> <small>(no email needed)</small>
        <div style={{ fontSize: 12, opacity: 0.8 }}>{passkeys.length ? `${passkeys.length} passkey(s) on this account` : "Anonymous: plan is tied to this browser"}</div>
        {passkeys.map((p) => (
          <div key={p.id} style={{ fontSize: 12 }}>🔑 {p.label}… <small>{new Date(p.createdAt).toLocaleDateString()}</small>{" "}
            <button aria-label="remove passkey" data-testid="passkey-remove" onClick={() => removePasskey(p.id)}>×</button></div>
        ))}
        <button data-testid="passkey-add" onClick={addPasskey}>{passkeys.length ? "Add another passkey" : "Save account with a passkey"}</button>
        <button data-testid="passkey-login" onClick={() => loginPasskey()}>Log in with a passkey</button>
        {billing?.configured && (billing.subscription && ["active", "trialing", "past_due"].includes(billing.subscription.status)
          ? <div><button data-testid="billing-portal" onClick={() => goBilling("/api/billing/portal")}>Manage subscription</button></div>
          : <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
              {(billing.plans ?? []).filter((p) => p.available).map((p) => (
                <button key={`${p.plan}:${p.interval}`} onClick={() => goBilling("/api/billing/checkout", { plan: p.plan, interval: p.interval })}>
                  {PLAN_LABELS[`${p.plan}:${p.interval}`] ?? `${p.plan} ${p.interval}`}
                </button>
              ))}
            </div>)}
        <div style={{ marginTop: 6 }}>
          <button data-testid="account-export" onClick={downloadAccountData}>Download my data</button>
          {confirmDelete
            ? <><button data-testid="account-delete-confirm" onClick={deleteAccount} style={{ color: "#f87171" }}>Really delete account</button>
                <button onClick={() => setConfirmDelete(false)}>Cancel</button></>
            : <button data-testid="account-delete" onClick={() => setConfirmDelete(true)}>Delete account</button>}
        </div>
        {!passkeys.length && billing?.subscription && <div style={{ fontSize: 11, color: "#facc15" }}>Tip: save a passkey so you can restore your plan on other devices.</div>}
        {!ghost && <><hr />
        <button style={{ marginTop: 6 }} onClick={() => { if (persist(localStorage, { ghost }, (w) => { wipeAll(w); return true; })) { setChats([]); openChat(newChat()); } }}>Wipe all chats</button></>}
      </aside>
      <section style={{ flex: 1, display: "flex", flexDirection: "column", padding: 16 }}>
        <header style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center", flexWrap: "wrap" }}>
          <select data-testid="model" value={modelRef} onChange={(e) => { setModelRef(e.target.value); setAtt(null); }}>
            {models.map((m) => (
              <option key={`${m.provider}:${m.id}`} value={`${m.provider}:${m.id}`} disabled={!m.selectable}>
                {m.name} · {m.provider} · {m.privacy.toUpperCase()}{m.e2ee ? " · E2EE" : ""}{m.selectable ? "" : " (blocked by privacy policy)"}
              </option>
            ))}
          </select>
          {sel && <><Badge t={sel.privacy} />{sel.e2ee && <Badge t="e2ee" />}</>}
          <select value={personaId} onChange={(e) => setPersonaId(e.target.value)}>
            <option value="">No persona</option>
            {personas.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <button data-testid="verify" onClick={() => verifyEnclave()}>Verify enclave</button>
          {att?.ref === modelRef && (att.result.ok
            ? <span data-testid="verified" title={att.result.checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.name}`).join("\n") + "\n(Intel/NVIDIA certificate chain: not yet verified locally)"} style={{ color: "#4ade80" }}>✓ Verified enclave</span>
            : <span data-testid="not-verified" title={att.result.checks.filter((c) => !c.ok).map((c) => c.name).join(", ")} style={{ color: "#f87171" }}>✗ Enclave check failed</span>)}
          <span style={{ marginLeft: "auto", fontSize: 12, opacity: 0.8 }}>{tier ? `${tier.name} plan` : ""} {limits}</span>
        </header>
        {ghost && <div data-testid="ghost-badge" style={{ fontSize: 12, background: "#3b2a5a", borderRadius: 4, padding: "2px 8px", marginBottom: 6 }}>👻 Ghost chat · not saved anywhere · gone on reload</div>}
        {notice && <div data-testid="notice" style={{ fontSize: 12, color: "#facc15" }}>{notice}</div>}
        <div style={{ flex: 1, overflowY: "auto" }} data-testid="messages">
          {(chat.messages as Msg[]).map((m, i) => (
            <div key={i} data-role={m.role} style={{ margin: "10px 0" }}>
              <b>{m.role === "user" ? "You" : "AI"}:</b>
              {m.role === "assistant"
                ? <div className="md"><SafeMarkdown text={m.content} /></div>
                : <span style={{ whiteSpace: "pre-wrap" }}> {m.content}</span>}
              {m.signed === "ok" && <span data-testid="signed" style={{ color: "#4ade80", fontSize: 11 }}> ✓ signed by enclave</span>}
              {m.signed === "fail" && <span style={{ color: "#f87171", fontSize: 11 }}> ✗ signature mismatch</span>}
            </div>
          ))}
        </div>
        <form onSubmit={(e) => { e.preventDefault(); send(); }} style={{ display: "flex", gap: 8 }}>
          <input data-testid="prompt" style={{ flex: 1, padding: 8 }} value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask privately…" />
          <button data-testid="send" disabled={busy || !modelRef}>Send</button>
        </form>
      </section>
    </main>
  );
}
