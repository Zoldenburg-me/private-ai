"use client";
import { useEffect, useRef, useState } from "react";
import { Check, Copy, Warning } from "@phosphor-icons/react";

const COPIED_MS = 1500;

/** A hash, key or measurement in mono: middle-truncated when `short`, full and wrapping otherwise, with a copy button. */
export function CopyHash({ value, label, short = false }: { value: string; label: string; short?: boolean }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const shown = short && value.length > 22 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value;
  const copy = async () => {
    let next: "copied" | "failed" = "copied";
    try { await navigator.clipboard.writeText(value); }
    catch { next = "failed"; } // blocked or insecure context; the full value is still in the raw JSON
    clearTimeout(timer.current); setState(next);
    timer.current = setTimeout(() => setState("idle"), COPIED_MS);
  };
  return (
    <span className="hash">
      <code title={value}>{shown}</code>
      <button type="button" className="icon-btn" onClick={copy} aria-label={state === "copied" ? `${label} copied` : state === "failed" ? `Could not copy ${label}` : `Copy ${label}`}>
        {state === "copied" ? <Check weight="bold" aria-hidden /> : state === "failed" ? <Warning aria-hidden /> : <Copy aria-hidden />}
      </button>
      <span className="sr-only" role="status">{state === "copied" ? `${label} copied` : state === "failed" ? `Could not copy ${label}` : ""}</span>
    </span>
  );
}
