import { readFileSync } from "node:fs";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { hexToBytes } from "@noble/hashes/utils";
import { _setStores } from "../lib/store";
import { createSession, touchSession } from "../lib/session";
import { collateralRoute, startCollateralCache, _clearCollateral, REFRESH_MS, STALE_MAX_MS, PREFETCH_FMSPCS } from "../lib/collateral";
import { verifyTdxQuote, type Collateral } from "../lib/client/e2e/dcap";
import * as route from "../app/api/attestation/collateral/route";

// dcap-qvl's sample v4 quote and collateral (see tests/dcap.test.ts), served the way Intel PCS serves them.
const V4 = hexToBytes(readFileSync("tests/fixtures/dcap/tdx-quote-v4.hex", "utf8").trim());
const C4: Collateral = JSON.parse(readFileSync("tests/fixtures/dcap/tdx-quote-v4-collateral.json", "utf8"));
const NOW = Date.parse("2025-06-20T00:00:00Z");

let upstream: string[];
let down: boolean;
const intel = (async (url: string) => {
  upstream.push(url);
  if (down) throw new Error("connect ECONNREFUSED internal-detail");
  const u = new URL(url);
  const der = (h: string) => new Response(Buffer.from(h, "hex"));
  if (u.hostname === "certificates.trustedservices.intel.com") return der(C4.root_ca_crl);
  if (u.pathname.endsWith("/pckcrl")) return der(C4.pck_crl);
  if (u.pathname.endsWith("/qe/identity"))
    return new Response(`{"enclaveIdentity":${C4.qe_identity},"signature":"${C4.qe_identity_signature}"}`, { headers: { "SGX-Enclave-Identity-Issuer-Chain": encodeURIComponent(C4.qe_identity_issuer_chain) } });
  if (u.pathname.endsWith("/tcb") && u.searchParams.get("fmspc") === "B0C06F000000")
    return new Response(`{"tcbInfo":${C4.tcb_info},"signature":"${C4.tcb_info_signature}"}`, { headers: { "TCB-Info-Issuer-Chain": encodeURIComponent(C4.tcb_info_issuer_chain) } });
  return new Response("not found", { status: 404 });
}) as unknown as typeof fetch;
const get = collateralRoute(intel);
const req = (q: string, token?: string) => new Request(`http://app/api/attestation/collateral?${q}`, { headers: token ? { Cookie: `pai_session=${token}` } : {} });
async function session() { const s = await createSession(); await touchSession(s.id); return s.token; }
const Q = "fmspc=b0c06f000000&ca=platform";

beforeEach(() => { _setStores(); _clearCollateral(); upstream = []; down = false; vi.useFakeTimers({ toFake: ["Date", "setInterval"] }); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); _clearCollateral(); });

describe("collateral relay (N1b): Intel's collateral from a process-memory cache", () => {
  it("is a Node.js route that needs a session and never reaches Intel without one", async () => {
    expect(route.runtime).toBe("nodejs");
    expect((await route.GET(req(Q))).status).toBe(401);
    expect((await get(req(Q))).status).toBe(401);
    expect(upstream).toEqual([]);
  });

  it("validates fmspc and ca", async () => {
    const token = await session();
    for (const q of ["fmspc=xyz&ca=platform", "fmspc=B0C06F000000&ca=other", "fmspc=B0C06F000000", "fmspc=B0C06F000000%26x%3D1&ca=platform"])
      expect((await get(req(q, token))).status).toBe(400);
    expect(upstream).toEqual([]);
  });

  it("serves collateral the browser verifier accepts, byte for byte as Intel signed it", async () => {
    const r = await get(req(Q, await session()));
    expect(r.status).toBe(200);
    const body: Collateral = await r.json();
    expect(body).toEqual(C4);
    expect(verifyTdxQuote(V4, body, { now: new Date(NOW) }).tcbStatus).toBe("UpToDate");
  });

  it("answers from memory until REFRESH_MS, then refetches", async () => {
    const token = await session();
    await get(req(Q, token));
    const n = upstream.length;
    expect(n).toBe(4);
    await get(req(Q, token));
    expect(upstream.length).toBe(n);
    vi.setSystemTime(NOW + REFRESH_MS + 1);
    await get(req(Q, token));
    expect(upstream.length).toBe(2 * n);
  });

  it("serves the last good entry while Intel is down, up to STALE_MAX_MS, then a masked 502", async () => {
    const token = await session();
    await get(req(Q, token));
    down = true;
    vi.setSystemTime(NOW + STALE_MAX_MS - 1);
    expect((await get(req(Q, token))).status).toBe(200);
    vi.setSystemTime(NOW + STALE_MAX_MS + 1);
    const r = await get(req(Q, token));
    expect(r.status).toBe(502);
    expect(await r.text()).not.toContain("internal-detail");
  });

  it("gives 502 for a platform Intel does not know, and keeps nothing for it", async () => {
    const token = await session();
    expect((await get(req("fmspc=000000000000&ca=platform", token))).status).toBe(502);
    const n = upstream.length;
    expect((await get(req("fmspc=000000000000&ca=platform", token))).status).toBe(502);
    expect(upstream.slice(n)).toEqual([expect.stringContaining("fmspc=000000000000")]); // the shared parts came from memory
  });

  it("counts fetches that wait for Intel against the per-account evidence limit, cache hits not", async () => {
    vi.stubEnv("PAI_LIMIT_EVIDENCE_PER_MIN", "2");
    try {
      const token = await session();
      expect((await get(req(Q, token))).status).toBe(200); // cold: counted
      expect((await get(req(Q, token))).status).toBe(200); // from memory: free
      expect((await get(req("fmspc=000000000001&ca=platform", token))).status).toBe(502); // counted
      const r = await get(req("fmspc=000000000002&ca=platform", token));
      expect(r.status).toBe(429);
      expect(upstream.some((u) => u.includes("000000000002"))).toBe(false);
    } finally { vi.unstubAllEnvs(); }
  });

  it("is filled at startup and refreshed before entries go stale", async () => {
    const run = startCollateralCache(intel);
    await run(); // the startup fill already ran; await one more pass to settle it
    const startup = upstream.filter((u, i) => upstream.indexOf(u) === i);
    expect(startup).toEqual(expect.arrayContaining([
      expect.stringContaining("IntelSGXRootCA.der"), expect.stringContaining("ca=platform"), expect.stringContaining("ca=processor"),
      expect.stringContaining("/qe/identity"), ...PREFETCH_FMSPCS.map((f) => expect.stringContaining(`fmspc=${f}`)),
    ]));
    upstream = [];
    const r = await get(req(Q, await session()));
    expect(r.status).toBe(200);
    expect(upstream).toEqual([]); // the first user after a restart does not wait for Intel
    await vi.advanceTimersByTimeAsync(REFRESH_MS / 2);
    expect(upstream.some((u) => u.includes("fmspc=B0C06F000000"))).toBe(true);
  });
});
