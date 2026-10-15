"use client";
import { CircleNotch, Shield, ShieldCheck, ShieldSlash } from "@phosphor-icons/react";
import type { Proof, ProofLevel } from "@/lib/client/proof";

const TONE: Record<ProofLevel, string> = {
  verified: "ok", "checks-passed": "warn", failed: "bad", unavailable: "muted", pending: "muted",
};

function LevelIcon({ level }: { level: ProofLevel }) {
  if (level === "verified") return <ShieldCheck weight="fill" aria-hidden />;
  if (level === "checks-passed") return <Shield weight="duotone" aria-hidden />;
  if (level === "failed") return <ShieldSlash aria-hidden />;
  if (level === "pending") return <CircleNotch className="spin" aria-hidden />;
  return <Shield aria-hidden />;
}

/** Compact per-model/per-chat proof badge. Click opens the details drawer. */
export function ProofBadge({ proof, onOpen }: { proof: Proof | null; onOpen: () => void }) {
  const level: ProofLevel = proof?.level ?? "pending";
  const text = proof?.label ?? "Checking proof…";
  return (
    <button type="button" className={`proof-badge tone-${TONE[level]}`} data-testid="proof-badge" data-level={level} onClick={onOpen}
      title="Show enclave proof details">
      <LevelIcon level={level} />
      <span className="pb-label">{text.split(" · ")[0]}</span>
      {proof && <span className="chain-pill" data-testid="chain-status">{proof.chainVerified ? "chain ✓" : "chain unverified"}</span>}
    </button>
  );
}
