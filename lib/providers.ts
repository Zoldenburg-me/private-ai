/** "anon-gateway": no enclave; the gateway forwards prompts to the model vendor under its own account, without the user's identity. */
export type PrivacyModel = "tee-attested" | "tee-gateway" | "zdr-contract" | "anon-gateway";

export interface ProviderConfig {
  id: string;
  name: string;
  privacy: PrivacyModel;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  /** From <PREFIX>_MODELS: if set, only these model ids are offered. */
  models?: string[];
  /** Set when apiKey came from the admin key store (lib/provider-keys.ts) rather than env. */
  keyId?: string;
}

export const DEFS: { id: string; name: string; prefix: string; privacy: PrivacyModel; baseUrl?: string }[] = [
  { id: "near", name: "NEAR AI Cloud", prefix: "NEAR_AI", privacy: "tee-attested", baseUrl: "https://cloud-api.near.ai/v1" },
  { id: "phala", name: "Phala Confidential AI", prefix: "PHALA", privacy: "tee-attested", baseUrl: "https://inference.phala.com/v1" },
  { id: "tinfoil", name: "Tinfoil", prefix: "TINFOIL", privacy: "tee-attested", baseUrl: "https://inference.tinfoil.sh/v1" },
  { id: "privatemode", name: "Privatemode (Edgeless)", prefix: "PRIVATEMODE", privacy: "tee-attested" },
  { id: "redpill", name: "RedPill gateway", prefix: "REDPILL", privacy: "tee-gateway", baseUrl: "https://api.redpill.ai/v1" },
  { id: "mock", name: "Mock enclave (dev/test only)", prefix: "MOCK", privacy: "tee-attested", baseUrl: "http://127.0.0.1:3000/api/mock/v1" },
  { id: "venice", name: "Venice (anonymized frontier models)", prefix: "VENICE", privacy: "anon-gateway", baseUrl: "https://api.venice.ai/api/v1" },
  { id: "custom", name: "Custom OpenAI-compatible", prefix: "CUSTOM", privacy: "zdr-contract" },
];

type Env = Record<string, string | undefined>;

/** Providers that have both a base URL and key configured. Never exposes keys to the client. */
export function loadProviders(env: Env = process.env): ProviderConfig[] {
  return DEFS.flatMap((d) => {
    const baseUrl = env[`${d.prefix}_BASE_URL`] || d.baseUrl || "";
    if (d.id === "mock" && env.MOCK_PROVIDER !== "1") return [];
    const apiKey = env[`${d.prefix}_API_KEY`] || (d.id === "mock" ? "mock" : "");
    if (!baseUrl || !apiKey) return [];
    const listed = env[`${d.prefix}_MODELS`]?.split(",").map((m) => m.trim()).filter(Boolean);
    const models = listed && [...new Set(listed)];
    if (d.privacy === "anon-gateway" && !models?.length) return []; // only explicitly vetted frontier models
    return [{ id: d.id, name: d.name, privacy: d.privacy, baseUrl: baseUrl.replace(/\/$/, ""), apiKey, defaultModel: env[`${d.prefix}_MODEL`] || "", ...(models?.length ? { models } : {}) }];
  });
}

export function pickProvider(id: string | undefined, env: Env = process.env): ProviderConfig | undefined {
  const all = loadProviders(env);
  return all.find((p) => p.id === (id || env.DEFAULT_PROVIDER)) ?? all[0];
}

export interface ChatMessage { role: "system" | "user" | "assistant"; content: string }

/** Builds an OpenAI-compatible streaming request. */
export function buildChatRequest(p: ProviderConfig, messages: ChatMessage[], model?: string): { url: string; init: RequestInit } {
  return {
    url: `${p.baseUrl}/chat/completions`,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.apiKey}` },
      body: JSON.stringify({ model: model || p.defaultModel, messages, stream: true }),
    },
  };
}

/** Model refs are "<provider>:<model id>". */
export function parseModelRef(ref: string): { provider: string; model: string } | null {
  const i = ref.indexOf(":");
  if (i <= 0) return null;
  return { provider: ref.slice(0, i), model: ref.slice(i + 1) };
}
