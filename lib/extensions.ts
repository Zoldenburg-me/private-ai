import type { ChatMessage } from "./providers";

/**
 * Our own OpenAI-compatible extension object: `pai_options`.
 *  - persona: { name, system_prompt }  -> prepended as system message (sent by client; personas are stored locally)
 *  - web_search: boolean (default false; not yet supported -> 400 if true)
 */
export interface PaiOptions { persona?: { name?: string; system_prompt: string }; web_search?: boolean }

export interface ParsedRequest { body: Record<string, unknown>; messages: ChatMessage[]; error?: string }

const ALLOWED_PASSTHROUGH = ["model", "messages", "temperature", "top_p", "max_tokens", "max_completion_tokens", "stream", "stop", "seed", "presence_penalty", "frequency_penalty", "response_format", "tools", "tool_choice", "n"];

export function applyExtensions(input: Record<string, unknown>): ParsedRequest {
  const opts = (input.pai_options ?? {}) as PaiOptions;
  if (opts.web_search === true) return { body: {}, messages: [], error: "web_search is not available yet (off by default for privacy)" };
  const messages = Array.isArray(input.messages) ? ([...input.messages] as ChatMessage[]) : [];
  if (!messages.length) return { body: {}, messages, error: "messages required" };
  if (opts.persona?.system_prompt) {
    messages.unshift({ role: "system", content: String(opts.persona.system_prompt).slice(0, 8000) });
  }
  const body: Record<string, unknown> = {};
  for (const k of ALLOWED_PASSTHROUGH) if (input[k] !== undefined) body[k] = input[k];
  body.messages = messages;
  return { body, messages };
}
