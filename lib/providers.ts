export type PrivacyModel = "tee-attested" | "tee-gateway" | "zdr-contract";

export interface ProviderConfig {
  id: string;
  name: string;
  privacy: PrivacyModel;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
}

const DEFS: { id: string; name: string; prefix: string; privacy: PrivacyModel; baseUrl?: string }[] = [
  { id: "near", name: "NEAR AI Cloud", prefix: "NEAR_AI", privacy: "tee-attested", baseUrl: "https://cloud-api.near.ai/v1" },
  { id: "phala", name: "Phala Confidential AI", prefix: "PHALA", privacy: "tee-attested", baseUrl: "https://inference.phala.com/v1" },
  { id: "tinfoil", name: "Tinfoil", prefix: "TINFOIL", privacy: "tee-attested" },
  { id: "privatemode", name: "Privatemode (Edgeless)", prefix: "PRIVATEMODE", privacy: "tee-attested" },
  { id: "redpill", name: "RedPill gateway", prefix: "REDPILL", privacy: "tee-gateway" },
  { id: "custom", name: "Custom OpenAI-compatible", prefix: "CUSTOM", privacy: "zdr-contract" },
];

type Env = Record<string, string | undefined>;

/** Providers that have both a base URL and key configured. Never exposes keys to the client. */
export function loadProviders(env: Env = process.env): ProviderConfig[] {
  return DEFS.flatMap((d) => {
    const baseUrl = env[`${d.prefix}_BASE_URL`] || d.baseUrl || "";
    const apiKey = env[`${d.prefix}_API_KEY`] || "";
    if (!baseUrl || !apiKey) return [];
    return [{ id: d.id, name: d.name, privacy: d.privacy, baseUrl: baseUrl.replace(/\/$/, ""), apiKey, defaultModel: env[`${d.prefix}_MODEL`] || "" }];
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
