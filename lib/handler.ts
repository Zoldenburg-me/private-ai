import { applyExtensions } from "./extensions";
import { findSelectable, type ModelEntry } from "./catalog";
import { cheapestRoute } from "./routing";
import { gate, incognitoId, recordFailure } from "./ratelimit";
import { createHmac } from "node:crypto";
import { resolveIdentity, sessionSecret, tierOf } from "./session";
import { inviteGateOn } from "./invite";
import { LIMITS, overLimit } from "./limits";
import { parseModelRef } from "./providers";
import { liveProviders, markKeyUsed } from "./provider-keys";
import { DEFAULT_OUTPUT_TOKENS, estimateTokens, TIERS } from "./tiers";
import { relay } from "./relay";
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
  try { return await handle(req, route, deps); } catch (e) {
    // Fail closed: a configured Postgres/Redis that is down means 503, never an unmetered fallback.
    if (isUnavailable(e)) { (deps.log ?? metaLogger)({ route, event: "store_unavailable", status: 503 }); return unavailableResponse(); }
    throw e;
  }
}

async function handle(req: Request, route: string, deps: HandlerDeps): Promise<Response> {
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

  const parsed = applyExtensions(input);
  if (parsed.error) { await recordFailure(id); return err(400, parsed.error); }

  const ref = parseModelRef(String(input.model ?? ""));
  if (!ref) { await recordFailure(id); return err(400, "model must be '<provider>:<model>' (see /api/v1/models)"); }
  const catalog = await deps.catalog();
  // "auto:<curated model>" goes to the cheapest TEE provider currently serving it (lib/routing.ts).
  const entry = ref.provider === "auto" ? cheapestRoute(catalog, ref.model) : findSelectable(catalog, ref.provider, ref.model);
  if (!entry) { await recordFailure(id); return err(403, ref.provider === "auto" ? "no TEE provider currently serves this model" : "model not available under the privacy policy (TEE, zero-retention or anonymized gateway only)"); }
  const provider = (await liveProviders(deps.env ?? process.env)).find((p) => p.id === entry.provider);
  if (!provider) return err(503, "provider not configured");

  const tier = await tierOf(id);
  if (entry.paid && tier === "free")
    return Response.json({ error: { message: "This model needs a paid plan.", code: "upgrade_required" } }, { status: 402, headers: { "Cache-Control": "no-store" } });
  const incognito = !entry.tee;
  const quotaId = incognito ? incognitoId(id) : id;
  const { max_completion_tokens, max_tokens, ...rest } = parsed.body;
  const cap = TIERS[tier].maxOutputTokens;
  const wanted = [max_completion_tokens, max_tokens].map((v) => (typeof v === "number" ? Math.floor(v) : NaN)).find((v) => v >= 1);
  // Forward the field the client used: some models accept only max_completion_tokens.
  const field = max_completion_tokens != null ? "max_completion_tokens" : "max_tokens";
  // Tinfoil shares its prompt cache per API key + user_cache_secret; one opaque secret per account keeps users' cache timing apart.
  const cacheScope = provider.id === "tinfoil" ? { user_cache_secret: createHmac("sha256", sessionSecret()).update(`tinfoil-cache:${id}`).digest("base64url") } : {};
  const prompt = { ...rest, model: entry.id, [field]: Math.min(wanted ?? DEFAULT_OUTPUT_TOKENS, cap) };
  // Liquid: only offers that promise not to retain the prompt compete, and no prompt-cache breakpoints are sent upstream.
  const exchange = provider.id === "liquid" ? { exchange: { retention_policy: "none", cache: "off" } } : {};
  const g = await gate(id, tier, estimateTokens(JSON.stringify(prompt)), Date.now(), incognito); // the cache secret uses no model context
  const body = { ...prompt, ...cacheScope, ...exchange };
  if (!g.allowed) { log({ route, event: "gated", status: g.status, tier }); return err(g.status, g.reason!, g.headers); }
  if (anonGated) { // counted only for requests that would reach the provider, so rejected ones cannot use up everyone's anonymous budget
    const limited = await overLimit(LIMITS.anonChat, "anon-chat");
    if (limited) return limited;
  }

  // Metadata only (when an admin-stored key was last used); a failed write must not block the chat.
  if (provider.keyId) markKeyUsed(provider.keyId).catch(() => log({ route, event: "key_used_write_failed" }));
  const res = await relay({ provider, body, log, route, fetchImpl: deps.fetchImpl, extraHeaders: g.headers });
  if (res.status >= 500) await recordFailure(quotaId);
  return res;
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
