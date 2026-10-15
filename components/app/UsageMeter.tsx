"use client";
import type { Tier } from "@/lib/tiers";

export interface Usage { remaining: number; limit?: number }

/** Plan + today's usage. Display only: limits are enforced server-side (lib/ratelimit.ts). */
export function UsageMeter({ tier, usage, onUpgrade }: { tier: Tier | null; usage: Usage | null; onUpgrade: () => void }) {
  const limit = usage?.limit ?? tier?.dailyMessages;
  const used = limit != null && usage ? Math.max(0, limit - usage.remaining) : null;
  const pct = limit && used != null ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return (
    <div className="usage" data-testid="usage">
      <div className="row between">
        <span className={`plan plan-${tier?.id ?? "free"}`} data-testid="plan">{tier ? tier.name : "…"}</span>
        {tier?.id !== "max" && <button type="button" className="link" onClick={onUpgrade}>Upgrade</button>}
      </div>
      <div className="bar" role="progressbar" aria-label="Messages used today" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><div style={{ width: `${pct}%` }} /></div>
      <div className="small muted">{usage ? `${usage.remaining} of ${limit ?? "?"} messages left today` : "Loading usage…"}</div>
    </div>
  );
}
