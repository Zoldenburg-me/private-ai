/** Gateway model line-ups. No imports and no env: the client imports this file too (lib/client/providers.ts). */

/**
 * Liquid's default incognito line-up, in picker order: open-weight models first (the default route), then frontier.
 * Liquid (AI.exchange) retains no data under its DPA; every request also carries retention_policy "none" (lib/handler.ts).
 */
export const LIQUID_MODELS: Record<string, string> = {
  "deepseek-v4.1-flash": "DeepSeek V4.1 Flash", "kimi-k3": "Kimi K3", "glm-5.3": "GLM 5.3", "qwen3.8-27b": "Qwen 3.8 27B",
  "claude-opus-5-5": "Claude Opus 5.5", "grok-4.7": "Grok 4.7",
  "gemini-4-argon": "Gemini 4 Argon", "claude-fable-5-1": "Claude Fable 5.1", "gpt-6-astra": "GPT-6 Astra",
};

/**
 * Venice's default line-up (Venice id -> the same model's Liquid id): open-weight models and Grok that Venice runs itself,
 * then anonymized frontier. The picker shows a model offered by both once (lib/client/providers.ts).
 */
export const VENICE_MODELS: Record<string, string> = {
  "deepseek-v4-1-flash": "deepseek-v4.1-flash", "kimi-k3": "kimi-k3", "z-ai-glm-5-3": "glm-5.3", "qwen-3-8-27b": "qwen3.8-27b", "grok-4-7": "grok-4.7",
  "claude-opus-5-5": "claude-opus-5-5", "gemini-4-argon": "gemini-4-argon", "claude-fable-5-1": "claude-fable-5-1", "openai-gpt-6-astra": "gpt-6-astra",
};

/** Venice ids Venice runs itself with zero retention (its published private models). Only these may be labelled PRIVATE. */
export const VENICE_PRIVATE = new Set(["deepseek-v4-1-flash", "kimi-k3", "z-ai-glm-5-3", "qwen-3-8-27b", "grok-4-7"]);

/**
 * One id per model across gateways: Venice ids map to Liquid's, on any gateway (an env line-up may list a Venice id
 * on Liquid); anything else is already canonical.
 */
export const canonicalModelId = (id: string) => (Object.hasOwn(VENICE_MODELS, id) ? VENICE_MODELS[id] : id);
