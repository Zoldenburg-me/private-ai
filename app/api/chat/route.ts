import { buildChatRequest, pickProvider, type ChatMessage } from "@/lib/providers";
import { checkGate, estimateTokens, type TierId } from "@/lib/tiers";

export const runtime = "nodejs";

// Privacy: this route does NOT log or persist request/response bodies. Do not add logging here.
export async function POST(req: Request) {
  const { messages, provider, model, tier = "free", usedToday = 0 } = (await req.json()) as {
    messages: ChatMessage[]; provider?: string; model?: string; tier?: TierId; usedToday?: number;
  };
  // TODO: tier + usage must come from a verified session/entitlement, not the client.
  const gate = checkGate(tier, usedToday, estimateTokens(messages.map((m) => m.content).join("\n")));
  if (!gate.allowed) return Response.json({ error: gate.reason }, { status: 429 });

  const p = pickProvider(provider);
  if (!p) return Response.json({ error: "no provider configured" }, { status: 503 });

  const { url, init } = buildChatRequest(p, messages, model);
  const upstream = await fetch(url, init);
  if (!upstream.ok || !upstream.body) return Response.json({ error: `upstream ${upstream.status}` }, { status: 502 });
  return new Response(upstream.body, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Provider": p.id },
  });
}
