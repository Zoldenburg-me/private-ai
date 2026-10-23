import type { ProviderConfig } from "./providers";
import { LIQUID_MODELS, VENICE_PRIVATE, canonicalModelId } from "./provider-models";
import { providerFetch } from "./provider-fetch";
import { PAID_ONLY_MODELS } from "./tiers";

export type Privacy = "tee" | "private" | "anonymized";

export interface ModelEntry {
  id: string;
  provider: string;
  name: string;
  privacy: Privacy;
  tee: boolean;
  e2ee: boolean;
  contextLength?: number;
  selectable: boolean;
  /** USD per 1M tokens, from the provider's own /models listing. */
  price?: { in: number; out: number };
  /** Paid plans only (PAID_ONLY_MODELS). */
  paid?: boolean;
  /** Behind an anonymizing gateway (Venice, Liquid): its own quota and picker group. A zero-retention contract provider is not incognito. */
  incognito?: true;
}

/** Providers whose entire catalogue runs in attested TEEs (per their public docs). NEAR is not one: see nearAttested. */
const ALL_TEE = new Set(["phala", "tinfoil", "privatemode", "mock"]);

type Raw = Record<string, unknown>;

const bool = (v: unknown) => v === true || v === "true";
/** `w` as its own token (tee-attested, tdx_tee1), never inside a word (guarantee) or negated (non-tee, not private). */
const word = (t: string, w: string) => new RegExp(`(^|[^a-z])${w}`).test(t) && !new RegExp(`(^|[^a-z])(non|no|not)[\\s_-]*${w}`).test(t);
/** A missing or blank price is unknown, never free. */
const num = (v: unknown) => (typeof v === "number" || (typeof v === "string" && v.trim() !== "") ? Number(v) : NaN);

/** Tinfoil lists USD per 1M tokens; NEAR and Phala use OpenRouter's USD-per-token strings. */
function priceOf(raw: Raw): ModelEntry["price"] {
  if (!raw.pricing || typeof raw.pricing !== "object") return undefined; // `in` below throws on a string or number
  const p = raw.pricing as Raw;
  const [i, o] = "inputTokenPricePer1M" in p ? [num(p.inputTokenPricePer1M), num(p.outputTokenPricePer1M)] : [num(p.prompt) * 1e6, num(p.completion) * 1e6];
  return i >= 0 && o >= 0 ? { in: i, out: o } : undefined;
}

/**
 * Normalise one provider /models entry into our catalog entry using whatever privacy metadata it exposes.
 * `nearAttested` is NEAR's /model/list verdict for this model; NEAR's own /models hints are never trusted.
 */
export function normaliseModel(provider: Pick<ProviderConfig, "id" | "privacy">, raw: Raw, nearAttested = false): ModelEntry {
  const id = String(raw.id ?? raw.model_id ?? raw.modelId ?? "");
  // Paid plans only, whichever provider serves it (a Venice alias counts as its canonical id).
  const paid = PAID_ONLY_MODELS.has(canonicalModelId(id)) ? { paid: true } : {};
  const spec = (raw.model_spec && typeof raw.model_spec === "object" && !Array.isArray(raw.model_spec) ? raw.model_spec : {}) as Raw;
  // Liquid's /models has no display names.
  const name = [raw.name, raw.display_name, spec.name].find((n): n is string => typeof n === "string" && n !== "")
    ?? (provider.id === "liquid" && Object.hasOwn(LIQUID_MODELS, id) ? LIQUID_MODELS[id] : id);
  // Nothing behind a gateway can be attested: never TEE or E2EE. PRIVATE only for Venice's pinned self-run models, and only while Venice still says so.
  if (provider.privacy === "anon-gateway") {
    const privacy = provider.id === "venice" && VENICE_PRIVATE.has(id) && spec.privacy === "private" ? "private" : "anonymized";
    return { id, provider: provider.id, name, privacy, tee: false, e2ee: false, contextLength: ctxOf(raw), selectable: true, incognito: true, ...paid };
  }
  if (provider.id === "near")
    return { id, provider: provider.id, name, privacy: nearAttested ? "tee" : "anonymized", tee: nearAttested, e2ee: false, contextLength: ctxOf(raw), selectable: nearAttested, price: priceOf(raw), ...paid };
  const caps = (raw.capabilities ?? {}) as Raw;
  const meta = (raw.metadata ?? {}) as Raw;
  const privacyText = String(raw.privacy ?? raw.privacy_tier ?? meta.privacy ?? "").toLowerCase();
  const tee =
    bool(raw.tee) || bool(raw.is_tee) || bool(caps.tee) || bool(caps.supports_tee) || bool(raw.confidential) ||
    word(privacyText, "tee") || word(privacyText, "confidential") ||
    (ALL_TEE.has(provider.id) && !privacyText.includes("anonym"));
  const e2ee = bool(raw.e2ee) || bool(caps.e2ee) || bool(caps.supports_e2ee);
  const zdr = bool(raw.zdr) || bool(meta.zdr) || word(privacyText, "private") || word(privacyText, "zdr") || provider.privacy === "zdr-contract";
  const privacy: Privacy = tee ? "tee" : zdr ? "private" : "anonymized";
  return {
    id,
    provider: provider.id,
    name,
    privacy,
    tee,
    e2ee,
    contextLength: ctxOf(raw),
    selectable: isSelectable(privacy) && chatCapable(provider.id, raw),
    price: priceOf(raw),
    ...paid,
  };
}

/**
 * Tinfoil and Privatemode also list embedding, speech, safety and tool models. Only Tinfoil's type "chat" and
 * Privatemode's task "generate" can answer a chat; an entry without the field is left to the other checks.
 */
function chatCapable(provider: string, raw: Raw): boolean {
  if (provider === "tinfoil") return raw.type === undefined || raw.type === "chat";
  if (provider === "privatemode") return !Array.isArray(raw.tasks) || raw.tasks.includes("generate");
  return true;
}

function ctxOf(raw: Raw): number | undefined {
  const ctx = Number(raw.context_length ?? raw.contextLength ?? raw.max_model_len ?? NaN);
  return Number.isFinite(ctx) ? ctx : undefined;
}

/**
 * TEE-attested or contractual zero-retention models may be selected. "anonymized" from any other
 * provider stays blocked: only the anonymizing gateway (normaliseModel above) strips the identity.
 */
export function isSelectable(p: Privacy): boolean {
  return p === "tee" || p === "private";
}

export const UPSTREAM_TIMEOUT_MS = 10_000;

/** One provider's /models, normalised. Throws when the provider fails or times out. */
export async function fetchProviderModels(p: ProviderConfig, fetchImpl: typeof fetch = providerFetch(p.id)): Promise<ModelEntry[]> {
  const r = await fetchImpl(`${p.baseUrl}/models`, { headers: { Authorization: `Bearer ${p.apiKey}` }, cache: "no-store", signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  if (!r.ok) throw new Error(String(r.status));
  const j = (await r.json()) as { data?: Raw[] } | Raw[];
  const listed = Array.isArray(j) ? j : j.data ?? [];
  const attested = p.id === "near" ? await nearAttested(p, fetchImpl) : undefined;
  return listed
    .map((m) => normaliseModel(p, m, attested?.has(String(m.id ?? m.model_id ?? m.modelId))))
    .filter((m) => m.id && (!p.models || p.models.includes(m.id)))
    .sort((a, b) => (p.models ? p.models.indexOf(a.id) - p.models.indexOf(b.id) : 0)); // allowlist order is picker order
}

/**
 * NEAR's /models also lists externally proxied closed models with no field telling them apart;
 * only /model/list says which ones run attested. Throws if it is unreachable, so NEAR fails closed.
 */
async function nearAttested(p: ProviderConfig, fetchImpl: typeof fetch): Promise<Set<string>> {
  // shortcut: one page of 1000; models past it count as not attested, which is the safe side.
  const r = await fetchImpl(`${p.baseUrl}/model/list?limit=1000`, { headers: { Authorization: `Bearer ${p.apiKey}` }, cache: "no-store", signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  if (!r.ok) throw new Error(String(r.status));
  const j = (await r.json()) as { models?: Raw[] };
  return new Set((j.models ?? []).filter((m) => ((m.metadata ?? {}) as Raw).attestationSupported === true).map((m) => String(m.modelId)));
}

/** What a provider offers when its /models call fails: its allowlist if set, else its configured default model. */
export const fallbackModels = (p: ProviderConfig): ModelEntry[] =>
  (p.models ?? (p.defaultModel ? [p.defaultModel] : [])).map((id) => normaliseModel(p, { id }));

export async function fetchCatalog(providers: ProviderConfig[], fetchImpl?: typeof fetch): Promise<ModelEntry[]> {
  const lists = await Promise.all(providers.map((p) => fetchProviderModels(p, fetchImpl).catch(() => fallbackModels(p))));
  return lists.flat();
}

export function findSelectable(catalog: ModelEntry[], provider: string, model: string): ModelEntry | undefined {
  return catalog.find((m) => m.provider === provider && m.id === model && m.selectable);
}
