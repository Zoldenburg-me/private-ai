"use client";
import { useState } from "react";
import { Check, Ghost, LockSimple, MagnifyingGlass, Plus, Trash, UserCircle, WarningCircle } from "@phosphor-icons/react";
import type { Chat } from "@/lib/storage";
import type { Tier } from "@/lib/tiers";
import { UsageMeter, type Usage } from "./UsageMeter";

interface SidebarProps {
  ghost: boolean; query: string; onQuery: (q: string) => void;
  chats: Chat[]; currentId: string; vaultError: string;
  tier: Tier | null; usage: Usage | null; onUpgrade: () => void;
  account: { signedIn: boolean; id: string } | null; onAccount: () => void;
  onNew: () => void; onToggleGhost: () => void; onOpen: (c: Chat) => void; onDelete: (c: Chat) => void;
}

/** Chat list column. In ghost chat the list is hidden: nothing from this tab is ever saved. */
export function Sidebar(p: SidebarProps) {
  const [armed, setArmed] = useState(""); // chat id whose delete awaits a second click
  return (
    <aside className="sidebar" aria-label="Chats">
      <div className="side-head">
        <button type="button" className="btn primary wide" data-testid="new-chat" onClick={p.onNew}><Plus weight="bold" aria-hidden />New chat</button>
        <button type="button" className={`btn icon ghost-btn ${p.ghost ? "on" : ""}`} data-testid="ghost-toggle" aria-pressed={p.ghost}
          onClick={p.onToggleGhost} aria-label="Ghost chat" title="Ghost chat: never saved"><Ghost weight={p.ghost ? "fill" : "regular"} aria-hidden /></button>
      </div>
      {!p.ghost && (
        <label className="search">
          <MagnifyingGlass aria-hidden />
          <input placeholder="Search chats" aria-label="Search chats" value={p.query} onChange={(e) => p.onQuery(e.target.value)} />
        </label>
      )}
      {p.ghost
        ? <p className="note ghost-note" data-testid="ghost-note"><Ghost aria-hidden />Ghost chat: kept only in this tab, never saved.</p>
        : <p className="note"><LockSimple aria-hidden />History is encrypted and stays in this browser.</p>}
      {p.vaultError && <p className="note bad" role="alert"><WarningCircle aria-hidden />{p.vaultError}</p>}
      <ul className="sessions" data-testid="sessions">
        {!p.ghost && p.chats.map((c) => (
          <li key={c.id} className={c.id === p.currentId ? "on" : ""}>
            <button type="button" className="session" onClick={() => p.onOpen(c)} aria-current={c.id === p.currentId ? "true" : undefined}>
              <span className="title">{c.title}</span>
              <span className="when">{new Date(c.updatedAt).toLocaleDateString()}</span>
            </button>
            {armed === c.id
              ? <button type="button" className="icon-btn del armed" aria-label={`Confirm delete chat ${c.title}`} autoFocus onBlur={() => setArmed("")}
                  onClick={() => { setArmed(""); p.onDelete(c); }}><Check weight="bold" aria-hidden /></button>
              : <button type="button" className="icon-btn del" aria-label={`Delete chat ${c.title}`} onClick={() => setArmed(c.id)}><Trash aria-hidden /></button>}
          </li>
        ))}
        {!p.ghost && !p.chats.length && <li className="empty">{p.query ? "No matching chats" : "No chats yet"}</li>}
      </ul>
      <button type="button" className={`account-chip ${p.account?.signedIn ? "on" : ""}`} data-testid="account-chip" onClick={p.onAccount}>
        <UserCircle weight={p.account?.signedIn ? "fill" : "regular"} aria-hidden />
        {p.account?.signedIn
          ? <span><b>Signed in</b><span className="muted"> · {p.account.id}</span></span>
          : <span><b>Sign in</b><span className="muted"> · or create an account</span></span>}
      </button>
      <UsageMeter tier={p.tier} usage={p.usage} onUpgrade={p.onUpgrade} />
    </aside>
  );
}
