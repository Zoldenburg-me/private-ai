import { createSession, resolveIdentity, sessionCookie, tierOf } from "@/lib/session";
import { usage } from "@/lib/ratelimit";
import { withStores } from "@/lib/store";
import { LIMITS, overLimit } from "@/lib/limits";
import { TIERS } from "@/lib/tiers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Returns (or creates) a session with today's usage. Tier is server-side. A missing, invalid or
 * revoked token (signed out elsewhere) gets a fresh anonymous session.
 */
export const GET = withStores(async (req: Request) => {
  const me = await resolveIdentity(req);
  if (me) {
    const existing = me.accountId;
    const tier = await tierOf(existing);
    return Response.json({ tier: TIERS[tier], usage: await usage(existing, tier), account: { signedIn: me.deviceId !== null, id: existing.slice(0, 6) } },
      { headers: { "Cache-Control": "no-store" } });
  }
  const limited = await overLimit(LIMITS.newSession, "new-session");
  if (limited) return limited;
  const { id, token } = await createSession();
  const tier = await tierOf(id);
  return Response.json({ tier: TIERS[tier], usage: await usage(id, tier), apiToken: token, account: { signedIn: false, id: id.slice(0, 6) } }, {
    headers: { "Cache-Control": "no-store", "Set-Cookie": sessionCookie(token) },
  });
});
