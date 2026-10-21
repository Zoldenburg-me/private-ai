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

/**
 * Liquid's default incognito line-up, in picker order: open-weight models first (the default route), then frontier.
 * Every Liquid request is sent with retention_policy "none" (lib/handler.ts), so only zero-retention offers compete.
 */
export const LIQUID_MODELS: Record<string, string> = {
  "deepseek-v4.1-flash": "DeepSeek V4.1 Flash", "kimi-k3": "Kimi K3", "glm-5.3": "GLM 5.3", "qwen3.8-27b": "Qwen 3.8 27B",
  "claude-opus-5-5": "Claude Opus 5.5", "grok-4.7": "Grok 4.7",
  "gemini-4-argon": "Gemini 4 Argon", "claude-fable-5-1": "Claude Fable 5.1", "gpt-6-astra": "GPT-6 Astra",
};

/**
 * Venice's default line-up (Venice id -> the same model's Liquid id): open-weight models and Grok that Venice runs itself
 * ("private", zero retention), then anonymized frontier. The picker shows a model offered by both once (lib/client/providers.ts).
 */
export const VENICE_MODELS: Record<string, string> = {
  "deepseek-v4-1-flash": "deepseek-v4.1-flash", "kimi-k3": "kimi-k3", "z-ai-glm-5-3": "glm-5.3", "qwen-3-8-27b": "qwen3.8-27b", "grok-4-7": "grok-4.7",
  "claude-opus-5-5": "claude-opus-5-5", "gemini-4-argon": "gemini-4-argon", "claude-fable-5-1": "claude-fable-5-1", "openai-gpt-6-astra": "gpt-6-astra",
};

/** Liquid is listed before Venice: when both offer a model anonymized, the picker keeps Liquid's zero-retention route. */
export const DEFS: { id: string; name: string; prefix: string; privacy: PrivacyModel; baseUrl?: string; models?: string[] }[] = [
  { id: "near", name: "NEAR AI Cloud", prefix: "NEAR_AI", privacy: "tee-attested", baseUrl: "https://cloud-api.near.ai/v1" },
  { id: "phala", name: "Phala Confidential AI", prefix: "PHALA", privacy: "tee-attested", baseUrl: "https://inference.phala.com/v1" },
  { id: "tinfoil", name: "Tinfoil", prefix: "TINFOIL", privacy: "tee-attested", baseUrl: "https://inference.tinfoil.sh/v1" },
  { id: "privatemode", name: "Privatemode (Edgeless)", prefix: "PRIVATEMODE", privacy: "tee-attested" },
  { id: "redpill", name: "RedPill gateway", prefix: "REDPILL", privacy: "tee-gateway", baseUrl: "https://api.redpill.ai/v1" },
  { id: "mock", name: "Mock enclave (dev/test only)", prefix: "MOCK", privacy: "tee-attested", baseUrl: "http://127.0.0.1:3000/api/mock/v1" },
  { id: "liquid", name: "Liquid Inference (zero-retention exchange)", prefix: "LIQUID", privacy: "anon-gateway", baseUrl: "https://router.inference.ai.exchange/v1", models: Object.keys(LIQUID_MODELS) },
  { id: "venice", name: "Venice (private open-weight, anonymized frontier)", prefix: "VENICE", privacy: "anon-gateway", baseUrl: "https://api.venice.ai/api/v1", models: Object.keys(VENICE_MODELS) },
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
    const listed = (env[`${d.prefix}_MODELS`]?.split(",") ?? d.models)?.map((m) => m.trim()).filter(Boolean);
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
