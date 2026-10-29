"use client";
import { CircleNotch, EyeSlash, Shield, ShieldCheck, ShieldSlash } from "@phosphor-icons/react";
import type { Proof, ProofLevel } from "@/lib/client/proof";

const TONE: Record<ProofLevel, string> = {
  verified: "ok", "checks-passed": "warn", "gateway-checked": "warn", "server-checked": "warn", failed: "bad", unavailable: "muted", pending: "muted", "no-enclave": "muted",
};

function LevelIcon({ level }: { level: ProofLevel }) {
  if (level === "verified" || level === "server-checked") return <ShieldCheck weight="duotone" aria-hidden />;
  if (level === "no-enclave") return <EyeSlash weight="duotone" aria-hidden />;
  if (level === "failed") return <ShieldSlash aria-hidden />;
  if (level === "pending") return <CircleNotch className="spin" aria-hidden />;
  return <Shield aria-hidden />;
}

// The design's short text (where the chat runs); the full label stays the accessible name. Never "Verified" unless level === "verified".
const SHORT: Record<ProofLevel, string> = {
  verified: "Verified", "checks-passed": "Enclave attested", "gateway-checked": "Gateway only", "server-checked": "Server-checked", failed: "Proof failed", unavailable: "No proof", pending: "Checking…", "no-enclave": "Incognito",
};

/** Compact per-model/per-chat proof badge. Click opens the details drawer. */
export function ProofBadge({ proof, onOpen }: { proof: Proof | null; onOpen: () => void }) {
  const level: ProofLevel = proof?.level ?? "pending";
  const label = proof?.label ?? "Checking proof…";
  return (
    <button type="button" className={`proof-badge tone-${TONE[level]}`} data-testid="proof-badge" data-level={level} onClick={onOpen}
      aria-label={label} title={level === "no-enclave" ? "No enclave: this model runs at the vendor" : label}>
      <LevelIcon level={level} />
      <span className="pb-label" data-testid={level === "checks-passed" ? "chain-status" : undefined}>{SHORT[level]}</span>
    </button>
  );
}
