import type { ModelEntry, Privacy } from "@/lib/catalog";
import { DEFS } from "@/lib/providers";
import { ENABLED_PROVIDERS, PROVIDER_LABEL } from "@/lib/client/providers";
import { LEVELS, levelModels } from "@/lib/client/levels";
import { modelGroup, TIERS, type TierId } from "@/lib/tiers";

/** One row of the public /models page: only what the live catalog says, nothing invented. */
export interface ModelRow {
  key: string; name: string; maker?: string; provider: string; providerName: string;
  privacy: Privacy; incognito: boolean; ctx?: number; plan: "free" | "plus";
}

export const PRIVACY_ORDER: Privacy[] = ["tee", "private", "anonymized"];
const shortName = (id: string) => PROVIDER_LABEL[id] ?? DEFS.find((d) => d.id === id)?.name.replace(/\s*\(.*\)$/, "") ?? id;

/** The models a user can actually pick in the chat, one row per model and privacy level (same dedupe as the picker's levels). */
export function toRows(catalog: ModelEntry[]): ModelRow[] {
  const offered = catalog.filter((m) => m.selectable && (ENABLED_PROVIDERS as readonly string[]).includes(m.provider));
  return LEVELS.flatMap((l) => levelModels(offered, l.id, false)).map((m) => {
    // Providers often name a model "Maker: Model"; split it rather than guess a maker.
    const i = m.name.indexOf(": ");
    return {
      key: `${m.provider}:${m.id}`, name: i > 0 ? m.name.slice(i + 2) : m.name, ...(i > 0 ? { maker: m.name.slice(0, i) } : {}),
      provider: m.provider, providerName: shortName(m.provider), privacy: m.privacy, incognito: !!m.incognito,
      ...(m.contextLength ? { ctx: m.contextLength } : {}),
      // The cheapest plan the chat lets in: paid-only and top Max Privacy models start at Plus (lib/handler.ts).
      plan: m.paid || modelGroup(m) === "top" ? "plus" : "free",
    };
  });
}

export interface Filters { query: string; providers: string[]; privacy: Privacy[]; plan: TierId | null }
export type FilterKey = "query" | "providers" | "privacy" | "plan";
export const NO_FILTERS: Filters = { query: "", providers: [], privacy: [], plan: null };

const PLAN_RANK: Record<TierId, number> = { free: 0, plus: 1, pro: 2, max: 3 };
/** `skip` leaves one filter out, so each option's count shows what picking it would give. */
export function passes(r: ModelRow, f: Filters, skip?: FilterKey): boolean {
  const q = f.query.trim().toLowerCase();
  return (skip === "query" || !q || `${r.name} ${r.maker ?? ""} ${r.providerName}`.toLowerCase().includes(q))
    && (skip === "providers" || !f.providers.length || f.providers.includes(r.provider))
    && (skip === "privacy" || !f.privacy.length || f.privacy.includes(r.privacy))
    && (skip === "plan" || !f.plan || PLAN_RANK[r.plan] <= PLAN_RANK[f.plan]);
}

/** Context a plan actually gets on this model: the smaller of the model's window and the plan cap. */
export const ctxOn = (r: ModelRow, plan: TierId | null) => (r.ctx && plan ? Math.min(r.ctx, TIERS[plan].maxContextTokens) : r.ctx);
export const fmtCtx = (n?: number) => (n == null ? "—" : n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`);

export type SortKey = "name" | "privacy" | "provider" | "ctx" | "plan";
const CMP: Record<SortKey, (a: ModelRow, b: ModelRow) => number> = {
  name: (a, b) => a.name.localeCompare(b.name),
  privacy: (a, b) => PRIVACY_ORDER.indexOf(a.privacy) - PRIVACY_ORDER.indexOf(b.privacy),
  provider: (a, b) => a.providerName.localeCompare(b.providerName),
  ctx: (a, b) => (a.ctx ?? 0) - (b.ctx ?? 0),
  plan: (a, b) => PLAN_RANK[a.plan] - PLAN_RANK[b.plan],
};
export const sortRows = (rows: ModelRow[], key: SortKey, dir: 1 | -1) => [...rows].sort((a, b) => CMP[key](a, b) * dir || a.name.localeCompare(b.name));
