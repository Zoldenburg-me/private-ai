import type { ProviderConfig } from "./providers";

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
}

/** Providers whose entire catalogue runs in attested TEEs (per their public docs). */
const ALL_TEE = new Set(["near", "phala", "tinfoil", "privatemode", "mock"]);

type Raw = Record<string, unknown>;

const bool = (v: unknown) => v === true || v === "true";

/** Normalise one provider /models entry into our catalog entry using whatever privacy metadata it exposes. */
export function normaliseModel(provider: Pick<ProviderConfig, "id" | "privacy">, raw: Raw): ModelEntry {
  const id = String(raw.id ?? raw.model_id ?? raw.modelId ?? "");
  // Whatever the gateway's metadata says, we cannot attest anything behind it: label it anonymized only.
  if (provider.privacy === "anon-gateway") return { id, provider: provider.id, name: String(raw.name ?? raw.display_name ?? id), privacy: "anonymized", tee: false, e2ee: false, contextLength: ctxOf(raw), selectable: true };
  const caps = (raw.capabilities ?? {}) as Raw;
  const meta = (raw.metadata ?? {}) as Raw;
  const privacyText = String(raw.privacy ?? raw.privacy_tier ?? meta.privacy ?? "").toLowerCase();
  const tee =
    bool(raw.tee) || bool(caps.tee) || bool(caps.supports_tee) || bool(raw.confidential) ||
    privacyText.includes("tee") || privacyText.includes("confidential") ||
    (ALL_TEE.has(provider.id) && !privacyText.includes("anonym"));
  const e2ee = bool(raw.e2ee) || bool(caps.e2ee) || bool(caps.supports_e2ee);
  const zdr = bool(raw.zdr) || bool(meta.zdr) || privacyText.includes("private") || privacyText.includes("zdr") || provider.privacy === "zdr-contract";
  const privacy: Privacy = tee ? "tee" : zdr ? "private" : "anonymized";
  return {
    id,
    provider: provider.id,
    name: String(raw.name ?? raw.display_name ?? id),
    privacy,
    tee,
    e2ee,
    contextLength: ctxOf(raw),
    selectable: isSelectable(privacy),
  };
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
export async function fetchProviderModels(p: ProviderConfig, fetchImpl: typeof fetch = fetch): Promise<ModelEntry[]> {
  const r = await fetchImpl(`${p.baseUrl}/models`, { headers: { Authorization: `Bearer ${p.apiKey}` }, cache: "no-store", signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  if (!r.ok) throw new Error(String(r.status));
  const j = (await r.json()) as { data?: Raw[] } | Raw[];
  const arr = Array.isArray(j) ? j : j.data ?? [];
  return arr.map((m) => normaliseModel(p, m)).filter((m) => m.id && (!p.models || p.models.includes(m.id)));
}

/** What a provider offers when its /models call fails: its allowlist if set, else its configured default model. */
export const fallbackModels = (p: ProviderConfig): ModelEntry[] =>
  (p.models ?? (p.defaultModel ? [p.defaultModel] : [])).map((id) => normaliseModel(p, { id }));

export async function fetchCatalog(providers: ProviderConfig[], fetchImpl: typeof fetch = fetch): Promise<ModelEntry[]> {
  const lists = await Promise.all(providers.map((p) => fetchProviderModels(p, fetchImpl).catch(() => fallbackModels(p))));
  return lists.flat();
}

export function findSelectable(catalog: ModelEntry[], provider: string, model: string): ModelEntry | undefined {
  return catalog.find((m) => m.provider === provider && m.id === model && m.selectable);
}
