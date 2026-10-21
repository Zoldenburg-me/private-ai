"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { startAuthentication } from "@simplewebauthn/browser";
import { ClockCounterClockwise, Devices, Fingerprint, IconContext, Key, Link as LinkIcon, MagnifyingGlass, SignOut, Ticket, Trash, Users, WarningCircle } from "@phosphor-icons/react";
import { TIERS } from "@/lib/tiers";
import { DEFS, type PrivacyModel } from "@/lib/providers";
import { inviteLink } from "@/lib/client/guest";
import "../app/settings.css";
import "./admin.css";

/** Operator console. Every call goes to /api/admin/*, which enforces auth, step-up and limits server-side. */
type Tab = "accounts" | "keys" | "invites" | "audit";
interface AccountRow { id: string; createdAt: number; lastSeenOn: string; tier: string }
interface AccountDetail {
  id: string; createdAt: number; lastSeenOn: string; tier: string; passkeys: number;
  entitlement: { tier: string; source: string; expiresAt: number | null } | null;
  subscriptions: { id: string; tier: string; status: string; currentPeriodEnd: number | null }[];
  devices: { id: string; createdAt: number; lastSeenOn: string }[];
  usage: { usedToday: number; dailyLimit: number };
}
interface KeyRow { id: string; suffix: string; status: string; createdAt: number; disabledAt: number | null; lastUsedAt: number | null }
interface ProviderRow { id: string; name: string; envKey: boolean; inUse: "stored" | "env" | "none"; keys: KeyRow[] }
interface InviteRow { id: string; maxUses: number; uses: number; createdAt: number; revokedAt: number | null }
interface AuditRow { id: number; at: number; adminId: string; action: string; accountId: string | null; target: string | null; detail: string | null }

const when = (ms: number | null) => (ms == null ? "—" : new Date(ms).toLocaleString());
const day = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString();
const short = (id: string | null) => (id ? `${id.slice(0, 10)}…` : "—");
const PRIV_TAG: Record<PrivacyModel, string> = { "tee-attested": "TEE", "tee-gateway": "TEE gateway", "zdr-contract": "Private", "anon-gateway": "Incognito" };
const privOf = (id: string) => { const d = DEFS.find((x) => x.id === id); return d ? PRIV_TAG[d.privacy] : ""; };

/** Set by AdminPanel: an expired or revoked admin session (401) returns to the sign-in screen. */
let onSignedOut = () => {};
/** Never rejects: a network failure becomes a 503 response the callers already report. */
async function call(path: string, method = "GET", body?: unknown): Promise<Response> {
  let r: Response;
  try {
    r = await fetch(`/api/admin/${path}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch { return Response.json({ error: { message: "network error, try again" } }, { status: 503 }); }
  if (r.status === 401 && !path.startsWith("login/") && path !== "me") onSignedOut();
  return r;
}
async function passkey(optionsPath: string): Promise<Response> {
  const o = await call(optionsPath, "POST", {});
  if (!o.ok) return o;
  const asr = await startAuthentication({ optionsJSON: await o.json() });
  return call("login/verify", "POST", asr);
}
const errorOf = async (r: Response) => (await r.json().catch(() => null))?.error?.message ?? `HTTP ${r.status}`;

const LEDE = "Operators only · every change needs a fresh passkey and lands in the audit log.";

export function AdminPanel({ auditDays }: { auditDays: number }) {
  const [me, setMe] = useState<string | null | undefined>(undefined);
  const [tab, setTab] = useState<Tab>("accounts");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    onSignedOut = () => { setMe(null); setNotice("Admin session ended; sign in again."); };
    call("me").then(async (r) => setMe(r.ok ? (await r.json().catch(() => null))?.accountId ?? null : null));
  }, []);

  async function signIn() {
    try {
      const r = await passkey("login/options");
      if (!r.ok) throw new Error(await errorOf(r));
      setMe((await r.json()).accountId); setNotice("");
    } catch (e) { setNotice(`Sign-in: ${(e as Error).message}`); }
  }
  async function signOut() {
    const r = await call("logout", "POST");
    // Only a server answer clears the HttpOnly cookie; otherwise the session is still live.
    if (!r.ok) { setNotice(`Sign-out failed: ${await errorOf(r)}. You are still signed in.`); return; }
    setMe(null); setNotice("");
  }

  /** Writes: if the server asks for a fresh passkey confirmation, do it and retry once. */
  const write = useCallback(async (path: string, method: string, body: unknown): Promise<Response> => {
    const r = await call(path, method, body);
    if (r.status !== 403 || (await r.clone().json().catch(() => null))?.error?.code !== "step_up_required") return r;
    setNotice("Confirm with your passkey");
    try {
      const v = await passkey("stepup/options");
      if (!v.ok) return v;
    } catch (e) { setNotice(`Passkey: ${(e as Error).message}`); return r; }
    setNotice("");
    return call(path, method, body);
  }, []);
  const report = useCallback(async (r: Response, ok: string) => { setNotice(r.ok ? ok : `Error: ${await errorOf(r)}`); return r.ok; }, []);
  // Rendered always, so screen readers announce changes to its text.
  const status = <p className="mgmt-status" role="status" aria-live="polite">{notice}</p>;

  const shell = (body: React.ReactNode) => (
    <IconContext.Provider value={{ weight: "duotone", size: "1em", color: "currentColor", mirrored: false }}>
      <main className="page mgmt"><div className="mgmt-inner">{body}</div></main>
    </IconContext.Provider>
  );
  if (me === undefined) return shell(<p className="mgmt-muted">Loading…</p>);
  if (me === null) return shell(<>
    <h1>Management</h1>
    <p className="mgmt-lede">{LEDE}</p>
    <div className="hs-card" style={{ maxWidth: 520 }}>
      <p className="hs-note" style={{ marginBottom: 15 }}>Sign in with the passkey of an account listed in ADMIN_ACCOUNT_IDS.</p>
      <button type="button" className="hs-btn primary" onClick={signIn}><Fingerprint aria-hidden />Sign in with passkey</button>
    </div>
    <p className="mgmt-status" role="status" aria-live="polite" style={{ marginTop: 15 }}>{notice}</p>
  </>);
  const tabs: [Tab, string, React.ReactNode][] = [
    ["accounts", "Accounts", <Users key="u" aria-hidden />], ["keys", "Provider keys", <Key key="k" aria-hidden />],
    ["invites", "Invites", <Ticket key="t" aria-hidden />], ["audit", "Audit log", <ClockCounterClockwise key="a" aria-hidden />],
  ];
  return shell(<>
    <div className="mgmt-top">
      <div>
        <h1>Management</h1>
        <p className="mgmt-lede">{LEDE}</p>
      </div>
      <p className="mgmt-me">Signed in as <code>{short(me)}</code>
        <button type="button" className="hs-btn" onClick={signOut}><SignOut aria-hidden />Sign out</button></p>
    </div>
    <div className="mgmt-tabs" role="group" aria-label="Management sections">
      {tabs.map(([id, label, icon]) => (
        <button key={id} type="button" aria-pressed={tab === id} onClick={() => { setTab(id); setNotice(""); }}>{icon}{label}</button>
      ))}
    </div>
    {status}
    <div>
      {tab === "accounts" && <AccountsTab write={write} report={report} />}
      {tab === "keys" && <KeysTab write={write} report={report} />}
      {tab === "invites" && <InvitesTab write={write} report={report} />}
      {tab === "audit" && <AuditTab days={auditDays} />}
    </div>
  </>);
}

interface TabProps { write: (path: string, method: string, body: unknown) => Promise<Response>; report: (r: Response, ok: string) => Promise<boolean> }

function AccountsTab({ write, report }: TabProps) {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState({ prefix: "", offset: 0 });
  const [rows, setRows] = useState<AccountRow[]>([]);
  const [pageSize, setPageSize] = useState(50);
  const latest = useRef(0);
  const latestSearch = useRef(0);
  const searchBox = useRef<HTMLInputElement>(null);
  const [sel, setSel] = useState<AccountDetail | null>(null);
  /** "none" clears the manual plan; any tier id sets one. */
  const [tier, setTier] = useState("none");
  const [until, setUntil] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const search = useCallback(async () => {
    const n = ++latestSearch.current;
    const r = await call(`accounts?q=${encodeURIComponent(query.prefix)}&offset=${query.offset}`);
    if (n !== latestSearch.current) return;
    if (!r.ok) { setRows([]); await report(r, ""); return; }
    const j = await r.json().catch(() => null);
    if (!j) { setRows([]); await report(new Response(null, { status: 502 }), ""); return; }
    setRows(j.accounts); setPageSize(j.pageSize);
  }, [query, report]);
  /** Shows the account detail; a slower earlier response never overwrites a later click. */
  const open = useCallback(async (id: string) => {
    const n = ++latest.current;
    const r = await call(`account?id=${encodeURIComponent(id)}`);
    if (n !== latest.current) return;
    if (!r.ok) { await report(r, ""); return; }
    const d: AccountDetail | null = await r.json().catch(() => null);
    if (!d) { await report(new Response(null, { status: 502 }), ""); return; }
    setSel(d); setConfirmDelete(false);
    setTier(d.entitlement?.source === "manual" ? d.entitlement.tier : "none"); setUntil("");
  }, [report]);
  useEffect(() => { search(); }, [search]);

  async function act(path: string, method: string, body: unknown, ok: string) {
    if (await report(await write(path, method, body), ok) && sel) { await open(sel.id); await search(); }
  }
  function savePlan() {
    if (!sel) return;
    if (tier === "none") return act("account/entitlement", "DELETE", { id: sel.id }, "Manual plan cleared");
    return act("account/entitlement", "POST", { id: sel.id, tier, expiresAt: until ? new Date(`${until}T23:59:59`).getTime() : null }, "Manual plan set");
  }
  async function remove() {
    if (!sel) return;
    if (await report(await write("account", "DELETE", { id: sel.id }), "Account deleted")) { setSel(null); await search(); searchBox.current?.focus(); }
  }

  const facts: [string, React.ReactNode][] = sel ? [
    ["Plan", <>{sel.tier}{sel.entitlement ? ` · ${sel.entitlement.source}${sel.entitlement.expiresAt ? `, until ${when(sel.entitlement.expiresAt)}` : ""}` : ""}</>],
    ...sel.subscriptions.map((s): [string, React.ReactNode] => ["Stripe", <><code className="hs-mono">{s.id}</code> · {s.tier}, {s.status}, ends {when(s.currentPeriodEnd)}</>]),
    ["Created", when(sel.createdAt)], ["Last seen", day(sel.lastSeenOn)],
    ["Usage today", `${sel.usage.usedToday.toLocaleString("en")} / ${sel.usage.dailyLimit.toLocaleString("en")}`],
    ["Passkeys", String(sel.passkeys)], ["Devices", String(sel.devices.length)],
  ] : [];

  return (
    <div className="mgmt-split">
      <div>
        <form onSubmit={(e) => { e.preventDefault(); setQuery({ prefix: q.trim(), offset: 0 }); }}>
          <label className="hs-search"><MagnifyingGlass aria-hidden />
            <input ref={searchBox} aria-label="Account id prefix" placeholder="Account id prefix" value={q} onChange={(e) => setQ(e.target.value)} />
            <button type="submit" className="hs-link">Search</button>
          </label>
        </form>
        {rows.map((a) => (
          <button key={a.id} type="button" className="mgmt-acct" aria-current={sel?.id === a.id} onClick={() => open(a.id)}>
            <span className="id">{a.id}</span><span className={`tier${a.tier === "free" ? " free" : ""}`}>{a.tier}</span><span className="seen">{day(a.lastSeenOn)}</span>
          </button>
        ))}
        {!rows.length && <p className="mgmt-muted">No accounts match.</p>}
        <div className="mgmt-pager">
          <button type="button" className="hs-underline" disabled={query.offset === 0} onClick={() => setQuery((x) => ({ ...x, offset: Math.max(0, x.offset - pageSize) }))}>Previous</button>
          <span>{rows.length ? `${query.offset + 1}–${query.offset + rows.length}` : ""}</span>
          <button type="button" className="hs-underline" disabled={rows.length < pageSize} onClick={() => setQuery((x) => ({ ...x, offset: x.offset + pageSize }))}>Next</button>
        </div>
      </div>
      <div className="hs-card mgmt-card">
        {!sel ? <p className="hs-note">Pick an account to see its plan, usage and devices.</p> : (<>
          <div className="mgmt-card-k">Selected account</div>
          <div className="mgmt-card-id">{sel.id}</div>
          {facts.map(([k, v], i) => <div key={`${k}${i}`} className="mgmt-fact"><span>{k}</span><span>{v}</span></div>)}
          {sel.devices.map((d) => (
            <div key={d.id} className="hs-row"><Devices aria-hidden />
              <span className="grow">Device <code className="hs-mono">{d.id.slice(0, 8)}</code><span className="hs-sub">signed in {when(d.createdAt)} · last used {day(d.lastSeenOn)}</span></span>
              <button type="button" className="hs-icon" aria-label={`Sign out device ${d.id.slice(0, 8)}`} onClick={() => act("account/device", "DELETE", { id: sel.id, deviceId: d.id }, "Device signed out")}><SignOut aria-hidden /></button>
            </div>))}
          <div className="mgmt-label">Manual plan</div>
          <div className="hs-seg" role="group" aria-label="Manual plan">
            {["none", ...Object.keys(TIERS)].map((t) => (
              <button key={t} type="button" aria-pressed={tier === t} onClick={() => setTier(t)}>{t === "none" ? "None" : TIERS[t as keyof typeof TIERS].name}</button>
            ))}
          </div>
          {tier !== "none" && <label className="mgmt-until">Until (optional)<input className="hs-input" type="date" value={until} onChange={(e) => setUntil(e.target.value)} /></label>}
          <p className="hs-note" style={{ fontSize: 14, marginBottom: 15 }}>Manual plans only. Stripe plans change through Stripe webhooks.</p>
          <div className="hs-actions">
            <button type="button" className="hs-btn primary" onClick={savePlan}><Fingerprint aria-hidden />Save with passkey</button>
            {confirmDelete
              ? <><button type="button" className="hs-btn danger" autoFocus onClick={remove}><Trash aria-hidden />Really delete {short(sel.id)}</button>
                  <button type="button" className="hs-btn" onClick={() => setConfirmDelete(false)}>Cancel</button></>
              : <button type="button" className="hs-btn danger" onClick={() => setConfirmDelete(true)}>Delete account</button>}
          </div>
          <p className="hs-note" style={{ fontSize: 14, marginTop: 10 }}>Delete is the same erasure as the user&apos;s own: Stripe customer, then the account (recorded in the erasure ledger).</p>
        </>)}
      </div>
    </div>
  );
}

function KeysTab({ write, report }: TabProps) {
  const [data, setData] = useState<{ providers: ProviderRow[]; kekConfigured: boolean } | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    const r = await call("keys");
    const j = r.ok ? await r.json().catch(() => null) : null; // an unreadable body shows the error state, not Loading… forever
    if (j) setData(j); else { setFailed(true); if (!r.ok) await report(r, ""); }
  }, [report]);
  useEffect(() => { load(); }, [load]);

  async function act(method: string, body: unknown, ok: string) { if (await report(await write("keys", method, body), ok)) await load(); }
  async function add(provider: string) {
    const key = drafts[provider] ?? "";
    if (!key.trim()) return;
    // The draft is cleared either way: the key is never kept in page state after a save attempt.
    setDrafts((d) => ({ ...d, [provider]: "" }));
    await act("POST", { provider, key }, "Key saved; it is now the active key");
  }
  if (!data) return <p className="mgmt-muted">{failed ? "Could not load provider keys." : "Loading…"}</p>;
  return (<>
    {!data.kekConfigured && <p className="hs-warn" style={{ marginBottom: 15 }}><WarningCircle aria-hidden />ADMIN_KEY_KEK is missing or invalid: keys cannot be stored here, env keys are used.</p>}
    {data.providers.map((p) => {
      const activeKey = p.keys.find((k) => k.status === "active");
      const used = Math.max(-1, ...p.keys.map((k) => k.lastUsedAt ?? -1));
      const isOpen = openId === p.id;
      return (
        <div key={p.id}>
          <div className="mgmt-key">
            <span>{p.name}<span className="hs-sub">{used >= 0 ? `last used ${when(used)}` : "no stored key used yet"}{p.envKey ? " · env key present" : ""}</span></span>
            <span className="priv">{privOf(p.id)}</span>
            <span className="use">{p.inUse === "none" ? "not set" : p.inUse}</span>
            <span className="sfx">{activeKey ? `…${activeKey.suffix}` : "—"}</span>
            <button type="button" className="hs-underline" aria-expanded={isOpen} onClick={() => setOpenId(isOpen ? null : p.id)}>{activeKey ? "Rotate" : "Add key"}</button>
          </div>
          {isOpen && (
            <div className="mgmt-key-more">
              <form onSubmit={(e) => { e.preventDefault(); add(p.id); }}>
                <input className="hs-input" type="password" autoComplete="off" spellCheck={false} aria-label={`New ${p.name} API key`} placeholder="New API key"
                  value={drafts[p.id] ?? ""} onChange={(e) => setDrafts((d) => ({ ...d, [p.id]: e.target.value }))} />
                <button type="submit" className="hs-btn primary" disabled={!data.kekConfigured || !(drafts[p.id] ?? "").trim()}><Fingerprint aria-hidden />{activeKey ? "Rotate with passkey" : "Add with passkey"}</button>
              </form>
              {p.keys.map((k) => (
                <div key={k.id} className="hs-row">
                  <code className="hs-mono">…{k.suffix}</code>
                  <span className="grow"><span className={k.status === "active" ? "hs-tag" : "mgmt-muted"}>{k.status}</span>
                    <span className="hs-sub">added {when(k.createdAt)} · disabled {when(k.disabledAt)} · last used {when(k.lastUsedAt)}</span></span>
                  {k.status === "active"
                    ? <button type="button" className="hs-underline" onClick={() => act("PATCH", { id: k.id, status: "disabled" }, "Key disabled")}>Disable</button>
                    : <button type="button" className="hs-underline" onClick={() => act("PATCH", { id: k.id, status: "active" }, "Key activated")}>Activate</button>}
                  <button type="button" className="hs-icon bad" aria-label={`Remove key ending ${k.suffix}`} onClick={() => act("DELETE", { id: k.id }, "Key removed")}><Trash aria-hidden /></button>
                </div>))}
            </div>
          )}
        </div>
      );
    })}
    <p className="mgmt-foot">Keys are stored encrypted and shown only by their last four characters. An active stored key wins over the environment key (&lt;PREFIX&gt;_API_KEY). Saving a new key rotates: the previous one is disabled.</p>
  </>);
}

function InvitesTab({ write, report }: TabProps) {
  const [data, setData] = useState<{ invites: InviteRow[]; envCodes: number; gateOn: boolean } | null>(null);
  const [maxUses, setMaxUses] = useState(1);
  const [fresh, setFresh] = useState<string | null>(null);
  const [copied, setCopied] = useState("");
  // The code is shown once, so say whether the copy worked (no clipboard on plain http, or permission denied).
  const copy = (text: string, what: string) => Promise.resolve().then(() => navigator.clipboard.writeText(text))
    .then(() => setCopied(`${what} copied.`), () => setCopied("Copy failed: select the code and copy it by hand."));
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    const r = await call("invites");
    const j = r.ok ? await r.json().catch(() => null) : null; // an unreadable body shows the error state, not Loading… forever
    if (j) setData(j); else { setFailed(true); if (!r.ok) await report(r, ""); }
  }, [report]);
  useEffect(() => { load(); }, [load]);

  async function create() {
    const r = await write("invites", "POST", { maxUses });
    if (await report(r.clone(), "Invite created: copy the code now, it is not shown again")) { setFresh((await r.json()).code); setCopied(""); await load(); }
  }
  async function revoke(id: string) { if (await report(await write("invites", "DELETE", { id }), "Invite revoked")) await load(); }
  if (!data) return <p className="mgmt-muted">{failed ? "Could not load invites." : "Loading…"}</p>;
  return (<>
    <div className="hs-card mgmt-new">
      <span className="grow">
        {fresh
          ? <><span className="hs-sub">New code · shown once</span><span className="code">{fresh}</span></>
          : <><span className="hs-sub">Signup gate</span>{data.gateOn ? "Invite-only" : "Open"}</>}
        {copied && <span className="hs-sub" role="status">{copied}</span>}
      </span>
      {fresh && <>
        <button type="button" className="hs-link" onClick={() => copy(fresh, "Code")}>Copy code</button>
        <button type="button" className="hs-link" data-testid="copy-invite-link" onClick={() => copy(inviteLink(window.location.origin, fresh), "Invite link")}><LinkIcon aria-hidden />Copy invite link</button>
      </>}
      <label>Uses<input className="hs-input" type="number" min={1} max={1000} value={maxUses} onChange={(e) => setMaxUses(Number(e.target.value))} /></label>
      <button type="button" className="hs-btn primary" onClick={create}><Ticket aria-hidden />New code</button>
    </div>
    {!data.gateOn && <p className="hs-note" style={{ marginBottom: 15 }}>Codes take effect once INVITE_CODES or INVITE_ONLY=1 is set.</p>}
    {data.invites.map((i) => {
      const st = i.revokedAt != null ? "Revoked" : i.uses >= i.maxUses ? "Used up" : "Active";
      return (
        <div key={i.id} className="mgmt-inv">
          <span className="id" title={i.id}>{i.id}</span><span className="uses">{i.uses} / {i.maxUses}</span>
          <span className="created">{when(i.createdAt)}{i.revokedAt != null ? ` · revoked ${when(i.revokedAt)}` : ""}</span>
          <span className={`st${st === "Active" ? " on" : ""}`}>{st}</span>
          <span>{i.revokedAt == null && <button type="button" className="hs-underline quiet" onClick={() => revoke(i.id)}>Revoke</button>}</span>
        </div>);
    })}
    {data.envCodes > 0 && (
      <div className="mgmt-inv">
        <span className="id">INVITE_CODES (env)</span><span className="uses">{data.envCodes} code{data.envCodes === 1 ? "" : "s"}</span>
        <span className="created">edit env and restart</span><span className="st">Read-only</span><span />
      </div>
    )}
  </>);
}

function AuditTab({ days }: { days: number }) {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    call("audit").then(async (r) => {
      const entries = r.ok ? (await r.json().catch(() => null))?.entries : undefined;
      if (Array.isArray(entries)) setRows(entries); else setError(r.ok ? "unreadable response" : await errorOf(r));
    });
  }, []);
  if (!rows) return <p className="mgmt-muted">{error ? `Could not load the audit log: ${error}` : "Loading…"}</p>;
  return (<>
    {rows.map((e) => (
      <div key={e.id} className="mgmt-audit">
        <span className="at">{when(e.at)}</span>
        <span className="act">{e.action}</span>
        <span>{e.detail ?? ""}<span className="by">by {short(e.adminId)}{e.accountId ? ` → ${short(e.accountId)}` : ""}{e.target ? ` · ${short(e.target)}` : ""}</span></span>
      </div>))}
    {!rows.length && <p className="mgmt-muted">No admin actions yet.</p>}
    <p className="mgmt-foot">Latest 200 admin actions. No IP addresses, user agents or secrets are logged. Entries are kept for {days} days.</p>
  </>);
}
