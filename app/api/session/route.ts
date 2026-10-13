import { identityFrom, issueToken, tierOf } from "@/lib/session";
import { TIERS } from "@/lib/tiers";

export const dynamic = "force-dynamic";

/** Returns (or creates) an anonymous session. Tier is server-side. */
export async function GET(req: Request) {
  const existing = identityFrom(req);
  if (existing) {
    return Response.json({ tier: TIERS[tierOf(existing)] }, { headers: { "Cache-Control": "no-store" } });
  }
  const { id, token } = issueToken();
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return Response.json({ tier: TIERS[tierOf(id)], apiToken: token }, {
    headers: { "Cache-Control": "no-store", "Set-Cookie": `pai_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${secure}` },
  });
}
