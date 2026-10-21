import { describe, it, expect, vi } from "vitest";
import { APIError } from "openai";

const calls: { key: string; method: string; path: string; body?: unknown }[] = [];
const created: string[] = [];
let failAttestation = false;
let apiError: APIError | undefined;
let failVerify = false;
let verifies = 0;
vi.mock("privatemode-ai", () => ({
  PrivatemodeAI: class {
    constructor(private o: { apiKey: string; openAIOptions?: { maxRetries?: number } }) { created.push(`${o.apiKey}:${o.openAIOptions?.maxRetries}`); }
    private send(method: string, path: string, body?: unknown) {
      return {
        asResponse: async () => {
          // The SDK attests before the first request; a failed check sends nothing.
          if (failAttestation) { failAttestation = false; throw new Error("attestation failed"); }
          if (apiError) { const e = apiError; apiError = undefined; throw e; }
          calls.push({ key: this.o.apiKey, method, path, body });
          return new Response("data: {}\n\n");
        },
      };
    }
    async verify() { verifies++; if (failVerify) throw new Error("attestation failed"); return { manifest: {} }; }
    get(path: string) { return this.send("GET", path); }
    post(path: string, o: { body: unknown }) { return this.send("POST", path, o.body); }
  },
}));

import { privatemodeFetch, privatemodeVerified } from "../lib/privatemode";
import { VERIFY_FAIL_CACHE_MS } from "../lib/tinfoil";

const post = (key: string, body: unknown) => ({ method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("privatemodeFetch", () => {
  it("fails closed when attestation fails, then sends on the next request", async () => {
    failAttestation = true;
    await expect(privatemodeFetch("https://api.privatemode.ai/v1/chat/completions", post("k1", { model: "glm-5.3" }))).rejects.toThrow("attestation failed");
    expect(calls).toEqual([]);
    await privatemodeFetch("https://api.privatemode.ai/v1/chat/completions", post("k1", { model: "glm-5.3", stream: true }));
    expect(calls).toEqual([{ key: "k1", method: "POST", path: "/chat/completions", body: { model: "glm-5.3", stream: true } }]);
  });

  it("sends the path after /v1 through the SDK, with one client per key and no SDK retries", async () => {
    await privatemodeFetch("http://localhost:8080/v1/models", { headers: { Authorization: "Bearer k1" } });
    await privatemodeFetch("https://api.privatemode.ai/v1/models", { headers: { Authorization: "Bearer k2" } });
    expect(calls.slice(-2)).toEqual([{ key: "k1", method: "GET", path: "/models", body: undefined }, { key: "k2", method: "GET", path: "/models", body: undefined }]);
    expect(created).toEqual(["k1:0", "k2:0"]);
  });

  it("returns upstream HTTP errors as responses with their status", async () => {
    apiError = APIError.generate(429, { error: { message: "slow down" } }, undefined, new Headers());
    const r = await privatemodeFetch("https://api.privatemode.ai/v1/chat/completions", post("k1", { model: "glm-5.3" }));
    expect(r.status).toBe(429);
    expect(r.ok).toBe(false);
  });

  it("privatemodeVerified attests once per key and reuses a pass; a failure is reused briefly, then attests again", async () => {
    const before = verifies;
    expect(await privatemodeVerified("v1", 1_000)).toBe(true);
    expect(await privatemodeVerified("v1", 2_000)).toBe(true);
    expect(verifies).toBe(before + 1);
    failVerify = true;
    expect(await privatemodeVerified("v2", 1_000)).toBe(false);
    expect(await privatemodeVerified("v2", 1_000 + VERIFY_FAIL_CACHE_MS - 1)).toBe(false); // cached: no new attempt
    expect(verifies).toBe(before + 2);
    failVerify = false;
    expect(await privatemodeVerified("v2", 1_000 + VERIFY_FAIL_CACHE_MS)).toBe(true);
  });

  it("a request that fails without an HTTP status drops the cached pass, so the next proof check attests again", async () => {
    expect(await privatemodeVerified("v3")).toBe(true);
    const before = verifies;
    failAttestation = true;
    await expect(privatemodeFetch("https://api.privatemode.ai/v1/models", { headers: { Authorization: "Bearer v3" } })).rejects.toThrow();
    expect(await privatemodeVerified("v3")).toBe(true);
    expect(verifies).toBe(before + 1);
  });
});
