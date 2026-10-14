import { stores } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Readiness: 200 only if the configured stores answer. No error details are exposed. */
export async function GET() {
  const s = await stores();
  const check = async (fn: () => Promise<void>) => { try { await fn(); return "ok"; } catch { return "down"; } };
  const [accounts, counters] = await Promise.all([check(() => s.accounts.ping()), check(() => s.counters.ping())]);
  const ok = accounts === "ok" && counters === "ok";
  return Response.json(
    { ok, accounts: { backend: s.kind.accounts, status: accounts }, counters: { backend: s.kind.counters, status: counters } },
    { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
