import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { _setStores } from "../lib/store";
import { _clearCatalog } from "../lib/catalog-cache";
import { createSession, touchSession } from "../lib/session";
import { proxyEvidence } from "../lib/evidence";
import * as attestationRoute from "../app/api/attestation/route";
import * as signatureRoute from "../app/api/signature/route";

const NONCE = "ab".repeat(32);
let upstream: string[];
let upstreamStatus: number;
const fake = (async (url: string) => {
  upstream.push(url);
  if (url.endsWith("/models")) return Response.json({ data: [{ id: "m1" }] });
  return new Response(upstreamStatus === 200 ? '{"ok":true}' : "internal upstream detail", { status: upstreamStatus });
}) as unknown as typeof fetch;
const attestation = proxyEvidence("attestation", fake);
const signature = proxyEvidence("signature", fake);
const get = (q: string, token?: string) => new Request(`http://app/api/x?${q}`, { headers: token ? { Cookie: `pai_session=${token}` } : {} });
async function session() { const s = await createSession(); await touchSession(s.id); return s.token; }

beforeEach(() => {
  _setStores(); _clearCatalog(); upstream = []; upstreamStatus = 200;
  vi.stubEnv("MOCK_PROVIDER", "1"); vi.stubEnv("MOCK_BASE_URL", "http://up/v1");
  vi.stubGlobal("fetch", fake); // the catalog fetch
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); _clearCatalog(); });

describe("evidence endpoints (spend the shared provider key)", () => {
  it("time out: the provider fetch carries a timeout signal, and a failure is a masked 502", async () => {
    const token = await session();
    const failing = vi.fn(async (_u: string, init: RequestInit) => { expect(init.signal).toBeInstanceOf(AbortSignal); throw new Error("timeout"); }) as unknown as typeof fetch;
    const r = await proxyEvidence("signature", failing)(get("model=mock:m1&chat_id=c1", token));
    expect(r.status).toBe(502);
    expect(await r.text()).not.toContain("timeout");
    expect(failing).toHaveBeenCalledOnce();
  });
  it("are wired into the Node.js routes, which need a session", async () => {
    for (const route of [attestationRoute, signatureRoute]) {
      expect(route.runtime).toBe("nodejs");
      expect((await route.GET(get(`model=mock:m1&nonce=${NONCE}&chat_id=c1`))).status).toBe(401);
    }
    expect(upstream).toEqual([]);
  });
  it("need a session and never reach the provider without one", async () => {
    expect((await attestation(get(`model=mock:m1&nonce=${NONCE}`))).status).toBe(401);
    expect((await signature(get("model=mock:m1&chat_id=c1"))).status).toBe(401);
    expect(upstream).toEqual([]);
  });
  it("proxy attestation and signature for a catalog model", async () => {
    const token = await session();
    const a = await attestation(get(`model=mock:m1&nonce=${NONCE}`, token));
    expect(a.status).toBe(200);
    expect(await a.json()).toEqual({ ok: true });
    expect((await signature(get("model=mock:m1&chat_id=c1", token))).status).toBe(200);
    expect(upstream.filter((u) => !u.endsWith("/models"))).toEqual([
      `http://up/v1/attestation/report?model=m1&nonce=${NONCE}&signing_algo=ecdsa`,
      "http://up/v1/signature/c1?model=m1&signing_algo=ecdsa",
    ]);
  });
  it("reject models that are not in the catalog", async () => {
    const token = await session();
    expect((await attestation(get(`model=mock:other&nonce=${NONCE}`, token))).status).toBe(400);
    expect(upstream.every((u) => u.endsWith("/models"))).toBe(true);
  });
  it("return a generic error instead of the upstream body", async () => {
    const token = await session();
    upstreamStatus = 500;
    const r = await attestation(get(`model=mock:m1&nonce=${NONCE}`, token));
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ error: { message: "evidence unavailable" } });
  });
  it("are rate-limited per account", async () => {
    vi.stubEnv("PAI_LIMIT_EVIDENCE_PER_MIN", "2");
    const [a, b] = [await session(), await session()];
    expect((await attestation(get(`model=mock:m1&nonce=${NONCE}`, a))).status).toBe(200);
    expect((await signature(get("model=mock:m1&chat_id=c1", a))).status).toBe(200);
    expect((await attestation(get(`model=mock:m1&nonce=${NONCE}`, a))).status).toBe(429);
    expect((await attestation(get(`model=mock:m1&nonce=${NONCE}`, b))).status).toBe(200); // another account is unaffected
  });
  it("have a global cap, so minting fresh sessions does not get around the per-account limit", async () => {
    vi.stubEnv("PAI_LIMIT_EVIDENCE_ALL_PER_MIN", "2");
    expect((await attestation(get(`model=mock:m1&nonce=${NONCE}`, await session()))).status).toBe(200);
    expect((await attestation(get(`model=mock:m1&nonce=${NONCE}`, await session()))).status).toBe(200);
    const r = await attestation(get(`model=mock:m1&nonce=${NONCE}`, await session()));
    expect(r.status).toBe(429);
    expect(upstream.filter((u) => !u.endsWith("/models"))).toHaveLength(2);
  });
});
