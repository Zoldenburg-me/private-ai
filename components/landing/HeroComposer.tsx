"use client";
import { useState, type FormEvent, type KeyboardEvent } from "react";
import Link from "next/link";
import { ArrowUp, ImageSquare, ListChecks, LockSimple, MagnifyingGlass, Plus, ShieldCheck } from "@phosphor-icons/react";
import { chatUrl } from "./chat-url";

// The tools live in the chat's "+" menu; these open the chat where they are one click away.
const TOOLS = [
  { icon: MagnifyingGlass, label: "Search the web privately" },
  { icon: ImageSquare, label: "Create an image" },
  { icon: ListChecks, label: "Run an agentic task" },
  { icon: ShieldCheck, label: "Open a locked chat" },
] as const;

/** The hero's chat bar: opens a ghost chat with the prompt in the URL fragment (never sent to the server). */
export function HeroComposer() {
  const [text, setText] = useState("");
  const go = (t: string) => { const url = chatUrl(t); if (url) location.assign(url); };
  const submit = (e: FormEvent) => { e.preventDefault(); go(text); };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // isComposing: Enter that confirms an IME candidate must not send.
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); go(text); }
  };

  return (
    <div className="dock">
      <form className="l-composer" onSubmit={submit}>
        {/* No name: a pre-hydration native submit must not put the prompt in a query string. */}
        <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey}
          placeholder="Ask anything, privately" aria-label="Ask anything, privately" enterKeyHint="send" autoComplete="off" />
        <div className="l-composer-bar">
          <Link href="/chat" className="l-composer-plus" aria-label="Attach a file in the chat"><Plus aria-hidden /></Link>
          {/* DEFAULT_MODE is the enclave (Max) level; a visitor's saved pick can change it, hence "by default". */}
          <span className="l-composer-mode" title="Max Privacy by default">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/narwhal-tee.svg" alt="" width={22} height={22} />Max Privacy
          </span>
          <button type="submit" className="l-composer-send" disabled={!text.trim()} aria-label="Send"><ArrowUp weight="bold" aria-hidden /></button>
        </div>
      </form>
      <div role="group" aria-label="Start with" className="quick">
        <Link href="/chat" className="qs qs-wide"><LockSimple aria-hidden className="qs-ok" />Max Privacy chat</Link>
        {TOOLS.map(({ icon: Icon, label }) => <Link key={label} href="/chat" className="qs" aria-label={label} title={label}><Icon aria-hidden /></Link>)}
      </div>
    </div>
  );
}
