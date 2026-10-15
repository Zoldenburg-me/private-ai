"use client";
import { useEffect, useRef, useState } from "react";
import { ArrowClockwise, CheckCircle, Circle, Code, MinusCircle, Shield, ShieldCheck, ShieldSlash, X, XCircle } from "@phosphor-icons/react";
import type { Proof, ProofItem } from "@/lib/client/proof";
import { CopyHash } from "./CopyHash";

const STATE_TEXT = { pass: "passed", fail: "failed", "not-checked": "not checked" } as const;

function StateIcon({ state }: { state: ProofItem["state"] }) {
  if (state === "pass") return <CheckCircle weight="fill" aria-hidden />;
  if (state === "fail") return <XCircle weight="fill" aria-hidden />;
  return <MinusCircle aria-hidden />;
}

function Item({ i }: { i: ProofItem }) {
  return (
    <li className={`proof-item s-${i.state}`} data-testid={`proof-item-${i.id}`}>
      <span className="ico"><StateIcon state={i.state} /></span>
      <span className="lbl">{i.label}</span>
      <span className="st">{STATE_TEXT[i.state]}{i.detail ? ` · ${i.detail}` : ""}</span>
    </li>
  );
}

function SummaryIcon({ level }: { level: Proof["level"] }) {
  if (level === "verified") return <ShieldCheck weight="fill" aria-hidden />;
  if (level === "checks-passed") return <Shield weight="duotone" aria-hidden />;
  if (level === "failed") return <ShieldSlash aria-hidden />;
  return <Shield aria-hidden />;
}

/**
 * Details drawer. Structure inspired by how Maple explains its enclave proof (summary first,
 * then measurements, then what is and is not covered); written from scratch for TDX/NEAR evidence.
 */
export function ProofDrawer({ proof, open, onClose, onRecheck }: { proof: Proof | null; open: boolean; onClose: () => void; onRecheck: () => void }) {
  const [showRaw, setShowRaw] = useState(false);
  const closeBtn = useRef<HTMLButtonElement>(null);
  // Move focus into the drawer on open and back to whatever opened it on close.
  useEffect(() => {
    if (!open) return;
    const back = document.activeElement as HTMLElement | null;
    closeBtn.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    addEventListener("keydown", onKey);
    return () => { removeEventListener("keydown", onKey); setTimeout(() => { if (back?.isConnected) back.focus(); }); }; // after this commit: <main> may still be inert on mobile
  }, [open, onClose]);
  if (!open) return null;
  return (
    <aside className="drawer" data-testid="proof-drawer" aria-label="Enclave proof">
      <header className="drawer-head">
        <h2>Enclave proof</h2>
        <button type="button" className="icon-btn" ref={closeBtn} onClick={onClose} aria-label="Close enclave proof"><X aria-hidden /></button>
      </header>
      {!proof ? <p className="drawer-body muted">Checking…</p> : (
        <div className="drawer-body">
          <section className={`summary lvl-${proof.level}`} data-testid="proof-summary">
            <p className="summary-title"><SummaryIcon level={proof.level} /><strong>{proof.label}</strong></p>
            <dl className="facts">
              <div><dt>Model</dt><dd><code>{proof.modelRef}</code></dd></div>
              <div><dt>Checked</dt><dd>{new Date(proof.checkedAt).toLocaleTimeString()}</dd></div>
              <div><dt>Certificate chain</dt><dd className={proof.chainVerified ? "c-ok" : "c-warn"}>
                {proof.chainVerified ? <CheckCircle weight="fill" aria-hidden /> : <MinusCircle aria-hidden />}
                <b data-testid="drawer-chain-status">{proof.chainVerified ? "verified" : "NOT verified"}</b></dd></div>
              {proof.signingAddress && <div><dt>Enclave signing key</dt><dd><CopyHash value={proof.signingAddress} label="enclave signing key" short /></dd></div>}
            </dl>
            <p className="summary-note">
              {proof.chainVerified ? "The hardware quote chains to the vendor root." :
                "We check that the quote is fresh, bound to the enclave's signing key and not in debug mode, but we do not yet check that it was signed by genuine Intel/NVIDIA hardware. Until then we never call this \"Verified\"."}
            </p>
          </section>

          {proof.reports.map((r, idx) => (
            <section key={idx} className="report">
              <h3>{r.role === "gateway" ? "NEAR AI gateway (TDX)" : "Model enclave (TDX + GPU)"}</h3>
              <ul className="proof-list">{r.items.map((i) => <Item key={i.id} i={i} />)}</ul>
              {r.measurements.length > 0 && (
                <details className="measure">
                  <summary>Measurements ({r.measurements.length})</summary>
                  <dl className="measurements">
                    {r.measurements.map((m) => (<div key={m.name}><dt>{m.name}</dt><dd><CopyHash value={m.value} label={m.name} /></dd></div>))}
                  </dl>
                  <p className="muted small">Read from the quote body. Compare against published measurements to confirm the exact image.</p>
                </details>
              )}
            </section>
          ))}

          {proof.notVerified.length > 0 && (
            <section className="report" data-testid="not-verified">
              <h3>Not verified by this app (yet)</h3>
              <ul className="not-verified">{proof.notVerified.map((n) => <li key={n}><Circle aria-hidden />{n}</li>)}</ul>
            </section>
          )}

          <section className="report">
            <h3>Per message</h3>
            <p className="small muted">After each reply we fetch the enclave&apos;s signature over the exact request/response hashes and check it recovers to the attested signing key. While the certificate chain is not verified, that key comes from an unverified quote, so a match reads “signature matches the enclave&apos;s reported key · chain not verified”, not “signed by enclave”.</p>
          </section>

          <div className="row gap wrap drawer-actions">
            <button type="button" className="btn" data-testid="verify" onClick={onRecheck}><ArrowClockwise aria-hidden />Re-check now</button>
            <button type="button" className="btn ghost" aria-expanded={showRaw} onClick={() => setShowRaw((v) => !v)}><Code aria-hidden />{showRaw ? "Hide" : "Show"} raw result</button>
          </div>
          {showRaw && <pre className="raw">{JSON.stringify(proof, null, 2)}</pre>}
        </div>
      )}
    </aside>
  );
}
