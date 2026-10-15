"use client";
import { useState } from "react";
import { CheckCircle, MinusCircle, Shield, ShieldCheck, ShieldSlash, XCircle } from "@phosphor-icons/react";

export type DemoLevel = "verified" | "checks-passed" | "failed" | "unavailable";
type Tone = "ok" | "warn" | "bad" | "muted";

const LEVELS: DemoLevel[] = ["checks-passed", "verified", "failed", "unavailable"];
const TONE: Record<DemoLevel, Tone> = { verified: "ok", "checks-passed": "warn", failed: "bad", unavailable: "muted" };
const TAB: Record<DemoLevel, string> = { "checks-passed": "Today", verified: "Verified", failed: "Failed", unavailable: "No proof" };
const SIGNATURE: Record<DemoLevel, string> = {
  verified: "signed by enclave",
  "checks-passed": "signature matches the enclave's reported key · chain not verified",
  failed: "signature mismatch",
  unavailable: "signature not available",
};
const MEANING: Record<DemoLevel, string> = {
  verified: "Shown only once the Intel and NVIDIA certificate chain is verified. This app does not check the chain yet, so you will not see this today.",
  "checks-passed": "The default today. The quote is fresh, bound to the enclave's signing key and not in debug mode. The certificate chain is not checked yet.",
  failed: "A check failed. The proof drawer in the app shows which one.",
  unavailable: "The model returned no attestation, so there is nothing to check.",
};

function BadgeIcon({ level }: { level: DemoLevel }) {
  if (level === "verified") return <ShieldCheck weight="fill" aria-hidden />;
  if (level === "checks-passed") return <Shield weight="duotone" aria-hidden />;
  if (level === "failed") return <ShieldSlash aria-hidden />;
  return <Shield aria-hidden />;
}

function SigIcon({ level }: { level: DemoLevel }) {
  if (level === "verified") return <CheckCircle weight="fill" aria-hidden />;
  if (level === "checks-passed") return <CheckCircle aria-hidden />;
  if (level === "failed") return <XCircle aria-hidden />;
  return <MinusCircle aria-hidden />;
}

/** The four proof states, shown the way the chat shows them. Labels come from the app's own proof model. */
export function ProofDemo({ labels }: { labels: Record<DemoLevel, string> }) {
  const [level, setLevel] = useState<DemoLevel>("checks-passed");
  const tone = TONE[level];
  return (
    <div className="proof-demo">
      <div className="seg" role="group" aria-label="Proof state">
        {LEVELS.map((l) => (
          <button key={l} type="button" aria-pressed={l === level} onClick={() => setLevel(l)}>{TAB[l]}</button>
        ))}
      </div>
      <div className="demo-card">
        <div className="demo-top">
          <span className="demo-model">Open model <span className="tag-ok">TEE</span></span>
          <span className={`badge tone-${tone}`}>
            <BadgeIcon level={level} />
            <span>{labels[level].split(" · ")[0]}</span>
            {level !== "unavailable" && <span className="chain">{level === "verified" ? "chain ✓" : "chain unverified"}</span>}
          </span>
        </div>
        <p className="demo-reply">Here is a plain-language summary of clause 4.2 and the two terms that differ from your template.</p>
        <p className={`l-sig tone-${tone}`}><SigIcon level={level} />{SIGNATURE[level]}</p>
      </div>
      <p className="demo-meaning" aria-live="polite">{MEANING[level]}</p>
    </div>
  );
}
