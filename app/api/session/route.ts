import { createSession, identityFrom, sessionCookie, tierOf, touchSession } from "@/lib/session";
import { usage } from "@/lib/ratelimit";
import { withStores } from "@/lib/store";
import { LIMITS, overLimit } from "@/lib/limits";
import { TIERS } from "@/lib/tiers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Returns (or creates) an anonymous session with today's usage. Tier is server-side. */
export const GET = withStores(async (req: Request) => {
  const existing = identityFrom(req);
  if (existing) {
    await touchSession(existing);
    const tier = await tierOf(existing);
    return Response.json({ tier: TIERS[tier], usage: await usage(existing, tier) }, { headers: { "Cache-Control": "no-store" } });
  }
  const limited = await overLimit(LIMITS.newSession, "new-session");
  if (limited) return limited;
  const { id, token } = await createSession();
  const tier = await tierOf(id);
  return Response.json({ tier: TIERS[tier], usage: await usage(id, tier), apiToken: token }, {
    headers: { "Cache-Control": "no-store", "Set-Cookie": sessionCookie(token) },
  });
});
