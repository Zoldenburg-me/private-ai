"use client";
import { CircleDashed, EyeSlash, LockSimple, ShieldCheck, ShieldSlash } from "@phosphor-icons/react";
import type { ModelEntry } from "@/lib/catalog";
import type { Proof } from "@/lib/client/proof";
import { PROVIDER_LABEL } from "@/lib/client/providers";
import type { Chat } from "@/lib/storage";
import type { Tier } from "@/lib/tiers";
import type { Usage } from "./UsageMeter";

/** Seconds-to-words for "checked 2 min ago". */
export function ago(ms: number, now: number): string {
  const min = Math.round((now - ms) / 60_000);
  if (min < 1) return "checked just now";
  if (min < 60) return `checked ${min} min ago`;
  return `checked ${Math.round(min / 60)} h ago`;
}

/** Used/limit as the design's "214 / 1,000" figure and meter width. */
export function quota(u: Usage | null, fallback?: number): { v: string; pct: number } {
  const limit = u?.limit ?? fallback;
  if (!u || limit == null) return { v: "…", pct: 0 };
  const used = Math.max(0, limit - u.remaining);
  return { v: `${used.toLocaleString("en")} / ${limit.toLocaleString("en")}`, pct: limit ? Math.min(100, (used / limit) * 100) : 0 };
}

function Stat({ k, v, pct, meta }: { k: string; v: string; pct: number; meta: string }) {
  return (
    <div className="stat">
      <div className="stat-k">{k}</div>
      <div className="stat-v">{v}</div>
      <div className="stat-bar" aria-hidden><div style={{ width: `${pct}%` }} /></div>
      <div className="stat-meta">{meta}</div>
    </div>
  );
}

const fine = (s: string) => s.replace(/ \(.*\)$/, "");

/** The design's short status per enclave row; never "Verified" unless the chain is. */
const STATUS: Record<Proof["level"], string> = {
  verified: "Verified", "checks-passed": "Checks passed", "server-checked": "Server-checked", "gateway-checked": "Gateway checked",
  failed: "Check failed", unavailable: "Unavailable", pending: "Checking", "no-enclave": "No enclave",
};

/** The design's Dashboard. Server numbers are counters only; enclave rows are checks this browser ran. */
export function DashboardView(p: { tier: Tier | null; usage: Usage | null; incognitoUsage: Usage | null; chats: Chat[]; models: ModelEntry[]; proofs: Record<string, Proof>; renewsAt?: number | string | null }) {
  const renews = p.renewsAt ? ` · renews ${new Date(p.renewsAt).toLocaleDateString("en", { month: "short", day: "numeric" })}` : "";
  const std = quota(p.usage, p.tier?.dailyMessages);
  const inc = quota(p.incognitoUsage);
  const now = Date.now();
  // One row per route actually checked (an Auto entry points at a route listed under its own key).
  const checked = Object.entries(p.proofs).filter(([k, v]) => k === v.modelRef && v.level !== "pending");
  return (
    <div className="page dash" data-testid="dashboard">
      <h1>Your usage, <em>counted not read.</em></h1>
      <p className="dash-lede">The server keeps counts only. Model and chat stats below are worked out in this browser and never sent.</p>

      <div className="stats">
        <Stat k="Today" v={std.v} pct={std.pct} meta="resets at midnight UTC" />
        {p.incognitoUsage && <Stat k="Incognito today" v={inc.v} pct={inc.pct} meta="counted separately" />}
        <Stat k="Plan" v={p.tier?.name ?? "…"} pct={100} meta={p.tier ? `€${p.tier.priceEurMonth} / month${renews}` : ""} />
        <Stat k="Saved chats" v={String(p.chats.length)} pct={0} meta="encrypted in this browser" />
      </div>

      <div className="dash-cols">
        <section aria-labelledby="dash-days" className="soon-panel">
          <h2 id="dash-days">Messages, last 14 days <span className="soon-tag">coming soon</span></h2>
          <div className="day-bars" aria-hidden>{Array.from({ length: 14 }, (_, i) => <div key={i} />)}</div>
          <p className="dash-fine">The server keeps today&rsquo;s count only, so there is no history to show yet.</p>
        </section>
        <section aria-labelledby="dash-models" className="soon-panel">
          <h2 id="dash-models">Models you used <span className="soon-tag">coming soon</span></h2>
          <p className="dash-fine"><LockSimple aria-hidden /> Kept in this browser only</p>
        </section>
      </div>

      <section className="dash-enc" aria-labelledby="dash-enc">
        <h2 id="dash-enc">Enclaves right now</h2>
        {checked.length ? checked.map(([ref, pr]) => {
          const prov = ref.split(":")[0];
          const name = fine(PROVIDER_LABEL[prov] ?? prov);
          const model = p.models.find((m) => `${m.provider}:${m.id}` === ref)?.name ?? ref.slice(ref.indexOf(":") + 1);
          const none = pr.level === "no-enclave";
          const Icon = none ? EyeSlash : pr.level === "failed" ? ShieldSlash : pr.level === "unavailable" ? CircleDashed : ShieldCheck;
          return (
            <div key={ref} className="enc-row">
              <span>{name}<span className="enc-sub">{model}</span></span>
              <span className="muted">{none ? "—" : ago(pr.checkedAt, now)}</span>
              <span className={`enc-st lv-${pr.level}`} title={pr.label}><Icon weight="duotone" aria-hidden />{STATUS[pr.level]}</span>
            </div>
          );
        }) : <p className="muted">No enclave checked yet. Pick a model in a chat and its check shows here.</p>}
      </section>
    </div>
  );
}
