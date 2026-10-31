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
import { ANON_MAX_OUTPUT_TOKENS, anonAllowed, DEFAULT_OUTPUT_TOKENS, estimateBodyTokens, modelGroup, TIERS, type TierId } from "./tiers";
import { chargeCredits, costMicros, creditsAvailable, priceFor, reserveCredits } from "./credits";
import type { QuotaScope } from "./store/types";
import { relay } from "./relay";
import { firstStepBody, runAgent } from "./agent";
import { searchConfigured } from "./web-search";
import { videoConfigured } from "./video-gen";
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
    const onUsage = p.price ? (u: { prompt: number; completion: number } | null, streamed: number) => charge(p, u, streamed) : undefined;
    const res = await relay({ provider: p.provider, body: p.body, log: p.log, route, fetchImpl: deps.fetchImpl, extraHeaders: p.headers, onUsage });
    if (res.status >= 500) await recordFailure(p.id);
    return res;
  });
}

/** Agent mode for the web app (/api/agent): the same checks, then the tool loop in lib/agent.ts. */
export async function handleAgent(req: Request, route: string, deps: HandlerDeps): Promise<Response> {
  const env = deps.env ?? process.env;
  if (!searchConfigured(env) && !videoConfigured(env)) return err(503, "web search and video are not configured on this server");
  return failClosed(route, deps, async () => {
    const imageProvider = (await liveProviders(env)).find((x) => x.id === "near"); // the image tool's provider, stored keys applied
    const p = await prepareChat(req, route, deps, { webSearch: true }, (prompt, tier, provider, opts) => firstStepBody(prompt, TIERS[tier].agentMaxSteps, { provider, env, tier, imageProvider, ...opts }));
    if (p instanceof Response) return p;
    let remaining = p.headers["x-usage-remaining-daily"];
    const beforeStep = async (body: Record<string, unknown>) => {
      // Like the first check: the cache secret uses no model context (JSON.stringify drops undefined).
      const tokens = estimateBodyTokens({ ...body, user_cache_secret: undefined });
      if (p.price && (await creditsAvailable(p.id, p.tier)).total < costMicros(p.price, tokens, p.outCap)) return "not enough credits";
      const g = await gate(p.id, p.tier, tokens, Date.now(), p.scope);
      remaining = g.headers["x-usage-remaining-daily"];
      return g.allowed ? null : g.reason!;
    };
    const onStep = p.price ? (u: { prompt: number; completion: number } | null, body: Record<string, unknown>, streamed: number) => charge(p, u, streamed, body) : undefined;
    const credits = { reserve: (micros: number) => reserveCredits(p.id, p.tier, micros, p.now) };
    return runAgent({ provider: p.provider, body: p.body, tier: p.tier, imageProvider, credits, webSearch: p.webSearch, video: p.video, maxSteps: TIERS[p.tier].agentMaxSteps, beforeStep, onStep, remaining: () => remaining, onFailure: () => recordFailure(p.id),
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

/**
 * `scope`: the daily quota the model counts against (lib/ratelimit.ts). `price` is set for credit models only: each call
 * is charged from the account's credits; `tokens` is the first call's input estimate, `outCap` the reply cap.
 */
interface Prepared {
  id: string; scope?: QuotaScope; tier: TierId; provider: ProviderConfig; body: Record<string, unknown>; headers: Record<string, string>; log: Logger;
  price?: { in: number; out: number }; tokens: number; outCap: number;
  /** The user asked for web search / a video clip in this message (pai_options.web_search / .video, agent mode only). */
  webSearch: boolean; video: boolean;
  /** When the balance was checked: the charge goes to that month's allowance, even if the reply ends after midnight. */
  now: number;
}

/** Charge one call, however it ended. Without a usage report: the input estimate plus the reply tokens already streamed. */
async function charge(p: Prepared, u: { prompt: number; completion: number } | null, streamed: number, body?: Record<string, unknown>) {
  if (!u && streamed === 0) return; // nothing reached the user (provider error or stop before the first word): no charge
  const tokens = u ? u.prompt : body ? estimateBodyTokens({ ...body, user_cache_secret: undefined }) : p.tokens;
  if (!u) p.log({ event: "usage_missing", provider: p.provider.id });
  await chargeCredits(p.id, p.tier, costMicros(p.price!, tokens, u?.completion ?? streamed), p.now)
    .catch(() => p.log({ event: "credit_charge_failed", provider: p.provider.id, status: 500 }));
}

/**
 * Identity, body, model, tier and the first rate-limit check: everything before the upstream call.
 * `sent` maps the prompt to the body the first upstream call really carries, for the context estimate.
 */
async function prepareChat(req: Request, route: string, deps: HandlerDeps, allow: { webSearch?: boolean },
  sent: (prompt: Record<string, unknown>, tier: TierId, provider: ProviderConfig, opts: { webSearch: boolean; video: boolean }) => unknown = (prompt) => prompt): Promise<Prepared | Response> {
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
  // Quota by list price (lib/tiers.ts modelGroup); Venice lists no prices, so its models borrow another gateway's.
  const price = priceFor(catalog, entry);
  const group = modelGroup({ tee: entry.tee, price });
  if (group === "top" && TIERS[tier].topDailyMessages === 0)
    return Response.json({ error: { message: "Top Max Privacy models need a paid plan.", code: "upgrade_required" } }, { status: 402, headers: { "Cache-Control": "no-store" } });
  const scope: QuotaScope | undefined = group === "top" ? "top" : group === "tee" ? undefined : "incognito";
  const metered = group === "credits" ? price : undefined;
  const { max_completion_tokens, max_tokens, ...rest } = parsed.body;
  const cap = anonFree ? ANON_MAX_OUTPUT_TOKENS : TIERS[tier].maxOutputTokens;
  const wanted = [max_completion_tokens, max_tokens].map((v) => (typeof v === "number" ? Math.floor(v) : NaN)).find((v) => v >= 1);
  // Forward the field the client used: some models accept only max_completion_tokens.
  const field = max_completion_tokens != null ? "max_completion_tokens" : "max_tokens";
  // Tinfoil shares its prompt cache per API key + user_cache_secret; one opaque secret per account keeps users' cache timing apart.
  const cacheScope = provider.id === "tinfoil" ? { user_cache_secret: createHmac("sha256", sessionSecret()).update(`tinfoil-cache:${id}`).digest("base64url") } : {};
  const outCap = Math.min(wanted ?? DEFAULT_OUTPUT_TOKENS, cap);
  const prompt = { ...rest, model: entry.id, [field]: outCap };
  // Liquid: only offers that promise not to retain the prompt compete, and no prompt-cache breakpoints are sent upstream.
  const exchange = provider.id === "liquid" ? { exchange: { retention_policy: "none", cache: "off" } } : {};
  const tokens = estimateBodyTokens(sent(prompt, tier, provider, { webSearch: parsed.webSearch === true, video: parsed.video === true })); // the cache secret uses no model context
  const now = Date.now(); // one clock: the refund must hit the cap's window, and usage() and gate() the same day
  // The whole-instance cap goes before the daily quota, so a message it refuses costs the session nothing. Rejected
  // requests must not use up everyone's budget: one too long for the tier or from a session out of daily messages skips
  // the cap (gate() refuses it), and one gate() refuses for any other reason, or a store error ends, gives its slot back.
  // Refuse before counting anything: the call's worst case (full reply) must fit the credits left.
  if (metered && (await creditsAvailable(id, tier, now)).total < costMicros(metered, tokens, outCap))
    return Response.json({ error: { message: "Not enough credits for this model. Top up in Settings → Plan.", code: "credits_required" } }, { status: 402, headers: { "Cache-Control": "no-store" } });
  const capped = anonGated && tokens <= TIERS[tier].maxContextTokens && (await usage(id, tier, now, scope)).remainingToday > 0;
  if (capped) {
    const limited = await overLimit(LIMITS.anonChat, "anon-chat", now);
    if (limited) return limited;
  }
  const refund = () => (capped ? refundLimit(LIMITS.anonChat, "anon-chat", now) : Promise.resolve());
  const g = await gate(id, tier, tokens, now, scope).catch(async (e) => { await refund().catch(() => {}); throw e; });
  // Credit models report their real token counts at the end of the stream (agent steps always stream).
  const streams = rest.stream === true || allow.webSearch === true;
  const usageReport = metered && streams ? { stream_options: { ...(rest.stream_options as object | undefined), include_usage: true } } : {};
  const body = { ...prompt, ...cacheScope, ...exchange, ...usageReport };
  if (!g.allowed) {
    await refund().catch(() => {}); // a failed refund leaves the slot spent (the safe side) and the real refusal stands
    log({ route, event: "gated", status: g.status, tier }); return err(g.status, g.reason!, g.headers);
  }

  // Metadata only (when an admin-stored key was last used); a failed write must not block the chat.
  if (provider.keyId) markKeyUsed(provider.keyId).catch(() => log({ route, event: "key_used_write_failed" }));
  return { id, scope, tier, provider, body, headers: g.headers, log, price: metered, tokens, outCap, now, webSearch: parsed.webSearch === true, video: parsed.video === true };
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
