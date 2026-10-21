"use client";
import { useEffect, useRef, useState } from "react";
import { ArrowClockwise, CheckCircle, Circle, CircleDashed, Code, MinusCircle, Question, Shield, ShieldCheck, ShieldSlash, X, XCircle } from "@phosphor-icons/react";
import type { Proof, ProofItem } from "@/lib/client/proof";
import { PROVIDER_LABEL } from "@/lib/client/providers";
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

// Plain-language status (the design's wording). "verified" is only reachable when the certificate chain is verified (lib/client/proof.ts).
const STATUS: Record<Proof["level"], string> = {
  verified: "Running in a verified enclave. Hardware chain verified.",
  "checks-passed": "Enclave checks passed",
  "gateway-checked": "The provider's gateway passed its enclave checks, but the model behind it is not attested.",
  "server-checked": "Our server checked this enclave's attestation and code with the Tinfoil SDK before sending. Your browser cannot re-check it.",
  failed: "An enclave check failed. Don't send anything sensitive to this model.",
  unavailable: "No enclave proof is available right now.",
  pending: "Checking…",
  "no-enclave": "No enclave.",
};

// The design's note under the status line.
const NOTE: Partial<Record<Proof["level"], string>> = {
  "checks-passed": "The hardware certificate chain is not checked yet, so this is not a full proof.",
};

/** The design's five key checks, read from the model enclave's report: label, and what a pass means. */
const KEY_CHECKS: { id: string; label: string; pass: string }[] = [
  { id: "nonce echoed", label: "Nonce echoed in report", pass: "matches this browser's nonce" },
  { id: "debug mode off", label: "Debug mode off", pass: "production enclave" },
  { id: "report_data binds signer+nonce", label: "Signer bound to report", pass: "hash matches" },
  { id: "gpu evidence nonce", label: "GPU evidence", pass: "nonce matches" },
  { id: "dcap-chain", label: "Certificate chain", pass: "verified" },
];

function KeyChecks({ items }: { items: ProofItem[] }) {
  const rows = KEY_CHECKS.flatMap((k) => { const i = items.find((x) => x.id === k.id); return i ? [{ ...k, state: i.state }] : []; });
  if (!rows.length) return null;
  return (
    <ul className="key-checks" data-testid="key-checks">
      {rows.map((k) => (
        <li key={k.id} className={`key-check s-${k.state}`}>
          <span className="ico">{k.state === "pass" ? <CheckCircle weight="fill" aria-hidden /> : k.state === "fail" ? <XCircle weight="fill" aria-hidden /> : <CircleDashed aria-hidden />}</span>
          <span>{k.label}<span className="st">{k.state === "pass" ? k.pass : k.state === "fail" ? "failed" : "not checked yet"}</span></span>
        </li>
      ))}
    </ul>
  );
}

function checkCount(items: ProofItem[]): string {
  const run = items.filter((i) => i.state !== "not-checked");
  const open = items.length - run.length;
  return `${run.filter((i) => i.state === "pass").length} of ${run.length} checks passed${open ? ` · ${open} not checked yet` : ""}`;
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
/** `autoNote`: which route Auto is using and why (lib/client/levels.ts autoRouteNote), when Auto chose it. */
export function ProofDrawer({ proof, open, onClose, onRecheck, onExplain, modelName, privacy, autoNote }: { proof: Proof | null; open: boolean; onClose: () => void; onRecheck: () => void; onExplain?: () => void; modelName?: string; privacy?: string; autoNote?: string }) {
  const [showRaw, setShowRaw] = useState(false);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; });
  // Move focus into the drawer on open and back to whatever opened it on close.
  useEffect(() => {
    if (!open) return;
    const back = document.activeElement as HTMLElement | null;
    closeBtn.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !document.querySelector("dialog[open]")) closeRef.current(); }; // Escape in a modal on top closes only that
    addEventListener("keydown", onKey);
    return () => { removeEventListener("keydown", onKey); setTimeout(() => { if (back?.isConnected) back.focus(); }); }; // after this commit: <main> may still be inert on mobile
  }, [open]);
  if (!open) return null;
  const title = proof?.level === "no-enclave" ? "Privacy details" : "Enclave proof";
  const items = proof?.reports.flatMap((r) => r.items) ?? [];
  const provider = proof?.modelRef.split(":")[0] ?? "";
  const gatewayName = PROVIDER_LABEL[provider] ?? provider;
  const failed = items.filter((i) => i.state === "fail");
  return (
    <aside className="drawer" data-testid="proof-drawer" aria-label={title}>
      <header className="drawer-head">
        <h2>{title}</h2>
        <button type="button" className="icon-btn" ref={closeBtn} onClick={onClose} aria-label={`Close ${title.toLowerCase()}`}><X aria-hidden /></button>
      </header>
      {!proof ? <p className="drawer-body muted">Checking…</p> : proof.level === "no-enclave" ? (
        <div className="drawer-body">
          <section className="summary lvl-no-enclave" data-testid="proof-summary">
            <p className="summary-title"><ShieldSlash aria-hidden /><strong>No enclave for this model</strong></p>
            <p className="summary-note">{privacy === "anonymized" ? "Your identity is stripped at our relay; the model runs at the provider without hardware isolation. The vendor sees the prompt and reply; we cannot prove what it does with them."
              : privacy === "private" ? "Zero-retention by contract with the provider, without hardware isolation. The vendor sees the prompt and reply; we cannot prove what it does with them."
              : "No enclave attestation applies: the vendor sees the prompt and reply, and we cannot prove what it does with them."}</p>
            {autoNote && <p className="summary-note" data-testid="auto-note">{autoNote}</p>}
            <dl className="facts"><div><dt>Model</dt><dd><code>{proof.modelRef}</code></dd></div></dl>
          </section>
        </div>
      ) : (
        <div className="drawer-body">
          <section className={`summary lvl-${proof.level}`} data-testid="proof-summary">
            <p className="summary-title"><SummaryIcon level={proof.level} /><strong data-testid="drawer-chain-status">{STATUS[proof.level]}</strong></p>
            {NOTE[proof.level] && <p className="summary-note">{NOTE[proof.level]}</p>}
            {autoNote && <p className="summary-note" data-testid="auto-note">{autoNote}</p>}
            <dl className="facts">
              <div><dt>Model</dt><dd>{modelName ? <>{modelName} <code className="muted">{proof.modelRef}</code></> : <code>{proof.modelRef}</code>}</dd></div>
              <div><dt>Provider</dt><dd>{gatewayName}</dd></div>
              <div><dt>Checked</dt><dd>{new Date(proof.checkedAt).toLocaleTimeString()}</dd></div>
              <div><dt>Checks</dt><dd data-testid="check-count">{items.length ? checkCount(items) : proof.level === "server-checked" ? "Run on our server by the Tinfoil SDK, not in this browser" : "None this browser could run"}</dd></div>
            </dl>
          </section>

          <KeyChecks items={proof.reports.find((rp) => rp.role === "model")?.items ?? items} />

          {failed.length > 0 && (
            <section className="report" data-testid="failed-checks">
              <h3>Failed</h3>
              <ul className="proof-list">{failed.map((i) => <Item key={`${i.scope}-${i.id}`} i={i} />)}</ul>
            </section>
          )}

          <div className="row gap wrap drawer-actions">
            <button type="button" className="btn" data-testid="verify" onClick={onRecheck}><ArrowClockwise aria-hidden />Re-check now</button>
            {onExplain && <button type="button" className="link explain-link" onClick={onExplain}><Question weight="duotone" aria-hidden />What do these privacy modes mean?</button>}
          </div>

          <details className="tech">
            <summary>Technical details</summary>
            <dl className="facts">
              <div><dt>Certificate chain</dt><dd className={proof.chainVerified ? "c-ok" : "c-warn"}>
                {proof.chainVerified ? <CheckCircle weight="fill" aria-hidden /> : <MinusCircle aria-hidden />}
                <b>{proof.chainVerified ? "verified" : "NOT verified"}</b></dd></div>
              {proof.signingAddress && <div><dt>Enclave signing key</dt><dd><CopyHash value={proof.signingAddress} label="enclave signing key" short /></dd></div>}
            </dl>
            <p className="summary-note">
              {proof.chainVerified ? "The hardware quote chains to the vendor root." :
                "We check that the quote is fresh, bound to the enclave's signing key and not in debug mode, but we do not yet check that it was signed by genuine Intel/NVIDIA hardware. Until then we never call this \"Verified\"."}
            </p>

            {proof.reports.map((r, idx) => (
              <section key={idx} className="report">
                <h3>{r.role === "gateway" ? `${gatewayName} gateway (TDX)` : "Model enclave (TDX + GPU)"}</h3>
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
              {proof.level === "server-checked" ? (
                <p className="small muted" data-testid="tinfoil-signature-note">Tinfoil does not sign each reply, so replies show no signature. The enclave check above ran on our server before anything was sent.</p>
              ) : proof.level === "gateway-checked" ? (
                <p className="small muted" data-testid="gateway-signature-note">Replies are not signature-checked here: only the gateway is attested, so a signature from its key would not show that the model&apos;s enclave produced the reply.</p>
              ) : <p className="small muted">After each reply we fetch the enclave&apos;s signature over the exact request/response hashes and check it recovers to the attested signing key. While the certificate chain is not verified, that key comes from an unverified quote, so a match reads “signature matches the enclave&apos;s reported key · chain not verified”, not “signed by enclave”.</p>}
            </section>

            <button type="button" className="btn ghost drawer-actions" aria-expanded={showRaw} onClick={() => setShowRaw((v) => !v)}><Code aria-hidden />{showRaw ? "Hide" : "Show"} raw result</button>
            {showRaw && <pre className="raw">{JSON.stringify(proof, null, 2)}</pre>}
          </details>
        </div>
      )}
    </aside>
  );
}
