/**
 * Video generation for the agent (lib/agent.ts) in Anon mode, via Black Forest Labs' FLUX 3 Video API (EU endpoint).
 * Like the anonymized gateways, BFL gets the request under our account: only the model's prompt leaves the server, no
 * account id, session, IP or user agent. The clip goes to the browser in the tool event and is never stored or logged
 * here. Off unless BFL_API_KEY is set (or, in dev/e2e only, MOCK_PROVIDER=1, which uses the mock endpoint).
 */
import { bytesCapped } from "./image-gen";
import { CREDIT_MARKUP, MICROS_PER_EUR, USD_EUR } from "./credits";

type Env = Record<string, string | undefined>;

const BFL_BASE = "https://api.eu.bfl.ai/v1";
/** Inside the agent's 300 s total: FLUX 3 Video renders a short HD clip in one to three minutes. */
export const VIDEO_TIMEOUT_MS = 240_000;
const POLL_MS = 2_000;
const DURATION_S = 5;
// The clip travels base64 in one SSE event (a third larger) and is buffered by server and browser, so keep it near clip size.
// shortcut: 10 MB is from bitrate (5 s HD with sound is about 2-6 MB), not a measured clip; raise it if real clips are refused as too big.
export const MAX_VIDEO_BYTES = 10_000_000;
/** What one clip costs the user in credit: BFL's HD price ($0.17/s, checked 2026-10-27) with the usual markup. */
export const VIDEO_COST_MICROS = Math.round(0.17 * DURATION_S * USD_EUR * CREDIT_MARKUP * MICROS_PER_EUR);

export const videoConfigured = (env: Env) => !!env.BFL_API_KEY || env.MOCK_PROVIDER === "1";

/** The tool definition offered to the model (OpenAI function-calling format). */
export const VIDEO_TOOL = {
  type: "function",
  function: {
    name: "generate_video",
    description: `Generate one ${DURATION_S}-second video clip with sound from a text description and show it to the user. ` +
      "Use only when the user asks for a video. Describe the subject, action, camera, style and sound in English.",
    parameters: { type: "object", properties: { prompt: { type: "string", description: "What the video should show" } }, required: ["prompt"] },
  },
} as const;

/** An MP4 (ISO BMFF) by its first bytes, so a provider's label is never trusted for the data URL. */
export const isMp4 = (b: Uint8Array) => b.length > 12 && String.fromCharCode(...b.slice(4, 8)) === "ftyp";

/**
 * URLs from the response are fetched only on BFL's own hosts (or the configured mock). The API key goes only to an API
 * host (api.bfl.ai, api.<region>.bfl.ai): any other bfl.ai host (delivery, docs, a vendor's) gets the signed sample only.
 */
const trusted = (url: string, base: string, withKey = false) => {
  try {
    const u = new URL(url);
    if (u.origin === new URL(base).origin) return true;
    if (u.protocol !== "https:" || u.port) return false;
    return withKey ? /^api(\.[a-z0-9-]+)?\.bfl\.ai$/.test(u.hostname) : u.hostname === "bfl.ai" || u.hostname.endsWith(".bfl.ai");
  } catch { return false; }
};

const fail = (message: string, status: number) => Object.assign(new Error(message), { status });

/** One clip as a data URL. Throws with `status` (the provider's, 422 for a refusal or unusable clip, 504 for a timeout). */
export async function generateVideo(prompt: string, env: Env, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<string> {
  const base = env.BFL_API_KEY ? BFL_BASE : env.MOCK_BASE_URL || "http://127.0.0.1:3000/api/mock/v1";
  const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(VIDEO_TIMEOUT_MS)]) : AbortSignal.timeout(VIDEO_TIMEOUT_MS);
  const headers = { "Content-Type": "application/json", accept: "application/json", "x-key": env.BFL_API_KEY ?? "" };
  const json = async (res: Response) => {
    if (!res.ok) { res.body?.cancel().catch(() => {}); throw fail(`video provider error ${res.status}`, res.status); }
    let v: unknown;
    try { v = JSON.parse((await bytesCapped(res, 64_000))?.toString("utf8") ?? ""); } catch { /* checked below */ }
    if (typeof v !== "object" || v === null) throw fail("unusable video response", 502);
    return v as Record<string, unknown>;
  };
  const submitted = await json(await fetchImpl(`${base}/flux-3-video`, {
    method: "POST", headers, redirect: "error", signal: sig, // never forward the API key to another host
    body: JSON.stringify({ mode: "t2v", prompt, duration: DURATION_S, resolution: "hd", aspect_ratio: "16:9", generate_audio: true }),
  }));
  const poll = submitted.polling_url;
  if (typeof poll !== "string" || !trusted(poll, base, true)) throw fail("untrusted polling url", 502);
  for (;;) {
    sig.throwIfAborted();
    await new Promise<void>((r, j) => {
      const stop = () => { clearTimeout(t); j(fail("video timed out", 504)); };
      const t = setTimeout(() => { sig.removeEventListener("abort", stop); r(); }, POLL_MS);
      sig.addEventListener("abort", stop, { once: true });
    });
    const r = await json(await fetchImpl(poll, { headers, redirect: "error", signal: sig }));
    const status = String(r.status ?? "");
    // "Task not found": BFL lost the job; anything else unknown counts as still rendering until the timeout.
    if (/moderated|error|failed|not found/i.test(status)) throw fail(`video ${status}`, 422);
    if (status !== "Ready") continue;
    const sample = (r.result as { sample?: unknown } | undefined)?.sample;
    if (typeof sample !== "string" || !trusted(sample, base)) throw fail("untrusted video url", 502);
    const res = await fetchImpl(sample, { redirect: "error", signal: sig }); // signed URL: no key needed
    if (!res.ok) { res.body?.cancel().catch(() => {}); throw fail(`video download error ${res.status}`, res.status); }
    const bytes = await bytesCapped(res, MAX_VIDEO_BYTES);
    if (!bytes || !isMp4(bytes)) throw fail("unusable video", 422);
    return `data:video/mp4;base64,${bytes.toString("base64")}`;
  }
}
