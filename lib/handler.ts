import { applyExtensions } from "./extensions";
import { findSelectable, type ModelEntry } from "./catalog";
import { cheapestRoute } from "./routing";
import { gate, recordFailure, usage } from "./ratelimit";
import { createHmac } from "node:crypto";
import { resolveIdentity, sessionSecret, tierOf } from "./session";
import { inviteGateOn } from "./invite";
import { LIMITS, overLimit, refundLimit } from "./limits";
import { parseModelRef, type ProviderConfig } from "./providers";
import { liveProviders, markKeyUsed } from "./provider-keys";
import { ANON_MAX_OUTPUT_TOKENS, anonAllowed, DEFAULT_OUTPUT_TOKENS, estimateBodyTokens, TIERS, type TierId } from "./tiers";
import { relay } from "./relay";
import { firstStepBody, runAgent } from "./agent";
import { searchConfigured } from "./web-search";
import { metaLogger, type Logger } from "./log";
import { isUnavailable, unavailableResponse } from "./store";

export interface HandlerDeps { catalog: () => Promise<ModelEntry[]>; log?: Logger; fetchImpl?: typeof fetch; env?: Record<string, string | undefined> }

/** Raw request body cap. Bounds message bytes too; the per-tier token limit is checked after parsing. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;
export const BODY_READ_TIMEOUT_MS = 20_000;

const err = (status: number, message: string, headers: Record<string, string> = {}) =>
  Response.json({ error: { message } }, { status, headers: { "Cache-Control": "no-store", ...headers } });

/** Shared handler for the web app (/api/chat) and the OpenAI-compatible API (/api/v1/chat/completions). */
export async function handleChat(req: Request, route: string, deps: HandlerDeps): Promise<Response> {
  return failClosed(route, deps, async () => {
    const p = await prepareChat(req, route, deps, {});
    if (p instanceof Response) return p;
    const res = await relay({ provider: p.provider, body: p.body, log: p.log, route, fetchImpl: deps.fetchImpl, extraHeaders: p.headers });
    if (res.status >= 500) await recordFailure(p.id);
    return res;
  });
}

/** Agent mode for the web app (/api/agent): the same checks, then the tool loop in lib/agent.ts. */
export async function handleAgent(req: Request, route: string, deps: HandlerDeps): Promise<Response> {
  const env = deps.env ?? process.env;
  if (!searchConfigured(env)) return err(503, "web search is not configured on this server");
  return failClosed(route, deps, async () => {
    const imageProvider = (await liveProviders(env)).find((x) => x.id === "near"); // the image tool's provider, stored keys applied
    const p = await prepareChat(req, route, deps, { webSearch: true }, (prompt, tier, provider) => firstStepBody(prompt, TIERS[tier].agentMaxSteps, { provider, env, tier, imageProvider }));
    if (p instanceof Response) return p;
    let remaining = p.headers["x-usage-remaining-daily"];
    const beforeStep = async (body: Record<string, unknown>) => {
      // Like the first check: the cache secret uses no model context (JSON.stringify drops undefined).
      const g = await gate(p.id, p.tier, estimateBodyTokens({ ...body, user_cache_secret: undefined }), Date.now(), p.incognito);
      remaining = g.headers["x-usage-remaining-daily"];
      return g.allowed ? null : g.reason!;
    };
    return runAgent({ provider: p.provider, body: p.body, tier: p.tier, imageProvider, maxSteps: TIERS[p.tier].agentMaxSteps, beforeStep, remaining: () => remaining, onFailure: () => recordFailure(p.id),
      env, log: p.log, route, fetchImpl: deps.fetchImpl, headers: p.headers });
  });
}

async function failClosed(route: string, deps: HandlerDeps, run: () => Promise<Response>): Promise<Response> {
  try { return await run(); } catch (e) {
    // Fail closed: a configured Postgres/Redis that is down means 503, never an unmetered fallback.
    if (isUnavailable(e)) { (deps.log ?? metaLogger)({ route, event: "store_unavailable", status: 503 }); return unavailableResponse(); }
    throw e;
  }
}

/** `incognito`: the model counts against the incognito daily quota (lib/ratelimit.ts). */
interface Prepared { id: string; incognito: boolean; tier: TierId; provider: ProviderConfig; body: Record<string, unknown>; headers: Record<string, string>; log: Logger }

/**
 * Identity, body, model, tier and the first rate-limit check: everything before the upstream call.
 * `sent` maps the prompt to the body the first upstream call really carries, for the context estimate.
 */
async function prepareChat(req: Request, route: string, deps: HandlerDeps, allow: { webSearch?: boolean },
  sent: (prompt: Record<string, unknown>, tier: TierId, provider: ProviderConfig) => unknown = (prompt) => prompt): Promise<Prepared | Response> {
  const log = deps.log ?? metaLogger;
  const me = await resolveIdentity(req);
  if (!me) return err(401, "missing or invalid session token");
  // Invite-only: signed-out visitors may try the web app under one whole-instance cap (fresh sessions
  // are free to mint, so a per-account limit alone would not bound the shared provider key); the API needs an account.
  const anonGated = !me.deviceId && inviteGateOn();
  if (anonGated && route !== "/api/chat")
    return Response.json({ error: { message: "Sign up with a passkey to use the API.", code: "signup_required" } }, { status: 401, headers: { "Cache-Control": "no-store" } });
  const id = me.accountId;
  let input: Record<string, unknown>;
  const raw = await readCapped(req, MAX_BODY_BYTES);
  if (raw instanceof Response) { await recordFailure(id); return raw; }
  try { input = JSON.parse(raw) as Record<string, unknown>; } catch { await recordFailure(id); return err(400, "invalid JSON"); }

  const parsed = applyExtensions(input, allow);
  if (parsed.error) { await recordFailure(id); return err(400, parsed.error); }

  const ref = parseModelRef(String(input.model ?? ""));
  if (!ref) { await recordFailure(id); return err(400, "model must be '<provider>:<model>' (see /api/v1/models)"); }
  const catalog = await deps.catalog();
  // "auto:<curated model>" goes to the cheapest TEE provider currently serving it (lib/routing.ts).
  const entry = ref.provider === "auto" ? cheapestRoute(catalog, ref.model) : findSelectable(catalog, ref.provider, ref.model);
  if (!entry) { await recordFailure(id); return err(403, ref.provider === "auto" ? "no TEE provider currently serves this model" : "model not available under the privacy policy (TEE, zero-retention or anonymized gateway only)"); }
  const provider = (await liveProviders(deps.env ?? process.env)).find((p) => p.id === entry.provider);
  if (!provider) return err(503, "provider not configured");
  const hasImage = parsed.messages.some((m) => Array.isArray(m.content) && m.content.some((c) => c.type === "image_url"));
  if (hasImage && !entry.modalities?.in.includes("image")) { await recordFailure(id); return err(400, "this model does not read images; pick one that does"); }

  const tier = await tierOf(id);
  // Signed-out sessions are free to mint: on the free plan they get only the curated TEE line-up and a smaller reply (an anonymous paid account keeps its plan).
  const anonFree = !me.deviceId && tier === "free";
  if (anonFree && !anonAllowed(entry))
    return Response.json({ error: { message: "Sign in to use this model.", code: "signin_required" } }, { status: 401, headers: { "Cache-Control": "no-store" } });
  if (entry.paid && tier === "free")
    return Response.json({ error: { message: "This model needs a paid plan.", code: "upgrade_required" } }, { status: 402, headers: { "Cache-Control": "no-store" } });
  const incognito = entry.incognito === true;
  const { max_completion_tokens, max_tokens, ...rest } = parsed.body;
  const cap = anonFree ? ANON_MAX_OUTPUT_TOKENS : TIERS[tier].maxOutputTokens;
  const wanted = [max_completion_tokens, max_tokens].map((v) => (typeof v === "number" ? Math.floor(v) : NaN)).find((v) => v >= 1);
  // Forward the field the client used: some models accept only max_completion_tokens.
  const field = max_completion_tokens != null ? "max_completion_tokens" : "max_tokens";
  // Tinfoil shares its prompt cache per API key + user_cache_secret; one opaque secret per account keeps users' cache timing apart.
  const cacheScope = provider.id === "tinfoil" ? { user_cache_secret: createHmac("sha256", sessionSecret()).update(`tinfoil-cache:${id}`).digest("base64url") } : {};
  const prompt = { ...rest, model: entry.id, [field]: Math.min(wanted ?? DEFAULT_OUTPUT_TOKENS, cap) };
  // Liquid: only offers that promise not to retain the prompt compete, and no prompt-cache breakpoints are sent upstream.
  const exchange = provider.id === "liquid" ? { exchange: { retention_policy: "none", cache: "off" } } : {};
  const tokens = estimateBodyTokens(sent(prompt, tier, provider)); // the cache secret uses no model context
  const now = Date.now(); // one clock: the refund must hit the cap's window, and usage() and gate() the same day
  // The whole-instance cap goes before the daily quota, so a message it refuses costs the session nothing. Rejected
  // requests must not use up everyone's budget: one too long for the tier or from a session out of daily messages skips
  // the cap (gate() refuses it), and one gate() refuses for any other reason, or a store error ends, gives its slot back.
  const capped = anonGated && tokens <= TIERS[tier].maxContextTokens && (await usage(id, tier, now, incognito)).remainingToday > 0;
  if (capped) {
    const limited = await overLimit(LIMITS.anonChat, "anon-chat", now);
    if (limited) return limited;
  }
  const refund = () => (capped ? refundLimit(LIMITS.anonChat, "anon-chat", now) : Promise.resolve());
  const g = await gate(id, tier, tokens, now, incognito).catch(async (e) => { await refund().catch(() => {}); throw e; });
  const body = { ...prompt, ...cacheScope, ...exchange };
  if (!g.allowed) {
    await refund().catch(() => {}); // a failed refund leaves the slot spent (the safe side) and the real refusal stands
    log({ route, event: "gated", status: g.status, tier }); return err(g.status, g.reason!, g.headers);
  }

  // Metadata only (when an admin-stored key was last used); a failed write must not block the chat.
  if (provider.keyId) markKeyUsed(provider.keyId).catch(() => log({ route, event: "key_used_write_failed" }));
  return { id, incognito, tier, provider, body, headers: g.headers, log };
}

/** Reads the body as text, or an error response: too large (Content-Length or streamed bytes), too slow, or aborted. */
async function readCapped(req: Request, max: number): Promise<string | Response> {
  if (Number(req.headers.get("content-length") ?? 0) > max) return err(413, "request body too large");
  if (!req.body) return "";
  const reader = req.body.getReader();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; reader.cancel().catch(() => {}); }, BODY_READ_TIMEOUT_MS);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (timedOut) return err(408, "request body too slow");
      if (done) return Buffer.concat(chunks).toString("utf8");
      size += value.length;
      if (size > max) { reader.cancel().catch(() => {}); return err(413, "request body too large"); }
      chunks.push(value);
    }
  } catch {
    return err(timedOut ? 408 : 400, timedOut ? "request body too slow" : "request body could not be read");
  } finally {
    clearTimeout(timer);
  }
}
