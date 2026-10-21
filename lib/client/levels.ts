import type { ModelEntry } from "@/lib/catalog";
import { canonicalModelId } from "@/lib/provider-models";
import { fallbackOf, isBenched, type Proof } from "./proof";
import { PROVIDER_LABEL, autoEntryOf, type AutoEntry } from "./providers";

/** Privacy levels in the chat bar: where a prompt runs. Max = attested enclave, Medium = zero-retention, Anon = anonymized gateway. */
export type Level = "max" | "medium" | "anon";
export const LEVELS: { id: Level; label: string; note: string }[] = [
  { id: "max", label: "Max", note: "Attested enclave (TEE)" },
  { id: "medium", label: "Medium", note: "Zero-retention provider, no enclave" },
  { id: "anon", label: "Anon", note: "Anonymized gateway, no identity sent" },
];
export const isLevel = (v: unknown): v is Level => LEVELS.some((l) => l.id === v);

/** The per-level pick that means "let Auto choose model and provider". */
export const AUTO = "auto";

/**
 * Medium/Anon Auto, best first (canonical ids, none paid-only). Ranked by hand on price, latency and uptime;
 * shortcut: no measured uptime or latency yet (we store none), so recheck this list when the catalog changes.
 */
export const INCOGNITO_AUTO = ["deepseek-v4.1-flash", "qwen3.8-27b", "glm-5.3", "kimi-k3"];

const refOf = (m: ModelEntry) => `${m.provider}:${m.id}`;
const providerOf = (ref: string) => ref.slice(0, ref.indexOf(":"));
const label = (provider: string) => PROVIDER_LABEL[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);

export const levelOf = (m: ModelEntry): Level => (m.privacy === "tee" ? "max" : m.privacy === "private" ? "medium" : "anon");

/**
 * The rows the picker offers on a level when Auto is off. Without provider choice each model shows once and its
 * provider is chosen for the user (on Max through its Auto entry, which routes to the cheapest passing enclave).
 */
export function levelModels(models: ModelEntry[], level: Level, pickProvider: boolean): ModelEntry[] {
  const rows = models.filter((m) => levelOf(m) === level);
  const fixed = rows.filter((m) => m.provider !== "auto");
  if (pickProvider) return fixed;
  if (level === "max") {
    const autos = rows.filter((m) => m.provider === "auto");
    const routed = new Set(autos.flatMap((a) => (a as AutoEntry).routes ?? []));
    return [...autos, ...fixed.filter((m) => !routed.has(refOf(m)))];
  }
  return fixed.filter((m, i) => fixed.findIndex((x) => canonicalModelId(x.id) === canonicalModelId(m.id)) === i);
}

/** What Auto sends to on a level: Max = the first curated Auto entry; Medium/Anon = the first listed model that has not failed recently. */
export function autoRef(models: ModelEntry[], level: Level, failedAt: Record<string, number>, now = Date.now()): string {
  const rows = models.filter((m) => levelOf(m) === level && m.selectable && !m.paid);
  if (level === "max") { const m = rows.find((x) => x.provider === "auto") ?? rows[0]; return m ? refOf(m) : ""; }
  const ranked = [...INCOGNITO_AUTO.flatMap((id) => rows.filter((m) => canonicalModelId(m.id) === id)), ...rows];
  const m = ranked.find((x) => !isBenched(refOf(x), failedAt, now)) ?? ranked[0];
  return m ? refOf(m) : "";
}

/** The model ref a level's pick sends to: the pick while the picker offers it (Pick a provider included), otherwise Auto. */
export function resolveRef(models: ModelEntry[], level: Level, pick: string, pickProvider: boolean, failedAt: Record<string, number>, now = Date.now()): string {
  if (pick !== AUTO && levelModels(models, level, pickProvider).some((m) => refOf(m) === pick && m.selectable)) return pick;
  return autoRef(models, level, failedAt, now);
}

/** One line on which route Auto is using and why, for the picker and the proof sheet; undefined when Auto is off. */
export function autoRouteNote(o: { models: ModelEntry[]; ref: string; auto: boolean; proof: Proof | undefined; failedAt: Record<string, number>; now?: number }): string | undefined {
  const now = o.now ?? Date.now();
  const entry = autoEntryOf(o.models, o.ref);
  if (!entry) {
    if (!o.auto || !o.ref) return undefined;
    const m = o.models.find((x) => refOf(x) === o.ref);
    return `Auto picked ${m?.name ?? o.ref} via ${label(providerOf(o.ref))}: first on our list (price, speed, uptime) that has not failed in the last few minutes.`;
  }
  const model = entry.name.replace(/^Auto · /, "");
  const benched = entry.routes.filter((r) => isBenched(r, o.failedAt, now)).map((r) => label(providerOf(r)));
  const skipped = benched.length ? ` Skipped for a few minutes after a failed chat: ${benched.join(", ")}.` : "";
  if (!o.proof || o.proof.level === "pending") return `Auto is checking the enclaves that serve ${model}, cheapest first.${skipped}`;
  if (o.proof.level === "unavailable") return `Auto: no enclave serving ${model} passed its proof right now; it checks again shortly.${skipped}`;
  const via = label(providerOf(o.proof.modelRef));
  if (fallbackOf(entry.routes, o.proof)) return `Auto is on the ${via} fallback (its default model): no enclave serving ${model} passed its proof.${skipped}`;
  if (o.proof.modelRef === entry.routes[0]) return `Auto uses ${via}: the cheapest enclave for ${model} whose proof passed.${skipped}`;
  return `Auto uses ${via}: cheaper enclaves for ${model} failed recently or did not pass their proof.${skipped}`;
}
