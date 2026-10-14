"use client";
import type { Proof, ProofLevel } from "@/lib/client/proof";

const TONE: Record<ProofLevel, string> = {
  verified: "ok", "checks-passed": "warn", failed: "bad", unavailable: "muted", pending: "muted",
};
const ICON: Record<ProofLevel, string> = { verified: "✓", "checks-passed": "◐", failed: "✗", unavailable: "○", pending: "…" };

/** Compact per-model/per-chat proof badge. Click opens the details drawer. */
export function ProofBadge({ proof, onOpen }: { proof: Proof | null; onOpen: () => void }) {
  const level: ProofLevel = proof?.level ?? "pending";
  const text = proof?.label ?? "Checking proof…";
  return (
    <button type="button" className={`proof-badge tone-${TONE[level]}`} data-testid="proof-badge" data-level={level} onClick={onOpen}
      title="Show enclave proof details">
      <span aria-hidden>{ICON[level]}</span>
      <span>{text}</span>
      {proof && <span className="chain-pill" data-testid="chain-status">{proof.chainVerified ? "chain ✓" : "chain unverified"}</span>}
    </button>
  );
}
