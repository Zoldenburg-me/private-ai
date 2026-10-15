"use client";
import { useState } from "react";
import { Check, Copy } from "@phosphor-icons/react";

const COPIED_MS = 1500;

/** A hash, key or measurement in mono: middle-truncated when `short`, full and wrapping otherwise, with a copy button. */
export function CopyHash({ value, label, short = false }: { value: string; label: string; short?: boolean }) {
  const [copied, setCopied] = useState(false);
  const shown = short && value.length > 22 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value;
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), COPIED_MS); }
    catch { /* clipboard blocked: the full value stays selectable in the title and raw JSON */ }
  };
  return (
    <span className="hash">
      <code title={value}>{shown}</code>
      <button type="button" className="icon-btn" onClick={copy} aria-label={copied ? `${label} copied` : `Copy ${label}`}>
        {copied ? <Check weight="bold" aria-hidden /> : <Copy aria-hidden />}
      </button>
    </span>
  );
}
