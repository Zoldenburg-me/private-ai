"use client";
import { useState, type FormEvent, type KeyboardEvent } from "react";
import { ArrowUp } from "@phosphor-icons/react";
import { chatUrl } from "./chat-url";

const CHIPS = ["Draft a sensitive email", "Explain a medical test result", "Plan a budget for next month", "How does this app prove privacy?"] as const;

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
    <>
      <form className="composer" onSubmit={submit}>
        {/* No name: a pre-hydration native submit must not put the prompt in a query string. */}
        <textarea rows={1} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey}
          placeholder="Ask anything privately…" aria-label="Ask anything privately" enterKeyHint="send" autoComplete="off" />
        <button type="submit" className="composer-send" disabled={!text.trim()} aria-label="Send"><ArrowUp weight="bold" aria-hidden /></button>
      </form>
      <ul className="chips" aria-label="Suggestions">
        {CHIPS.map((c) => <li key={c}><button type="button" onClick={() => go(c)}>{c}</button></li>)}
      </ul>
    </>
  );
}
