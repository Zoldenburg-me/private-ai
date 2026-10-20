"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { startAuthentication } from "@simplewebauthn/browser";
import { ClockCounterClockwise, Fingerprint, Key, MagnifyingGlass, SignOut, Ticket, Trash, Users, WarningCircle } from "@phosphor-icons/react";
import { TIERS } from "@/lib/tiers";

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

export function AdminPanel() {
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
  const status = <p className="small" role="status" aria-live="polite">{notice}</p>;

  if (me === undefined) return <main className="page admin"><p className="muted">Loading…</p></main>;
  if (me === null) return (
    <main className="page admin">
      <h1>Admin</h1>
      <section className="panel">
        <h2><Fingerprint aria-hidden />Sign in</h2>
        <p className="small muted">Operators only. Sign in with the passkey of an account listed in ADMIN_ACCOUNT_IDS.</p>
        <button type="button" className="btn primary" onClick={signIn}><Fingerprint aria-hidden />Sign in with passkey</button>
        {status}
      </section>
    </main>
  );
  const tabs: [Tab, string, React.ReactNode][] = [
    ["accounts", "Accounts", <Users key="u" aria-hidden />], ["keys", "Provider keys", <Key key="k" aria-hidden />],
    ["invites", "Invites", <Ticket key="t" aria-hidden />], ["audit", "Audit log", <ClockCounterClockwise key="a" aria-hidden />],
  ];
  return (
    <main className="page admin">
      <div className="row between wrap gap">
        <h1>Admin</h1>
        <p className="row gap small muted">Signed in as <code>{short(me)}</code>
          <button type="button" className="btn" onClick={signOut}><SignOut aria-hidden />Sign out</button></p>
      </div>
      <nav className="row gap wrap" aria-label="Admin sections">
        {tabs.map(([id, label, icon]) => (
          <button key={id} type="button" className={`btn${tab === id ? " primary" : ""}`} aria-pressed={tab === id} onClick={() => { setTab(id); setNotice(""); }}>{icon}{label}</button>
        ))}
      </nav>
      {status}
      {tab === "accounts" && <AccountsTab write={write} report={report} />}
      {tab === "keys" && <KeysTab write={write} report={report} />}
      {tab === "invites" && <InvitesTab write={write} report={report} />}
      {tab === "audit" && <AuditTab />}
    </main>
  );
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
  const [tier, setTier] = useState("pro");
  const [until, setUntil] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const search = useCallback(async () => {
    const n = ++latestSearch.current;
    const r = await call(`accounts?q=${encodeURIComponent(query.prefix)}&offset=${query.offset}`);
    if (n !== latestSearch.current) return;
    if (!r.ok) { setRows([]); await report(r, ""); return; }
    const j = await r.json().catch(() => null);
    if (!j) { setRows([]); return; }
    setRows(j.accounts); setPageSize(j.pageSize);
  }, [query, report]);
  /** Shows the account detail; a slower earlier response never overwrites a later click. */
  const open = useCallback(async (id: string) => {
    const n = ++latest.current;
    const r = await call(`account?id=${encodeURIComponent(id)}`);
    if (n !== latest.current) return;
    if (!r.ok) { await report(r, ""); return; }
    setSel(await r.json()); setConfirmDelete(false);
  }, [report]);
  useEffect(() => { search(); }, [search]);

  async function act(path: string, method: string, body: unknown, ok: string) {
    if (await report(await write(path, method, body), ok) && sel) { await open(sel.id); await search(); }
  }
  async function remove() {
    if (!sel) return;
    if (await report(await write("account", "DELETE", { id: sel.id }), "Account deleted")) { setSel(null); await search(); searchBox.current?.focus(); }
  }

  return (<>
    <section className="panel">
      <h2><Users aria-hidden />Accounts</h2>
      <form className="row gap" onSubmit={(e) => { e.preventDefault(); setQuery({ prefix: q.trim(), offset: 0 }); }}>
        <input ref={searchBox} aria-label="Account id prefix" placeholder="Account id prefix" value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="submit" className="btn"><MagnifyingGlass aria-hidden />Search</button>
      </form>
      <div className="admin-scroll">
        <table className="admin-table">
          <thead><tr><th>Account</th><th>Plan</th><th>Created</th><th>Last seen</th></tr></thead>
          <tbody>{rows.map((a) => (
            <tr key={a.id} className={sel?.id === a.id ? "sel" : ""}>
              <td><button type="button" className="link" onClick={() => open(a.id)}><code>{a.id}</code></button></td>
              <td>{a.tier}</td><td>{when(a.createdAt)}</td><td>{day(a.lastSeenOn)}</td>
            </tr>))}</tbody>
        </table>
      </div>
      {!rows.length && <p className="small muted">No accounts match.</p>}
      <div className="row gap">
        <button type="button" className="btn ghost" disabled={query.offset === 0} onClick={() => setQuery((x) => ({ ...x, offset: Math.max(0, x.offset - pageSize) }))}>Previous</button>
        <span className="small muted">{rows.length ? `${query.offset + 1}–${query.offset + rows.length}` : ""}</span>
        <button type="button" className="btn ghost" disabled={rows.length < pageSize} onClick={() => setQuery((x) => ({ ...x, offset: x.offset + pageSize }))}>Next</button>
      </div>
    </section>
    {sel && <section className="panel">
      <h2>Account <code>{sel.id}</code></h2>
      <p className="small muted">Created {when(sel.createdAt)} · last seen {day(sel.lastSeenOn)} · {sel.passkeys} passkey(s) · {sel.usage.usedToday}/{sel.usage.dailyLimit} messages today</p>
      <h3>Plan</h3>
      <p className="small">Effective: <span className="tag t-current">{sel.tier}</span>{" "}
        {sel.entitlement ? <>stored {sel.entitlement.tier} from {sel.entitlement.source}{sel.entitlement.expiresAt ? `, until ${when(sel.entitlement.expiresAt)}` : ""}</> : "no stored entitlement"}</p>
      {sel.subscriptions.map((s) => <p key={s.id} className="small muted">Stripe {s.id}: {s.tier}, {s.status}, period ends {when(s.currentPeriodEnd)}</p>)}
      <div className="row gap wrap">
        <select aria-label="Plan" value={tier} onChange={(e) => setTier(e.target.value)}>{Object.keys(TIERS).map((t) => <option key={t}>{t}</option>)}</select>
        <label className="row gap small">Until (optional)<input type="date" value={until} onChange={(e) => setUntil(e.target.value)} /></label>
        <button type="button" className="btn" onClick={() => act("account/entitlement", "POST", { id: sel.id, tier, expiresAt: until ? new Date(`${until}T23:59:59`).getTime() : null }, "Manual plan set")}>Set manual plan</button>
        <button type="button" className="btn ghost" onClick={() => act("account/entitlement", "DELETE", { id: sel.id }, "Manual plan cleared")}>Clear manual plan</button>
      </div>
      <p className="small muted">Manual plans only. Stripe plans change through Stripe webhooks.</p>
      <h3>Devices</h3>
      <ul className="plain small">{sel.devices.map((d) => (
        <li key={d.id} className="row gap">Device <code>{d.id.slice(0, 8)}…</code><span className="muted">signed in {when(d.createdAt)} · last used {day(d.lastSeenOn)}</span>
          <button type="button" className="icon-btn" aria-label={`Sign out device ${d.id.slice(0, 8)}`} onClick={() => act("account/device", "DELETE", { id: sel.id, deviceId: d.id }, "Device signed out")}><SignOut aria-hidden /></button></li>))}
      </ul>
      {!sel.devices.length && <p className="small muted">No signed-in devices.</p>}
      <h3 className="danger-h"><WarningCircle aria-hidden />Delete account</h3>
      <p className="small muted">Same erasure as the user&apos;s own delete: Stripe customer, then the account (recorded in the erasure ledger).</p>
      {confirmDelete
        ? <div className="row gap"><button type="button" className="btn danger" autoFocus onClick={remove}><Trash aria-hidden />Really delete {short(sel.id)}</button>
            <button type="button" className="btn ghost" onClick={() => setConfirmDelete(false)}>Cancel</button></div>
        : <button type="button" className="btn danger" onClick={() => setConfirmDelete(true)}><Trash aria-hidden />Delete account</button>}
    </section>}
  </>);
}

function KeysTab({ write, report }: TabProps) {
  const [data, setData] = useState<{ providers: ProviderRow[]; kekConfigured: boolean } | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    const r = await call("keys");
    if (r.ok) setData(await r.json()); else { setFailed(true); await report(r, ""); }
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
  if (!data) return <p className="muted">{failed ? "Could not load provider keys." : "Loading…"}</p>;
  return (<>
    {!data.kekConfigured && <p className="tip"><WarningCircle aria-hidden />ADMIN_KEY_KEK is missing or invalid: keys cannot be stored here, env keys are used.</p>}
    <p className="small muted">An active stored key wins over the env key; without one the env key (&lt;PREFIX&gt;_API_KEY) is used. Saving a new key rotates: the previous one is disabled. Keys are never shown again, only their last 4 characters.</p>
    {data.providers.map((p) => (
      <section key={p.id} className="panel">
        <h2><Key aria-hidden />{p.name} <span className="tag">{p.id}</span>
          <span className={`tag ${p.inUse === "none" ? "tone-muted" : "tone-ok"}`}>{p.inUse === "stored" ? "stored key in use" : p.inUse === "env" ? "env key in use" : "not configured"}</span>
          {p.envKey && <span className="tag tone-muted">env key present</span>}</h2>
        {p.keys.length > 0 && <div className="admin-scroll"><table className="admin-table">
          <thead><tr><th>Key</th><th>Status</th><th>Added</th><th>Disabled</th><th>Last used</th><th /></tr></thead>
          <tbody>{p.keys.map((k) => (
            <tr key={k.id}><td><code>…{k.suffix}</code></td>
              <td><span className={`tag ${k.status === "active" ? "tone-ok" : "tone-muted"}`}>{k.status}</span></td>
              <td>{when(k.createdAt)}</td><td>{when(k.disabledAt)}</td><td>{when(k.lastUsedAt)}</td>
              <td className="row gap">
                {k.status === "active"
                  ? <button type="button" className="btn" onClick={() => act("PATCH", { id: k.id, status: "disabled" }, "Key disabled")}>Disable</button>
                  : <button type="button" className="btn" onClick={() => act("PATCH", { id: k.id, status: "active" }, "Key activated")}>Activate</button>}
                <button type="button" className="icon-btn" aria-label={`Remove key ending ${k.suffix}`} onClick={() => act("DELETE", { id: k.id }, "Key removed")}><Trash aria-hidden /></button>
              </td></tr>))}</tbody>
        </table></div>}
        <form className="row gap wrap" onSubmit={(e) => { e.preventDefault(); add(p.id); }}>
          <input type="password" autoComplete="off" spellCheck={false} aria-label={`New ${p.name} API key`} placeholder="New API key"
            value={drafts[p.id] ?? ""} onChange={(e) => setDrafts((d) => ({ ...d, [p.id]: e.target.value }))} />
          <button type="submit" className="btn" disabled={!data.kekConfigured || !(drafts[p.id] ?? "").trim()}>{p.keys.some((k) => k.status === "active") ? "Rotate" : "Add key"}</button>
        </form>
      </section>
    ))}
  </>);
}

function InvitesTab({ write, report }: TabProps) {
  const [data, setData] = useState<{ invites: InviteRow[]; envCodes: number; gateOn: boolean } | null>(null);
  const [maxUses, setMaxUses] = useState(1);
  const [fresh, setFresh] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    const r = await call("invites");
    if (r.ok) setData(await r.json()); else { setFailed(true); await report(r, ""); }
  }, [report]);
  useEffect(() => { load(); }, [load]);

  async function create() {
    const r = await write("invites", "POST", { maxUses });
    if (await report(r.clone(), "Invite created: copy the code now, it is not shown again")) { setFresh((await r.json()).code); await load(); }
  }
  async function revoke(id: string) { if (await report(await write("invites", "DELETE", { id }), "Invite revoked")) await load(); }
  if (!data) return <p className="muted">{failed ? "Could not load invites." : "Loading…"}</p>;
  return (
    <section className="panel">
      <h2><Ticket aria-hidden />Invite codes</h2>
      <p className="small">Signup gate: <span className={`tag ${data.gateOn ? "tone-ok" : "tone-warn"}`}>{data.gateOn ? "invite-only" : "open"}</span>{" "}
        <span className="muted">{data.envCodes} code(s) from INVITE_CODES (read-only; edit env and restart). {data.gateOn ? "" : "Codes below take effect once INVITE_CODES or INVITE_ONLY=1 is set."}</span></p>
      <div className="row gap wrap">
        <label className="row gap small">Uses<input type="number" min={1} max={1000} value={maxUses} onChange={(e) => setMaxUses(Number(e.target.value))} /></label>
        <button type="button" className="btn" onClick={create}>Create code</button>
      </div>
      {fresh && <p role="status" className="row gap wrap small">New code, shown only once: <code className="admin-code">{fresh}</code>
        <button type="button" className="btn ghost" onClick={() => navigator.clipboard?.writeText(fresh)}>Copy</button></p>}
      <div className="admin-scroll"><table className="admin-table">
        <thead><tr><th>Id</th><th>Used</th><th>Created</th><th>Revoked</th><th /></tr></thead>
        <tbody>{data.invites.map((i) => (
          <tr key={i.id}><td><code>{i.id}</code></td><td>{i.uses}/{i.maxUses}</td><td>{when(i.createdAt)}</td><td>{when(i.revokedAt)}</td>
            <td>{i.revokedAt == null && <button type="button" className="btn ghost" onClick={() => revoke(i.id)}>Revoke</button>}</td></tr>))}</tbody>
      </table></div>
    </section>
  );
}

function AuditTab() {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { call("audit").then(async (r) => (r.ok ? setRows((await r.json()).entries) : setError(await errorOf(r)))); }, []);
  if (!rows) return <p className="muted">{error ? `Could not load the audit log: ${error}` : "Loading…"}</p>;
  return (
    <section className="panel">
      <h2><ClockCounterClockwise aria-hidden />Audit log</h2>
      <p className="small muted">Latest 200 admin actions. No IP addresses, user agents or secrets are recorded.</p>
      <div className="admin-scroll"><table className="admin-table">
        <thead><tr><th>When</th><th>Admin</th><th>Action</th><th>Account</th><th>Target</th><th>Detail</th></tr></thead>
        <tbody>{rows.map((e) => (
          <tr key={e.id}><td>{when(e.at)}</td><td><code>{short(e.adminId)}</code></td><td>{e.action}</td>
            <td><code>{short(e.accountId)}</code></td><td><code>{short(e.target)}</code></td><td>{e.detail ?? ""}</td></tr>))}</tbody>
      </table></div>
    </section>
  );
}
