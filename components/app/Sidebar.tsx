"use client";
import { useState, type ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import { Check, Ghost, MagnifyingGlass, NotePencil, SidebarSimple, Trash, WarningCircle } from "@phosphor-icons/react";
import type { Chat } from "@/lib/storage";
import type { Tier } from "@/lib/tiers";
import type { Usage } from "./UsageMeter";

interface SidebarProps {
  ghost: boolean; query: string; onQuery: (q: string) => void;
  chats: Chat[]; currentId: string; vaultError: string;
  tier: Tier | null; usage: Usage | null;
  account: { signedIn: boolean; id: string } | null; accountOn: boolean; onAccount: () => void;
  onNew: () => void; onOpen: (c: Chat) => void; onDelete: (c: Chat) => void;
  onCollapse: () => void; nav: ReactNode;
}

const DAY = 86_400_000;
/** Today / This week / Earlier, by the chat's last update. */
export function groupOf(t: number, now: number): string {
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  if (t >= start.getTime()) return "Today";
  return t >= start.getTime() - 6 * DAY ? "This week" : "Earlier";
}

/** Navigation column: chats, the app's views and the account. In ghost chat the list is hidden: nothing from this tab is ever saved. */
export function Sidebar(p: SidebarProps) {
  const [armed, setArmed] = useState(""); // chat id whose delete awaits a second click
  const now = Date.now();
  const groups = ["Today", "This week", "Earlier"].map((g) => ({ g, items: p.chats.filter((c) => groupOf(c.updatedAt, now) === g) })).filter((x) => x.items.length);
  const left = p.usage ? `${p.usage.remaining.toLocaleString("en")} left today${p.usage.incognito ? " incognito" : ""}` : "…";
  return (
    <aside className="sidebar" aria-label="Chats">
      <div className="side-top">
        <Link href="/" className="side-brand" aria-label="Hiddensee home">
          <span className="brand"><Image src="/brand/narwhal.svg" alt="" width={22} height={12} unoptimized /></span>Hiddensee
        </Link>
        <button type="button" className="icon-btn side-close" aria-label="Close sidebar" onClick={p.onCollapse}><SidebarSimple weight="duotone" aria-hidden /></button>
      </div>
      <button type="button" className="side-item side-new" data-testid="new-chat" onClick={p.onNew}><NotePencil weight="duotone" aria-hidden />New chat</button>
      {!p.ghost && (
        <label className="search">
          <MagnifyingGlass weight="duotone" aria-hidden />
          <input placeholder="Search" aria-label="Search chats" value={p.query} onChange={(e) => p.onQuery(e.target.value)} />
        </label>
      )}
      {p.vaultError && <p className="note bad" role="alert"><WarningCircle aria-hidden />{p.vaultError}</p>}
      <div className="sessions" data-testid="sessions">
        {p.ghost
          ? <p className="note ghost-note" data-testid="ghost-note"><Ghost aria-hidden />Ghost chat: kept only in this tab, never saved.</p>
          : <>
              {groups.map(({ g, items }) => (
                <div key={g}>
                  <div className="side-group">{g}</div>
                  <ul>
                    {items.map((c) => (
                      <li key={c.id} className={c.id === p.currentId ? "on" : ""}>
                        <button type="button" className="session" onClick={() => p.onOpen(c)} aria-current={c.id === p.currentId ? "true" : undefined}>
                          <span className="title">{c.title}</span>
                        </button>
                        {armed === c.id
                          ? <button type="button" className="icon-btn del armed" aria-label={`Confirm delete chat ${c.title}`} autoFocus onBlur={() => setArmed("")}
                              onClick={() => { setArmed(""); p.onDelete(c); }}><Check weight="bold" aria-hidden /></button>
                          : <button type="button" className="icon-btn del" aria-label={`Delete chat ${c.title}`} onClick={() => setArmed(c.id)}><Trash aria-hidden /></button>}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {!p.chats.length && <p className="side-empty">{p.query ? "No matching chats" : "No chats yet"}</p>}
            </>}
      </div>
      <nav className="side-nav" aria-label="Main">{p.nav}</nav>
      <button type="button" className={`account-chip ${p.accountOn ? "on" : ""}`} data-testid="nav-settings" aria-current={p.accountOn ? "page" : undefined} onClick={p.onAccount}>
        <span className="avatar-dot" aria-hidden>{p.account?.signedIn ? "H" : "?"}</span>
        <span className="acct-lines">
          <span>Your account</span>
          <span className="muted small" data-testid="plan">{p.tier ? `${p.tier.name} · ${left}` : "…"}</span>
        </span>
      </button>
    </aside>
  );
}
