"use client";
import { useState } from "react";
import type { Proof, ProofItem } from "@/lib/client/proof";

const STATE_ICON = { pass: "✓", fail: "✗", "not-checked": "–" } as const;
const STATE_TEXT = { pass: "passed", fail: "failed", "not-checked": "not checked" } as const;

function Item({ i }: { i: ProofItem }) {
  return (
    <li className={`proof-item s-${i.state}`} data-testid={`proof-item-${i.id}`}>
      <span className="ico" aria-hidden>{STATE_ICON[i.state]}</span>
      <span className="lbl">{i.label}</span>
      <span className="st">{STATE_TEXT[i.state]}{i.detail ? ` · ${i.detail}` : ""}</span>
    </li>
  );
}

/**
 * Details drawer. Structure inspired by how Maple explains its enclave proof (summary first,
 * then measurements, then what is and is not covered); written from scratch for TDX/NEAR evidence.
 */
export function ProofDrawer({ proof, open, onClose, onRecheck }: { proof: Proof | null; open: boolean; onClose: () => void; onRecheck: () => void }) {
  const [showRaw, setShowRaw] = useState(false);
  if (!open) return null;
  return (
    <aside className="drawer" data-testid="proof-drawer" aria-label="Enclave proof">
      <header className="drawer-head">
        <h2>Enclave proof</h2>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
      </header>
      {!proof ? <p className="muted">Checking…</p> : (
        <div className="drawer-body">
          <section className={`summary lvl-${proof.level}`} data-testid="proof-summary">
            <strong>{proof.label}</strong>
            <p className="muted small">Model <code>{proof.modelRef}</code> · checked {new Date(proof.checkedAt).toLocaleTimeString()}</p>
            <p className="small">
              Certificate chain: <b data-testid="drawer-chain-status">{proof.chainVerified ? "verified" : "NOT verified"}</b>.{" "}
              {proof.chainVerified ? "The hardware quote chains to the vendor root." :
                "We check that the quote is fresh, bound to the enclave's signing key and not in debug mode, but we do not yet check that it was signed by genuine Intel/NVIDIA hardware. Until then we never call this \"Verified\"."}
            </p>
            {proof.signingAddress && <p className="small">Enclave signing key: <code className="mono">{proof.signingAddress}</code></p>}
          </section>

          {proof.reports.map((r, idx) => (
            <section key={idx} className="report">
              <h3>{r.role === "gateway" ? "NEAR AI gateway (TDX)" : "Model enclave (TDX + GPU)"}</h3>
              <ul className="proof-list">{r.items.map((i) => <Item key={i.id} i={i} />)}</ul>
              {r.measurements.length > 0 && (
                <details>
                  <summary>Measurements</summary>
                  <dl className="measurements">
                    {r.measurements.map((m) => (<div key={m.name}><dt>{m.name}</dt><dd className="mono">{m.value}</dd></div>))}
                  </dl>
                  <p className="muted small">Read from the quote body. Compare against published measurements to confirm the exact image.</p>
                </details>
              )}
            </section>
          ))}

          {proof.notVerified.length > 0 && (
            <section className="report" data-testid="not-verified">
              <h3>Not verified by this app (yet)</h3>
              <ul className="plain">{proof.notVerified.map((n) => <li key={n}>{n}</li>)}</ul>
            </section>
          )}

          <section className="report">
            <h3>Per message</h3>
            <p className="small muted">After each reply we fetch the enclave&apos;s signature over the exact request/response hashes and check it recovers to the attested signing key. While the certificate chain is not verified, that key comes from an unverified quote, so a match reads “signature matches the enclave&apos;s reported key · chain not verified”, not “signed by enclave”.</p>
          </section>

          <div className="row gap">
            <button type="button" className="btn" data-testid="verify" onClick={onRecheck}>Re-check now</button>
            <button type="button" className="btn ghost" onClick={() => setShowRaw((v) => !v)}>{showRaw ? "Hide" : "Show"} raw result</button>
          </div>
          {showRaw && <pre className="raw">{JSON.stringify(proof, null, 2)}</pre>}
        </div>
      )}
    </aside>
  );
}
