"use client";
import { useEffect, useState } from "react";
import { loadChats, saveChat, deleteChat, wipeAll, replaceChats, type Chat } from "@/lib/storage";
import { loadPersonas, savePersona, deletePersona, replacePersonas, type Persona } from "@/lib/personas";
import { parseSseChunk, type Receipt } from "@/lib/sse";
import { encryptBackup, decryptBackup, type BackupFile } from "@/lib/backup";
import { newNonce, verifyReport, verifySignedResponse, type VerifyResult, type AttestationReport } from "@/lib/attestation";
import type { ModelEntry } from "@/lib/catalog";
import type { Tier } from "@/lib/tiers";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";

type Msg = Chat["messages"][number] & { signed?: "ok" | "fail" | "n/a" };
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
  const [passkeys, setPasskeys] = useState(0);
  const [billing, setBilling] = useState<{ configured: boolean; subscription: { tier: string; status: string } | null } | null>(null);

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
      return fetch("/api/auth/passkey").then((r) => r.json()).then((p) => setPasskeys(p.passkeys?.length ?? 0));
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

  /** Passkey = optional upgrade of this anonymous account; no email or username. */
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
    const persona = personas.find((p) => p.id === personaId);
    const history = chat.messages.map(({ role, content }) => ({ role, content }));
    const messages = [...history, { role: "user" as const, content: input }];
    let current: Chat = { ...chat, title: chat.messages.length ? chat.title : input.slice(0, 40), messages: [...messages, { role: "assistant", content: "" }], updatedAt: Date.now() };
    setChat(current); setInput(""); setBusy(true); setNotice("");
    let receipt: Receipt | undefined;
    try {
      const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: modelRef, stream: true, messages, ...(persona ? { pai_options: { persona: { name: persona.name, system_prompt: persona.systemPrompt } } } : {}) }) });
      setLimits(`${res.headers.get("x-usage-remaining-daily") ?? "?"} left today`);
      if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({})))?.error?.message || `HTTP ${res.status}`);
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = ""; let text = "";
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        const p = parseSseChunk(buf + dec.decode(value, { stream: true })); buf = p.rest; text += p.deltas.join(""); if (p.receipt) receipt = p.receipt;
        current = { ...current, messages: [...messages, { role: "assistant", content: text }] }; setChat(current);
      }
      const p = parseSseChunk(buf + "\n"); if (p.receipt) receipt = p.receipt;
    } catch (e) {
      current = { ...current, messages: [...messages, { role: "assistant", content: `⚠️ ${(e as Error).message}` }] }; setChat(current);
    } finally { setBusy(false); setChats(saveChat(localStorage, current)); }
    if (receipt) {
      const signed = await verifySignature(receipt).catch(() => "n/a" as const);
      const msgs = [...current.messages] as Msg[]; msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], signed };
      current = { ...current, messages: msgs }; setChat(current); setChats(saveChat(localStorage, current));
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
      replaceChats(localStorage, data.chats ?? []); replacePersonas(localStorage, data.personas ?? []);
      setChats(loadChats(localStorage)); setPersonas(loadPersonas(localStorage)); setNotice("Backup restored");
    } catch (e) { setNotice((e as Error).message); }
  }
  function addPersona() {
    try { setPersonas(savePersona(localStorage, { id: crypto.randomUUID(), name: pName, systemPrompt: pPrompt, createdAt: Date.now() })); setPName(""); setPPrompt(""); } catch (e) { setNotice((e as Error).message); }
  }

  const sel = models.find((m) => `${m.provider}:${m.id}` === modelRef);
  return (
    <main style={{ display: "flex", height: "100vh" }}>
      <aside style={{ width: 260, borderRight: "1px solid #222", padding: 12, overflowY: "auto", fontSize: 14 }}>
        <button onClick={() => setChat(newChat())}>+ New chat</button>
        <p style={{ fontSize: 12, opacity: 0.7 }}>History is stored only in this browser.</p>
        {chats.map((c) => (
          <div key={c.id} style={{ display: "flex", gap: 4, margin: "6px 0" }}>
            <a style={{ flex: 1, cursor: "pointer" }} onClick={() => setChat(c)}>{c.title}</a>
            <button aria-label="delete chat" onClick={() => setChats(deleteChat(localStorage, c.id))}>×</button>
          </div>
        ))}
        <hr />
        <b>Personas</b> <small>(private, local)</small>
        {personas.map((p) => <div key={p.id}>{p.name} <button aria-label="delete persona" onClick={() => setPersonas(deletePersona(localStorage, p.id))}>×</button></div>)}
        <input data-testid="persona-name" placeholder="Persona name" value={pName} onChange={(e) => setPName(e.target.value)} style={{ width: "100%" }} />
        <textarea data-testid="persona-prompt" placeholder="System prompt (stays in this browser)" value={pPrompt} onChange={(e) => setPPrompt(e.target.value)} style={{ width: "100%" }} />
        <button data-testid="persona-add" onClick={addPersona}>+ Persona</button>
        <hr />
        <input data-testid="passphrase" type="password" placeholder="Backup passphrase (min 8)" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} style={{ width: "100%" }} />
        <button data-testid="export" onClick={exportBackup}>Export encrypted backup</button>
        <label style={{ display: "block", marginTop: 6 }}>Import: <input data-testid="import" type="file" accept="application/json" onChange={(e) => e.target.files?.[0] && importBackup(e.target.files[0])} /></label>
        <hr />
        <b>Account</b> <small>(no email needed)</small>
        <div style={{ fontSize: 12, opacity: 0.8 }}>{passkeys ? `${passkeys} passkey(s) on this account` : "Anonymous: plan is tied to this browser"}</div>
        <button data-testid="passkey-add" onClick={addPasskey}>Save account with a passkey</button>
        <button data-testid="passkey-login" onClick={loginPasskey}>Log in with a passkey</button>
        {billing?.configured && (billing.subscription && ["active", "trialing", "past_due"].includes(billing.subscription.status)
          ? <div><button data-testid="billing-portal" onClick={() => goBilling("/api/billing/portal")}>Manage subscription</button></div>
          : <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
              <button onClick={() => goBilling("/api/billing/checkout", { plan: "pro", interval: "month" })}>Pro €15/mo</button>
              <button onClick={() => goBilling("/api/billing/checkout", { plan: "pro", interval: "year" })}>Pro yearly</button>
              <button onClick={() => goBilling("/api/billing/checkout", { plan: "max", interval: "month" })}>Max €49/mo</button>
              <button onClick={() => goBilling("/api/billing/checkout", { plan: "max", interval: "year" })}>Max yearly</button>
            </div>)}
        {!passkeys && billing?.subscription && <div style={{ fontSize: 11, color: "#facc15" }}>Tip: save a passkey so you can restore your plan on other devices.</div>}
        <hr />
        <button style={{ marginTop: 6 }} onClick={() => { wipeAll(localStorage); setChats([]); setChat(newChat()); }}>Wipe all chats</button>
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
        {notice && <div data-testid="notice" style={{ fontSize: 12, color: "#facc15" }}>{notice}</div>}
        <div style={{ flex: 1, overflowY: "auto", whiteSpace: "pre-wrap" }} data-testid="messages">
          {(chat.messages as Msg[]).map((m, i) => (
            <p key={i}><b>{m.role === "user" ? "You" : "AI"}:</b> {m.content}
              {m.signed === "ok" && <span data-testid="signed" style={{ color: "#4ade80", fontSize: 11 }}> ✓ signed by enclave</span>}
              {m.signed === "fail" && <span style={{ color: "#f87171", fontSize: 11 }}> ✗ signature mismatch</span>}
            </p>
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
