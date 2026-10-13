import { applyExtensions } from "./extensions";
import { findSelectable, type ModelEntry } from "./catalog";
import { gate, recordFailure } from "./ratelimit";
import { identityFrom, tierOf } from "./session";
import { loadProviders, parseModelRef } from "./providers";
import { estimateTokens } from "./tiers";
import { relay } from "./relay";
import { metaLogger, type Logger } from "./log";
import type { ChatMessage } from "./providers";

export interface HandlerDeps { catalog: () => Promise<ModelEntry[]>; log?: Logger; fetchImpl?: typeof fetch; env?: Record<string, string | undefined> }

const err = (status: number, message: string, headers: Record<string, string> = {}) =>
  Response.json({ error: { message } }, { status, headers: { "Cache-Control": "no-store", ...headers } });

/** Shared handler for the web app (/api/chat) and the OpenAI-compatible API (/api/v1/chat/completions). */
export async function handleChat(req: Request, route: string, deps: HandlerDeps): Promise<Response> {
  const log = deps.log ?? metaLogger;
  const id = identityFrom(req);
  if (!id) return err(401, "missing or invalid session token");
  let input: Record<string, unknown>;
  try { input = (await req.json()) as Record<string, unknown>; } catch { recordFailure(id); return err(400, "invalid JSON"); }

  const parsed = applyExtensions(input);
  if (parsed.error) { recordFailure(id); return err(400, parsed.error); }

  const ref = parseModelRef(String(input.model ?? ""));
  if (!ref) { recordFailure(id); return err(400, "model must be '<provider>:<model>' (see /api/v1/models)"); }
  const entry = findSelectable(await deps.catalog(), ref.provider, ref.model);
  if (!entry) { recordFailure(id); return err(403, "model not available under the privacy policy (TEE or zero-retention only)"); }
  const provider = loadProviders(deps.env ?? process.env).find((p) => p.id === ref.provider);
  if (!provider) return err(503, "provider not configured");

  const tier = tierOf(id);
  const ctx = estimateTokens((parsed.messages as ChatMessage[]).map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n"));
  const g = gate(id, tier, ctx);
  if (!g.allowed) { log({ route, event: "gated", status: g.status, tier }); return err(g.status, g.reason!, g.headers); }

  const body = { ...parsed.body, model: ref.model };
  const res = await relay({ provider, body, log, route, fetchImpl: deps.fetchImpl, extraHeaders: g.headers });
  if (res.status >= 500) recordFailure(id);
  return res;
}
