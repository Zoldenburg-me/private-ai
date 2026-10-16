"use client";
import { useState } from "react";
import { TIERS, type Tier, type TierId } from "@/lib/tiers";
import type { Usage } from "./UsageMeter";
import { CreditCard, Devices, DownloadSimple, Fingerprint, LockSimple, SignIn, SignOut, Trash, UploadSimple, UserCirclePlus, WarningCircle } from "@phosphor-icons/react";

export interface Billing { configured: boolean; plans?: { plan: string; interval: string; available: boolean }[]; subscription: { tier: string; status: string } | null }
export interface PasskeyInfo { id: string; label: string; createdAt: number }
export interface AccountInfo { signedIn: boolean; id: string }
export interface DeviceInfo { id: string; createdAt: number; lastSeenOn: string; current: boolean }

export function SettingsView(p: {
  tier: Tier | null; usage: Usage | null; billing: Billing | null; passkeys: PasskeyInfo[]; ghost: boolean;
  account: AccountInfo | null; devices: DeviceInfo[]; onSignOut: () => void; onRemoveDevice: (id: string) => void;
  onCheckout: (plan: "pro" | "max", interval: "month" | "year") => void; onPortal: () => void;
  onAddPasskey: () => void; onLoginPasskey: () => void; onRemovePasskey: (id: string) => void;
  onExportAccount: () => void; onDeleteAccount: () => void;
  onExport: (pass: string) => void; onImport: (f: File, pass: string) => void; onWipe: () => void;
}) {
  const [pass, setPass] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmWipe, setConfirmWipe] = useState(false);
  const available = (plan: string, interval: string) => (p.billing?.plans ?? []).some((x) => x.plan === plan && x.interval === interval && x.available);
  const active = p.billing?.subscription && ["active", "trialing", "past_due"].includes(p.billing.subscription.status);
  return (
    <div className="page" data-testid="settings-view">
      <h1>Settings</h1>

      <section className="panel">
        <h2><CreditCard aria-hidden />Plan &amp; usage</h2>
        <div className="plans">
          {(Object.keys(TIERS) as TierId[]).map((id) => {
            const t = TIERS[id]; const cur = p.tier?.id === id;
            return (
              <div key={id} className={`plan-card ${cur ? "on" : ""}`} data-testid={`plan-${id}`}>
                <div className="row between"><b>{t.name}</b>{cur && <span className="tag t-current">current</span>}</div>
                <div className="price">€{t.priceEurMonth}<span className="small muted">/mo</span></div>
                <ul className="plain small">
                  <li>{id === "max" ? "Unlimited (fair use)" : `${t.dailyMessages.toLocaleString()} messages/day`}</li>
                  <li>{t.maxContextTokens >= 1e6 ? "1M" : `${t.maxContextTokens / 1000}k`} context</li>
                  <li>{id === "free" ? "Basic models" : "All models"}</li>
                </ul>
                {!cur && id !== "free" && p.billing?.configured && !active && (
                  <div className="row gap">
                    {available(id, "month") && <button type="button" className="btn primary" onClick={() => p.onCheckout(id as "pro" | "max", "month")}>Monthly</button>}
                    {available(id, "year") && <button type="button" className="btn" onClick={() => p.onCheckout(id as "pro" | "max", "year")}>Yearly</button>}
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
        <h2><Fingerprint aria-hidden />Account</h2>
        {p.account?.signedIn ? (<>
          <div className="row between wrap gap">
            <p className="account-status" data-testid="account-status"><span className="tag tone-ok">Signed in</span><span className="muted">Account <code>{p.account.id}</code></span></p>
            <button type="button" className="btn" data-testid="sign-out" onClick={p.onSignOut}><SignOut aria-hidden />Sign out</button>
          </div>
          <p className="small muted">Your plan, usage and passkeys belong to this account on every device you sign in to. No email needed. Signing out keeps your chats in this browser.</p>

          <h3>Passkeys</h3>
          <ul className="plain small">
            {p.passkeys.map((k) => (
              <li key={k.id} className="passkey"><Fingerprint aria-hidden />{k.label}… <span className="muted">added {new Date(k.createdAt).toLocaleDateString()}</span>{" "}
                <button type="button" className="icon-btn" aria-label="Remove passkey" data-testid="passkey-remove" onClick={() => p.onRemovePasskey(k.id)}><Trash aria-hidden /></button></li>
            ))}
          </ul>
          {!p.passkeys.length && <p className="tip"><WarningCircle aria-hidden />No passkey left: add one, or you cannot sign in again after signing out.</p>}
          <button type="button" className="btn" data-testid="passkey-add" onClick={p.onAddPasskey}><Fingerprint aria-hidden />Add another passkey</button>

          <h3>Signed-in devices</h3>
          <ul className="plain small" data-testid="devices">
            {p.devices.map((d) => (
              <li key={d.id} className="passkey"><Devices aria-hidden />Device {d.id.slice(0, 6)}…
                <span className="muted">added {new Date(d.createdAt).toLocaleDateString()} · last used {new Date(`${d.lastSeenOn}T00:00:00`).toLocaleDateString()}</span>
                {d.current && <span className="tag t-current">this device</span>}
                <button type="button" className="icon-btn" aria-label={d.current ? "Sign out this device" : `Sign out device ${d.id.slice(0, 6)}`} data-testid="device-remove"
                  onClick={() => p.onRemoveDevice(d.id)}><Trash aria-hidden /></button></li>
            ))}
          </ul>
          <p className="small muted">Devices have no names: we never store your browser, model or location.</p>
        </>) : (<>
          <p className="account-status" data-testid="account-status"><span className="tag tone-muted">Not signed in</span></p>
          <p className="small muted">Your plan and usage are tied to this browser. Create an account with a passkey to keep them on every device. No email, no password.</p>
          <div className="row gap wrap">
            <button type="button" className="btn primary" data-testid="passkey-add" onClick={p.onAddPasskey}><UserCirclePlus aria-hidden />Create account</button>
            <button type="button" className="btn" data-testid="passkey-login" onClick={p.onLoginPasskey}><SignIn aria-hidden />Sign in with a passkey</button>
          </div>
          {p.billing?.subscription && <p className="tip"><WarningCircle aria-hidden />Tip: create an account so you can restore your plan on other devices.</p>}
        </>)}
        <h3>Your server-side data</h3>
        <div className="row gap wrap">
          <button type="button" className="btn" data-testid="account-export" onClick={p.onExportAccount}><DownloadSimple aria-hidden />Download my data</button>
          {confirmDelete
            ? <><button type="button" className="btn danger" data-testid="account-delete-confirm" autoFocus onClick={() => { setConfirmDelete(false); p.onDeleteAccount(); }}>Really delete account</button>
                <button type="button" className="btn ghost" onClick={() => setConfirmDelete(false)}>Cancel</button></>
            : <button type="button" className="btn danger" data-testid="account-delete" onClick={() => setConfirmDelete(true)}>Delete account</button>}
        </div>
      </section>

      <section className="panel">
        <h2><LockSimple aria-hidden />Privacy &amp; data</h2>
        <ul className="plain small">
          <li>Chats and personas are stored only in this browser, encrypted with AES-256-GCM. The key is non-extractable and kept in this browser&apos;s IndexedDB.</li>
          <li>Our server relays your messages to the NEAR AI enclave and never stores or logs their content. It does see them in transit.</li>
          <li><a href="/privacy/metadata">What the server stores</a> (metadata only).</li>
        </ul>
        {p.ghost ? <p className="small muted">Backup and wipe are hidden in ghost chat.</p> : (<>
          <h3>Encrypted backup</h3>
          <div className="row gap wrap">
            <label className="field"><span>Backup passphrase</span><input data-testid="passphrase" type="password" minLength={8} autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} /><small>At least 8 characters. Without it the backup cannot be opened.</small></label>
            <button type="button" className="btn" data-testid="export" onClick={() => p.onExport(pass)}><DownloadSimple aria-hidden />Export</button>
            <label className="btn"><UploadSimple aria-hidden />Import<input data-testid="import" type="file" accept="application/json" className="sr-only" onChange={(e) => e.target.files?.[0] && p.onImport(e.target.files[0], pass)} /></label>
          </div>
          <h3 className="danger-h"><WarningCircle aria-hidden />Danger zone</h3>
          {confirmWipe
            ? <div className="row gap wrap">
                <button type="button" className="btn danger" data-testid="wipe-confirm" autoFocus onClick={() => { setConfirmWipe(false); p.onWipe(); }}><Trash aria-hidden />Really wipe all chats</button>
                <button type="button" className="btn ghost" onClick={() => setConfirmWipe(false)}>Cancel</button>
              </div>
            : <button type="button" className="btn danger" data-testid="wipe" onClick={() => setConfirmWipe(true)}><Trash aria-hidden />Wipe all chats from this browser</button>}
        </>)}
      </section>
    </div>
  );
}
