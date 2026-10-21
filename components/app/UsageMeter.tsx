"use client";
import type { Tier } from "@/lib/tiers";

/** `incognito`: the separate daily quota for incognito models. */
export interface Usage { remaining: number; limit?: number; incognito?: boolean }

/** Plan + today's usage. Display only: limits are enforced server-side (lib/ratelimit.ts). */
export function UsageMeter({ tier, usage, onUpgrade }: { tier: Tier | null; usage: Usage | null; onUpgrade: () => void }) {
  const limit = usage?.limit ?? (usage?.incognito ? undefined : tier?.dailyMessages); // never show the standard limit for incognito
  const used = limit != null && usage ? Math.max(0, limit - usage.remaining) : null;
  const pct = limit && used != null ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const kind = usage?.incognito ? "Incognito messages" : "Messages";
  const left = usage ? `${usage.remaining} of ${limit ?? "?"} ${kind.toLowerCase()} left today` : "Loading usage…";
  return (
    <div className="usage" data-testid="usage">
      <div className="row between">
        <span className={`plan plan-${tier?.id ?? "free"}`} data-testid="plan">{tier ? tier.name : "…"}</span>
        {tier?.id !== "max" && <button type="button" className="link" onClick={onUpgrade}>Upgrade</button>}
      </div>
      <div className="bar" role="progressbar" aria-label={`${kind} used today`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-valuetext={left}><div style={{ width: `${pct}%` }} /></div>
      <div className="small muted" aria-live="polite">{left}</div>
    </div>
  );
}
