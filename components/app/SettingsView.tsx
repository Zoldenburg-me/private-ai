"use client";
import { useState } from "react";
import { TIERS, type Tier, type TierId } from "@/lib/tiers";
import type { Usage } from "./UsageMeter";
import { Devices, DownloadSimple, Fingerprint, IconContext, PlusCircle, SignIn, SignOut, Trash, UploadSimple, UserCirclePlus, WarningCircle } from "@phosphor-icons/react";
import "./settings.css";

export interface Billing { configured: boolean; plans?: { plan: string; interval: string; available: boolean }[]; subscription: { tier: string; status: string; currentPeriodEnd?: number | null } | null }
export interface PasskeyInfo { id: string; label: string; createdAt: number }
export interface AccountInfo { signedIn: boolean; id: string }
export interface DeviceInfo { id: string; createdAt: number; lastSeenOn: string; current: boolean }

const date = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
const dayOf = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });

export function SettingsView(p: {
  tier: Tier | null; usage: Usage | null; billing: Billing | null; passkeys: PasskeyInfo[] | null; ghost: boolean;
  account: AccountInfo | null; devices: DeviceInfo[]; onSignOut: () => void; onRemoveDevice: (id: string) => void;
  onCheckout: (plan: "pro" | "max", interval: "month" | "year") => void; onPortal: () => void;
  onAddPasskey: () => void; onLoginPasskey: () => void; onRemovePasskey: (id: string) => void;
  onExportAccount: () => void; onDeleteAccount: () => void;
  onExport: (pass: string) => void; onImport: (f: File, pass: string) => void; onWipe: () => void;
  /** Tool and picker settings; `available`: this server has web search (/api/session features). */
  tools?: { available: boolean; webSearch: boolean; onWebSearch: (on: boolean) => void; pickProvider: boolean; onPickProvider: (on: boolean) => void };
}) {
  const [pass, setPass] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmWipe, setConfirmWipe] = useState(false);
  const available = (plan: string, interval: string) => (p.billing?.plans ?? []).some((x) => x.plan === plan && x.interval === interval && x.available);
  const sub = p.billing?.subscription;
  const active = sub && ["active", "trialing", "past_due"].includes(sub.status);
  const signedIn = !!p.account?.signedIn;
  const renews = sub?.status === "active" && sub.currentPeriodEnd ? `Renews ${date(sub.currentPeriodEnd)}. ` : "";
  return (
    <IconContext.Provider value={{ weight: "duotone", size: "1em", color: "currentColor", mirrored: false }}>
      <div className="page acct" data-testid="settings-view">
        <div className="acct-inner">
          <div className="acct-head">
            <span className="acct-avatar" aria-hidden>{signedIn ? p.account!.id.charAt(0).toUpperCase() : <UserCirclePlus />}</span>
            <div className="who">
              <h1>Your account</h1>
              {signedIn
                ? <p data-testid="account-status"><code>{p.account!.id}</code> · <em>no email, no password</em></p>
                : <p data-testid="account-status"><em>Not signed in · no email, no password</em></p>}
            </div>
            {signedIn && <button type="button" className="hs-btn" data-testid="sign-out" onClick={p.onSignOut}><SignOut aria-hidden />Sign out</button>}
          </div>

          {!signedIn && (
            <section>
              <p className="acct-p">Your plan and usage are tied to this browser. Create an account with a passkey to keep them on every device.</p>
              <div className="hs-actions">
                <button type="button" className="hs-btn primary" data-testid="passkey-add" onClick={p.onAddPasskey}><UserCirclePlus aria-hidden />Create account</button>
                <button type="button" className="hs-btn" data-testid="passkey-login" onClick={p.onLoginPasskey}><SignIn aria-hidden />Sign in with a passkey</button>
              </div>
              {sub && <p className="hs-warn"><WarningCircle aria-hidden />Create an account so you can restore your plan on other devices.</p>}
            </section>
          )}

          <section>
            <h2>Plan</h2>
            <p className="hs-note">
              {renews}{p.billing?.configured ? "Card details are held by Stripe, never by us. " : ""}
              {p.billing && !p.billing.configured ? "Payments are not configured on this server. " : ""}
              {p.usage ? `${p.usage.remaining} messages left today. ` : ""}Limits are enforced by the server.
            </p>
            <div className="acct-tiers">
              {(Object.keys(TIERS) as TierId[]).map((id) => {
                const t = TIERS[id]; const cur = p.tier?.id === id;
                return (
                  <div key={id} className={`acct-tier${cur ? " on" : ""}`} data-testid={`plan-${id}`}>
                    <div className="top"><span className="name">{t.name}</span>{cur && <span className="hs-tag">current plan</span>}</div>
                    <div className="price">€{t.priceEurMonth}<span> / month</span></div>
                    <ul>
                      <li>{id === "max" ? "High fair-use limit" : `${t.dailyMessages.toLocaleString("en")} messages a day`}</li>
                      <li>{t.maxContextTokens >= 1e6 ? "1M" : `${t.maxContextTokens / 1000}k`} context</li>
                      <li>{id === "free" ? "Basic models" : "All models"}</li>
                    </ul>
                    {!cur && id !== "free" && p.billing?.configured && !active && (
                      <div className="hs-actions">
                        {available(id, "month") && <button type="button" className="hs-btn primary" onClick={() => p.onCheckout(id as "pro" | "max", "month")}>Monthly</button>}
                        {available(id, "year") && <button type="button" className="hs-btn" onClick={() => p.onCheckout(id as "pro" | "max", "year")}>Yearly</button>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {active && <div className="acct-after"><button type="button" className="hs-btn" data-testid="billing-portal" onClick={p.onPortal}>Manage subscription</button></div>}
          </section>

          {signedIn && (<>
            <section>
              <div className="acct-split">
                <h2>Passkeys</h2>
                <button type="button" className="hs-link" data-testid="passkey-add" onClick={p.onAddPasskey}><PlusCircle aria-hidden />Add a passkey</button>
              </div>
              {p.passkeys?.map((k) => (
                <div key={k.id} className="hs-row passkey">
                  <Fingerprint className="acct-row-icon coral" aria-hidden />
                  <span className="grow">{k.label}…<span className="hs-sub">added {date(k.createdAt)}</span></span>
                  <button type="button" className="hs-icon bad" aria-label={`Remove passkey ${k.label}`} data-testid="passkey-remove" onClick={() => p.onRemovePasskey(k.id)}><Trash aria-hidden /></button>
                </div>
              ))}
              {p.passkeys === null && <p className="hs-note">Could not load your passkeys. Reload to try again.</p>}
              {p.passkeys?.length === 0 && <p className="hs-warn"><WarningCircle aria-hidden />No passkey left: add one, or you cannot sign in again after signing out.</p>}
            </section>

            <section data-testid="devices">
              <h2>Signed-in devices</h2>
              <p className="hs-note tight">Devices have no names: we never store your browser, model or location.</p>
              {p.devices.map((d) => (
                <div key={d.id} className="hs-row">
                  <Devices className="acct-row-icon" aria-hidden />
                  <span className="grow">Device {d.id.slice(0, 6)}<span className="hs-sub">added {date(d.createdAt)} · last used {dayOf(d.lastSeenOn)}</span></span>
                  {d.current && <span className="hs-tag">this device</span>}
                  <button type="button" className="hs-icon" aria-label={d.current ? "Sign out this device" : `Sign out device ${d.id.slice(0, 6)}`} data-testid="device-remove"
                    onClick={() => p.onRemoveDevice(d.id)}><SignOut aria-hidden /></button>
                </div>
              ))}
            </section>
          </>)}

          {p.tools && (
            <section data-testid="privacy-tools">
              <h2>Privacy &amp; tools</h2>
              <p className="hs-note tight">Pick the privacy level (Max, Medium, Anon) and the model in the chat bar. These settings apply to every level{p.ghost ? "; in ghost chat they are kept until you leave it" : ""}.</p>
              <label className="hs-row">
                <input type="checkbox" data-testid="setting-web-search" checked={p.tools.available && p.tools.webSearch} disabled={!p.tools.available} onChange={(e) => p.tools!.onWebSearch(e.target.checked)} />
                <span className="grow">Web search
                  <span className="hs-sub">{p.tools.available
                    ? "The model searches the web when a question needs it. Only its search query goes to Brave Search, without your identity or chat: on NEAR models it is sent from inside the model's enclave, on all others by our server. Each search step counts as a message. Off by default in ghost chat."
                    : "Web search is not available on this server."}</span></span>
              </label>
              <label className="hs-row">
                <input type="checkbox" data-testid="setting-pick-provider" checked={p.tools.pickProvider} onChange={(e) => p.tools!.onPickProvider(e.target.checked)} />
                <span className="grow">Pick a provider
                  <span className="hs-sub">Off: you pick a model and we route it (the cheapest enclave whose proof passes on Max). On: the model list also shows each provider.</span></span>
              </label>
            </section>
          )}

          <section>
            <h2>Your data</h2>
            <p className="acct-p">Chats live only in this browser, encrypted with AES-256-GCM. Our server sees your messages in transit but never stores or logs them. Export an encrypted backup to move them, or see <a href="/privacy/metadata">what little the server keeps about you</a>.</p>
            {p.ghost ? <p className="hs-note">Backup and wipe are hidden in ghost chat.</p> : (<>
              <div className="acct-data">
                <label className="hs-field">Backup passphrase
                  <input className="hs-input" data-testid="passphrase" type="password" minLength={8} autoComplete="new-password" placeholder="At least 8 characters" value={pass} onChange={(e) => setPass(e.target.value)} />
                </label>
                <button type="button" className="hs-btn primary tall" data-testid="export" onClick={() => p.onExport(pass)}><DownloadSimple aria-hidden />Export backup</button>
                <label className="hs-btn tall"><UploadSimple aria-hidden />Import<input data-testid="import" type="file" accept="application/json" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) p.onImport(f, pass); }} /></label>
              </div>
              <p className="hs-note">Without the passphrase the backup cannot be opened.</p>
            </>)}
            <div className="acct-mt"><button type="button" className="hs-underline" data-testid="account-export" onClick={p.onExportAccount}>Download my server-side data</button></div>
          </section>

          <section>
            <h2 className="bad">Danger zone</h2>
            <div className="hs-actions">
              {!p.ghost && (confirmWipe
                ? <><button type="button" className="hs-btn danger" data-testid="wipe-confirm" autoFocus onClick={() => { setConfirmWipe(false); p.onWipe(); }}><Trash aria-hidden />Really wipe all chats</button>
                    <button type="button" className="hs-btn" onClick={() => setConfirmWipe(false)}>Cancel</button></>
                : <button type="button" className="hs-btn danger" data-testid="wipe" onClick={() => setConfirmWipe(true)}><Trash aria-hidden />Wipe chats from this browser</button>)}
              {confirmDelete
                ? <><button type="button" className="hs-btn danger" data-testid="account-delete-confirm" autoFocus onClick={() => { setConfirmDelete(false); p.onDeleteAccount(); }}>Really delete account</button>
                    <button type="button" className="hs-btn" onClick={() => setConfirmDelete(false)}>Cancel</button></>
                : <button type="button" className="hs-btn danger" data-testid="account-delete" onClick={() => setConfirmDelete(true)}>Delete account</button>}
            </div>
          </section>
        </div>
      </div>
    </IconContext.Provider>
  );
}
