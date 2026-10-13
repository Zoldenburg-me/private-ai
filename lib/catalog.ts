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
  const ctx = Number(raw.context_length ?? raw.contextLength ?? raw.max_model_len ?? NaN);
  return {
    id,
    provider: provider.id,
    name: String(raw.name ?? raw.display_name ?? id),
    privacy,
    tee,
    e2ee,
    contextLength: Number.isFinite(ctx) ? ctx : undefined,
    selectable: isSelectable(privacy),
  };
}

/** Launch policy: only TEE-attested or contractual zero-retention models may be selected. */
export function isSelectable(p: Privacy): boolean {
  return p === "tee" || p === "private";
}

export async function fetchCatalog(providers: ProviderConfig[], fetchImpl: typeof fetch = fetch): Promise<ModelEntry[]> {
  const lists = await Promise.all(
    providers.map(async (p) => {
      try {
        const r = await fetchImpl(`${p.baseUrl}/models`, { headers: { Authorization: `Bearer ${p.apiKey}` }, cache: "no-store" });
        if (!r.ok) throw new Error(String(r.status));
        const j = (await r.json()) as { data?: Raw[] } | Raw[];
        const arr = Array.isArray(j) ? j : j.data ?? [];
        return arr.map((m) => normaliseModel(p, m)).filter((m) => m.id);
      } catch {
        return p.defaultModel ? [normaliseModel(p, { id: p.defaultModel })] : [];
      }
    }),
  );
  return lists.flat();
}

export function findSelectable(catalog: ModelEntry[], provider: string, model: string): ModelEntry | undefined {
  return catalog.find((m) => m.provider === provider && m.id === model && m.selectable);
}
