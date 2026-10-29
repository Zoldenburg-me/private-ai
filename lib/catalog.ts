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
  /** What the model reads and writes ("text", "image", "audio", "embedding"), as the provider reports it; absent when unknown. */
  modalities?: Modalities;
}

export interface Modalities { in: string[]; out: string[] }

/** Providers whose entire catalogue runs in attested TEEs (per their public docs). NEAR is not one: see nearAttested. */
const ALL_TEE = new Set(["tinfoil", "privatemode", "mock"]);
/**
 * Phala marks every model is_tee but routes many to other backends (Chutes, whose attestation this app cannot check,
 * Tinfoil, Privatemode, …), listed per model in `providers` (seen 2026-10-25). Only a model it serves from its own
 * enclaves alone counts as TEE; no routing data means no claim. Its other privacy hints are not trusted.
 */
const phalaOnly = (raw: Raw) => Array.isArray(raw.providers) && raw.providers.length > 0 && raw.providers.every((p) => p === "phala");

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
  const m = modalitiesOf(provider.id, raw);
  const mods = m ? { modalities: m } : {};
  const spec = (raw.model_spec && typeof raw.model_spec === "object" && !Array.isArray(raw.model_spec) ? raw.model_spec : {}) as Raw;
  // Liquid's /models has no display names.
  const name = [raw.name, raw.display_name, spec.name].find((n): n is string => typeof n === "string" && n !== "")
    ?? (provider.id === "liquid" && Object.hasOwn(LIQUID_MODELS, id) ? LIQUID_MODELS[id] : id);
  // Nothing behind a gateway can be attested: never TEE or E2EE. PRIVATE only for Venice's pinned self-run models, and only while Venice still says so.
  if (provider.privacy === "anon-gateway") {
    const privacy = provider.id === "venice" && VENICE_PRIVATE.has(id) && spec.privacy === "private" ? "private" : "anonymized";
    return { id, provider: provider.id, name, privacy, tee: false, e2ee: false, contextLength: ctxOf(raw), selectable: chatCapable(provider.id, raw, mods.modalities), incognito: true, ...paid, ...mods };
  }
  if (provider.id === "near")
    return { id, provider: provider.id, name, privacy: nearAttested ? "tee" : "anonymized", tee: nearAttested, e2ee: false, contextLength: ctxOf(raw), selectable: nearAttested && chatCapable(provider.id, raw, mods.modalities), price: priceOf(raw), ...paid, ...mods };
  const caps = (raw.capabilities ?? {}) as Raw;
  const meta = (raw.metadata ?? {}) as Raw;
  const privacyText = String(raw.privacy ?? raw.privacy_tier ?? meta.privacy ?? "").toLowerCase();
  const tee = provider.id === "phala" ? phalaOnly(raw) :
    bool(raw.tee) || bool(raw.is_tee) || bool(caps.tee) || bool(caps.supports_tee) || bool(raw.confidential) ||
    word(privacyText, "tee") || word(privacyText, "confidential") ||
    (ALL_TEE.has(provider.id) && !privacyText.includes("anonym"));
  const e2ee = bool(raw.e2ee) || bool(caps.e2ee) || bool(caps.supports_e2ee);
  const zdr = provider.id !== "phala" && (bool(raw.zdr) || bool(meta.zdr) || word(privacyText, "private") || word(privacyText, "zdr") || provider.privacy === "zdr-contract");
  const privacy: Privacy = tee ? "tee" : zdr ? "private" : "anonymized";
  return {
    id,
    provider: provider.id,
    name,
    privacy,
    tee,
    e2ee,
    contextLength: ctxOf(raw),
    selectable: isSelectable(privacy) && chatCapable(provider.id, raw, mods.modalities),
    price: priceOf(raw),
    ...paid,
    ...mods,
  };
}

/** A non-empty list of strings; anything else (including []) means the provider did not say. */
const strings = (v: unknown) => (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string") ? v.map((x: string) => x.toLowerCase()) : undefined);
/** Tinfoil's non-chat types; "chat" is read with its `multimodal` flag (image input). */
const TINFOIL_TYPES: Record<string, Modalities> = {
  audio: { in: ["audio"], out: ["text"] },
  tts: { in: ["text"], out: ["audio"] },
  embedding: { in: ["text"], out: ["embedding"] },
};

/** NEAR (and OpenRouter-style lists) report input/output modalities; Tinfoil reports a type. */
function modalitiesOf(provider: string, raw: Raw): Modalities | undefined {
  const arch = (raw.architecture && typeof raw.architecture === "object" ? raw.architecture : {}) as Raw;
  const i = strings(raw.input_modalities ?? arch.inputModalities);
  const o = strings(raw.output_modalities ?? arch.outputModalities);
  if (i && o) return { in: i, out: o };
  if (provider !== "tinfoil") return undefined;
  if (raw.type === "chat") return { in: raw.multimodal === true ? ["text", "image"] : ["text"], out: ["text"] };
  return typeof raw.type === "string" && Object.hasOwn(TINFOIL_TYPES, raw.type) ? TINFOIL_TYPES[raw.type] : undefined;
}

/**
 * Providers also list image, speech, embedding, safety and tool models. A chat model reads and writes text;
 * Tinfoil's type "chat" and Privatemode's task "generate" say so too. An entry without the fields is left to the other checks.
 */
function chatCapable(provider: string, raw: Raw, modalities?: Modalities): boolean {
  if (modalities && !(modalities.in.includes("text") && modalities.out.includes("text"))) return false;
  // NEAR's reranker and PII filter report text in and out; only their empty sampling-parameter list gives them away.
  if (provider === "near") return !(Array.isArray(raw.supported_sampling_parameters) && raw.supported_sampling_parameters.length === 0);
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
  // Safe side: fetch up to 1000 models on the first page; unlisted models are treated as not attested.
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
