"use client";
import { useState } from "react";
import { TIERS, type Tier, type TierId } from "@/lib/tiers";
import type { Usage } from "./UsageMeter";

export interface Billing { configured: boolean; subscription: { tier: string; status: string } | null }

export function SettingsView(p: {
  tier: Tier | null; usage: Usage | null; billing: Billing | null; passkeys: number; ghost: boolean;
  onCheckout: (plan: "pro" | "max", interval: "month" | "year") => void; onPortal: () => void;
  onAddPasskey: () => void; onLoginPasskey: () => void;
  onExport: (pass: string) => void; onImport: (f: File, pass: string) => void; onWipe: () => void;
}) {
  const [pass, setPass] = useState("");
  const active = p.billing?.subscription && ["active", "trialing", "past_due"].includes(p.billing.subscription.status);
  return (
    <div className="page" data-testid="settings-view">
      <h1>Settings</h1>

      <section className="panel">
        <h2>Plan &amp; usage</h2>
        <div className="plans">
          {(Object.keys(TIERS) as TierId[]).map((id) => {
            const t = TIERS[id]; const cur = p.tier?.id === id;
            return (
              <div key={id} className={`plan-card ${cur ? "on" : ""}`} data-testid={`plan-${id}`}>
                <div className="row between"><b>{t.name}</b>{cur && <span className="tag">current</span>}</div>
                <div className="price">€{t.priceEurMonth}<span className="small muted">/mo</span></div>
                <ul className="plain small">
                  <li>{id === "max" ? "Unlimited (fair use)" : `${t.dailyMessages.toLocaleString()} messages/day`}</li>
                  <li>{t.maxContextTokens >= 1e6 ? "1M" : `${t.maxContextTokens / 1000}k`} context</li>
                  <li>{id === "free" ? "Basic models" : "All models"}</li>
                </ul>
                {!cur && id !== "free" && p.billing?.configured && !active && (
                  <div className="row gap">
                    <button type="button" className="btn primary" onClick={() => p.onCheckout(id as "pro" | "max", "month")}>Monthly</button>
                    <button type="button" className="btn" onClick={() => p.onCheckout(id as "pro" | "max", "year")}>Yearly</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {active && <button type="button" className="btn" data-testid="billing-portal" onClick={p.onPortal}>Manage subscription</button>}
        {p.billing && !p.billing.configured && <p className="small muted">Payments are not configured on this server.</p>}
        <p className="small muted">{p.usage ? `${p.usage.remaining} messages left today.` : ""} Limits are enforced by the server; this is a display only.</p>
      </section>

      <section className="panel">
        <h2>Account</h2>
        <p className="small muted">No email needed. {p.passkeys ? `${p.passkeys} passkey(s) on this account.` : "Anonymous: your plan is tied to this browser."}</p>
        <div className="row gap">
          <button type="button" className="btn" data-testid="passkey-add" onClick={p.onAddPasskey}>Save account with a passkey</button>
          <button type="button" className="btn" data-testid="passkey-login" onClick={p.onLoginPasskey}>Log in with a passkey</button>
        </div>
      </section>

      <section className="panel">
        <h2>Privacy &amp; data</h2>
        <ul className="plain small">
          <li>🔒 Chats and personas are stored only in this browser, encrypted with AES-256-GCM. The key is non-extractable and kept in this browser&apos;s IndexedDB.</li>
          <li>Our server relays your messages to the NEAR AI enclave and never stores or logs their content. It does see them in transit.</li>
          <li><a href="/privacy/metadata">What the server stores</a> (metadata only).</li>
        </ul>
        {p.ghost ? <p className="small muted">Backup and wipe are hidden in ghost chat.</p> : (<>
          <h3>Encrypted backup</h3>
          <div className="row gap wrap">
            <input data-testid="passphrase" type="password" placeholder="Backup passphrase (min 8)" value={pass} onChange={(e) => setPass(e.target.value)} />
            <button type="button" className="btn" data-testid="export" onClick={() => p.onExport(pass)}>Export</button>
            <label className="btn">Import<input data-testid="import" type="file" accept="application/json" hidden onChange={(e) => e.target.files?.[0] && p.onImport(e.target.files[0], pass)} /></label>
          </div>
          <h3>Danger zone</h3>
          <button type="button" className="btn danger" data-testid="wipe" onClick={p.onWipe}>Wipe all chats from this browser</button>
        </>)}
      </section>
    </div>
  );
}
