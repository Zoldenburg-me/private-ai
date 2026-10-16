/**
 * Our own OpenAI-compatible extension object: `pai_options`.
 *  - persona: { name, system_prompt }  -> prepended as system message (sent by client; personas are stored locally)
 *  - web_search: boolean (default false; not yet supported -> 400 if true)
 */
export interface PaiOptions { persona?: { name?: string; system_prompt: string }; web_search?: boolean }

type Part = { type: "text"; text: string };
type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export interface ForwardedMessage { role: string; content: string | Part[]; tool_calls?: ToolCall[]; tool_call_id?: string }
export interface ParsedRequest { body: Record<string, unknown>; messages: ForwardedMessage[]; error?: string }

// No n (one completion per request). max_tokens is clamped per tier in handler.ts.
const ALLOWED_PASSTHROUGH = ["model", "messages", "temperature", "top_p", "max_tokens", "max_completion_tokens", "stream", "stop", "seed", "presence_penalty", "frequency_penalty", "response_format"];
const ROLES = new Set(["system", "developer", "user", "assistant", "tool"]);
export const MAX_MESSAGES = 1_000;
export const MAX_STOP = 4;
const MAX_STOP_CHARS = 100;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
// Text parts only: the app never sends images, and an image would slip past the token estimate.
const isTextPart = (p: unknown): p is Part => isObject(p) && p.type === "text" && typeof p.text === "string";
const isStop = (s: unknown) => typeof s === "string" && s.length <= MAX_STOP_CHARS;
const validStop = (s: unknown) => s === undefined || s === null || isStop(s) || (Array.isArray(s) && s.length <= MAX_STOP && s.every(isStop));

const toToolCall = (c: unknown): ToolCall | null =>
  isObject(c) && typeof c.id === "string" && isObject(c.function) && typeof c.function.name === "string" && typeof c.function.arguments === "string"
    ? { id: c.id, type: "function", function: { name: c.function.name, arguments: c.function.arguments } } : null;

function toContent(c: unknown, role: string): string | Part[] | null {
  if (typeof c === "string") return c;
  if (Array.isArray(c) && c.every(isTextPart)) return c.map((p) => ({ type: "text", text: p.text }));
  if (c === null && role === "assistant") return ""; // SDK history: tool-call turn with no text
  return null;
}

/**
 * Rebuilds a message from known fields only, or null when its shape is not allowed. SDK tool histories keep
 * their links: assistant `tool_calls` and the `tool_call_id` of each result, which must name an earlier call.
 */
function toMessage(m: unknown, callIds: Set<string>): ForwardedMessage | null {
  if (!isObject(m) || typeof m.role !== "string" || !ROLES.has(m.role)) return null;
  const content = toContent(m.content, m.role);
  if (content === null) return null;
  if (m.role === "tool") return typeof m.tool_call_id === "string" && callIds.has(m.tool_call_id) ? { role: m.role, content, tool_call_id: m.tool_call_id } : null;
  if (m.role !== "assistant" || m.tool_calls === undefined) return { role: m.role, content };
  const calls = Array.isArray(m.tool_calls) ? m.tool_calls.map(toToolCall) : [];
  if (!calls.length || calls.includes(null)) return null;
  for (const c of calls as ToolCall[]) callIds.add(c.id);
  return { role: m.role, content, tool_calls: calls as ToolCall[] };
}

export function applyExtensions(input: Record<string, unknown>): ParsedRequest {
  const fail = (error: string): ParsedRequest => ({ body: {}, messages: [], error });
  if (!isObject(input)) return fail("body must be a JSON object");
  const opts = (isObject(input.pai_options) ? input.pai_options : {}) as PaiOptions;
  if (opts.web_search === true) return fail("web_search is not available yet (off by default for privacy)");
  if (input.tools !== undefined || input.tool_choice !== undefined) return fail("tools are not supported");
  if (!validStop(input.stop)) return fail(`stop must be up to ${MAX_STOP} strings of at most ${MAX_STOP_CHARS} characters`);
  if (!Array.isArray(input.messages) || !input.messages.length) return fail("messages required");
  if (input.messages.length > MAX_MESSAGES) return fail(`too many messages (max ${MAX_MESSAGES})`);
  const callIds = new Set<string>();
  const messages = input.messages.map((m) => toMessage(m, callIds));
  if (messages.includes(null)) return fail("each message needs a role (system|developer|user|assistant|tool) and string or text-part content; a tool result must name an earlier tool call");
  const forwarded = messages as ForwardedMessage[];
  if (opts.persona?.system_prompt) {
    forwarded.unshift({ role: "system", content: String(opts.persona.system_prompt).slice(0, 8000) });
  }
  const body: Record<string, unknown> = {};
  for (const k of ALLOWED_PASSTHROUGH) if (input[k] !== undefined) body[k] = input[k];
  body.messages = forwarded;
  return { body, messages: forwarded };
}
