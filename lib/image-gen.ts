/**
 * Image generation for the agent (lib/agent.ts), via NEAR AI Cloud's attested FLUX model. Only the model's prompt
 * leaves the server: no account id, session, IP or user agent. The image goes to the browser in the tool event and is
 * never stored or logged here. Off unless a NEAR key is configured, in env or /admin (or, in dev/e2e only, MOCK_PROVIDER=1, which uses
 * the mock image endpoint; production refuses MOCK_PROVIDER at boot).
 */
import type { ProviderConfig } from "./providers";

type Env = Record<string, string | undefined>;

export const IMAGE_TIMEOUT_MS = 60_000;
/** NEAR's /model/list reports attestationSupported for it (checked 2026-10-25); a fixed model, never the chat model's choice. */
export const IMAGE_MODEL = "black-forest-labs/FLUX.2-klein-4B";
const MAX_PROMPT_CHARS = 1_000;
export const MAX_IMAGE_BYTES = 4_000_000;
/** Some providers answer a moderation refusal with HTTP 200 and a tiny placeholder; a real image is far larger. */
export const MIN_IMAGE_BYTES = 4_000;

/** `near`: the NEAR provider as liveProviders resolves it, so a key stored in /admin works like one in env. */
export const imageConfigured = (env: Env, near?: ProviderConfig) => !!near?.apiKey || env.MOCK_PROVIDER === "1";

/** The tool definition offered to the model (OpenAI function-calling format). */
export const IMAGE_TOOL = {
  type: "function",
  function: {
    name: "generate_image",
    description: "Generate one image from a text description and show it to the user. Use only when the user asks for an image. " +
      "Describe the subject, style and composition in English.",
    parameters: { type: "object", properties: { prompt: { type: "string", description: "What the image should show" } }, required: ["prompt"] },
  },
} as const;

/** Parses the model's arguments; null when they are not a JSON object with a non-empty string prompt. */
export function promptOf(args: string): string | null {
  try {
    const p = (JSON.parse(args) as { prompt?: unknown }).prompt;
    return typeof p === "string" && p.trim() ? p.trim().slice(0, MAX_PROMPT_CHARS) : null;
  } catch { return null; }
}

/** The image type from its first bytes, so a provider's label is never trusted for the data URL. */
export function imageType(b: Uint8Array): "png" | "jpeg" | "webp" | null {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") return "webp";
  return null;
}

/** One image as a data URL. Throws with `status` (the provider's, or 422 for a refusal or an unusable image). */
export async function generateImage(prompt: string, near: ProviderConfig | undefined, env: Env, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<string> {
  const base = near?.apiKey ? near.baseUrl : env.MOCK_BASE_URL || "http://127.0.0.1:3000/api/mock/v1";
  const res = await fetchImpl(`${base}/images/generations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${near?.apiKey ?? ""}` },
    body: JSON.stringify({ model: IMAGE_MODEL, prompt, n: 1, response_format: "b64_json" }),
    redirect: "error", // never forward the API key to another host
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(IMAGE_TIMEOUT_MS)]) : AbortSignal.timeout(IMAGE_TIMEOUT_MS),
  });
  if (!res.ok) { res.body?.cancel().catch(() => {}); throw Object.assign(new Error(`image provider error ${res.status}`), { status: res.status }); }
  // base64 is 4/3 the bytes: capping the body bounds memory before anything is parsed.
  const text = (await bytesCapped(res, (MAX_IMAGE_BYTES * 4) / 3 + 4_096))?.toString("utf8") ?? null;
  let b64: unknown;
  try { b64 = text === null ? undefined : (JSON.parse(text) as { data?: { b64_json?: unknown }[] }).data?.[0]?.b64_json; } catch { /* not JSON */ }
  if (typeof b64 !== "string") throw Object.assign(new Error("unusable image"), { status: 422 });
  const bytes = Buffer.from(b64, "base64");
  const type = imageType(bytes);
  if (!type || bytes.length < MIN_IMAGE_BYTES) throw Object.assign(new Error("image refused or placeholder"), { status: 422 });
  return `data:image/${type};base64,${bytes.toString("base64")}`;
}

/** The body, or null once it passes `max` bytes (the rest is never read). */
export async function bytesCapped(res: Response, max: number): Promise<Buffer | null> {
  if (Number(res.headers.get("content-length") ?? 0) > max) { res.body?.cancel().catch(() => {}); return null; }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return Buffer.concat(chunks);
    size += value.length;
    if (size > max) { reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
}
