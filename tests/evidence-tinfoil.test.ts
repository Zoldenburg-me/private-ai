import { describe, it, expect, beforeEach, vi } from "vitest";

let verified = true;
const upstream: string[] = [];
vi.mock("../lib/tinfoil", () => ({ tinfoilFetch: vi.fn(), tinfoilVerified: async () => verified }));
vi.mock("../lib/provider-keys", () => ({ liveProviders: async () => [{ id: "tinfoil", baseUrl: "https://inference.tinfoil.sh/v1", apiKey: "k" }] }));
vi.mock("../lib/catalog-cache", () => ({ getCatalog: async () => [{ id: "kimi-k3", provider: "tinfoil", privacy: "tee-attested", selectable: true }] }));

import { _setStores } from "../lib/store";
import { createSession, touchSession } from "../lib/session";
import { proxyEvidence } from "../lib/evidence";

const fake = (async (url: string) => { upstream.push(url); return Response.json({}); }) as unknown as typeof fetch;
const attestation = proxyEvidence("attestation", fake);
const get = (token: string) => new Request(`http://app/api/attestation?model=tinfoil:kimi-k3&nonce=${"ab".repeat(32)}`, { headers: { Cookie: `pai_session=${token}` } });

beforeEach(() => { _setStores(); upstream.length = 0; });

describe("Tinfoil attestation (checked by the SDK on our server)", () => {
  it("says server_checked only after the SDK passed, else a masked 502; never fetches a NEAR-style report", async () => {
    const s = await createSession(); await touchSession(s.id);
    verified = true;
    const ok = await attestation(get(s.token));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ server_checked: true });
    verified = false;
    expect((await attestation(get(s.token))).status).toBe(502);
    expect(upstream).toEqual([]);
  });
});
