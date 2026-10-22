import { describe, it, expect, vi } from "vitest";
import { APIError } from "openai";

const calls: { key: string; method: string; path: string; body?: unknown }[] = [];
const created: string[] = [];
let failAttestation = false;
let apiError: APIError | undefined;
let failVerify = false;
let verifies = 0;
let streamFailsAfterFirstChunk = false;
let upstreamPulls: number | undefined;
vi.mock("privatemode-ai", () => ({
  PrivatemodeAI: class {
    constructor(private o: { apiKey: string; apiBaseURL?: string; openAIOptions?: { maxRetries?: number } }) { created.push(`${o.apiKey}:${o.apiBaseURL}:${o.openAIOptions?.maxRetries}`); }
    private send(method: string, path: string, body?: unknown) {
      return {
        asResponse: async () => {
          // The SDK attests before the first request; a failed check sends nothing.
          if (failAttestation) { failAttestation = false; throw new Error("attestation failed"); }
          if (apiError) { const e = apiError; apiError = undefined; throw e; }
          calls.push({ key: this.o.apiKey, method, path, body });
          if (streamFailsAfterFirstChunk) {
            streamFailsAfterFirstChunk = false;
            let sent = false;
            return new Response(new ReadableStream({ pull(c) { if (sent) c.error(new Error("decryption failed")); else { sent = true; c.enqueue(new TextEncoder().encode("data: {}\n\n")); } } }));
          }
          if (upstreamPulls !== undefined) return new Response(new ReadableStream({ pull(c) { upstreamPulls!++; c.enqueue(new TextEncoder().encode("data: {}\n\n")); } }, { highWaterMark: 0 }));
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

const BASE = "https://api.privatemode.ai/v1";
const post = (key: string, body: unknown) => ({ method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("privatemodeFetch", () => {
  it("fails closed when attestation fails, then sends on the next request", async () => {
    failAttestation = true;
    await expect(privatemodeFetch("https://api.privatemode.ai/v1/chat/completions", post("k1", { model: "glm-5.3" }))).rejects.toThrow("attestation failed");
    expect(calls).toEqual([]);
    await privatemodeFetch("https://api.privatemode.ai/v1/chat/completions", post("k1", { model: "glm-5.3", stream: true }));
    expect(calls).toEqual([{ key: "k1", method: "POST", path: "/chat/completions", body: { model: "glm-5.3", stream: true } }]);
  });

  it("sends the path after /v1 through the SDK, with one client per origin and key and no SDK retries", async () => {
    const before = created.length;
    await privatemodeFetch("http://localhost:8080/v1/models", { headers: { Authorization: "Bearer k1" } });
    await privatemodeFetch("https://api.privatemode.ai/v1/models", { headers: { Authorization: "Bearer k2" } });
    expect(calls.slice(-2)).toEqual([{ key: "k1", method: "GET", path: "/models", body: undefined }, { key: "k2", method: "GET", path: "/models", body: undefined }]);
    expect(created.slice(before)).toEqual(["k1:http://localhost:8080:0", "k2:https://api.privatemode.ai:0"]);
  });

  it("returns upstream HTTP errors as responses with their status", async () => {
    apiError = APIError.generate(429, { error: { message: "slow down" } }, undefined, new Headers());
    const r = await privatemodeFetch("https://api.privatemode.ai/v1/chat/completions", post("k1", { model: "glm-5.3" }));
    expect(r.status).toBe(429);
    expect(r.ok).toBe(false);
  });

  it("privatemodeVerified attests once per key and reuses a pass; a failure is reused briefly, then attests again", async () => {
    const before = verifies;
    expect(await privatemodeVerified(BASE, "v1", 1_000)).toBe(true);
    expect(await privatemodeVerified(BASE, "v1", 2_000)).toBe(true);
    expect(verifies).toBe(before + 1);
    failVerify = true;
    expect(await privatemodeVerified(BASE, "v2", 1_000)).toBe(false);
    expect(await privatemodeVerified(BASE, "v2", 1_000 + VERIFY_FAIL_CACHE_MS - 1)).toBe(false); // cached: no new attempt
    expect(verifies).toBe(before + 2);
    failVerify = false;
    expect(await privatemodeVerified(BASE, "v2", 1_000 + VERIFY_FAIL_CACHE_MS)).toBe(true);
  });

  it("a request that fails without an HTTP status drops the cached pass, so the next proof check attests again", async () => {
    expect(await privatemodeVerified(BASE, "v3")).toBe(true);
    const before = verifies;
    failAttestation = true;
    await expect(privatemodeFetch("https://api.privatemode.ai/v1/models", { headers: { Authorization: "Bearer v3" } })).rejects.toThrow();
    expect(await privatemodeVerified(BASE, "v3")).toBe(true);
    expect(verifies).toBe(before + 1);
  });

  it("sends to the configured base URL: one client per origin and key, and the proof check uses the same one", async () => {
    const before = created.length;
    await privatemodeFetch("https://private.example/v1/models", { headers: { Authorization: "Bearer k1" } });
    expect(created.slice(before)).toEqual(["k1:https://private.example:0"]);
    expect(await privatemodeVerified("https://private.example/v1", "k1")).toBe(true);
    expect(created.slice(before)).toEqual(["k1:https://private.example:0"]); // reused, not a client for the default host
  });

  it("a stream that fails after its first chunk drops the cached pass, without buffering the stream", async () => {
    expect(await privatemodeVerified(BASE, "v4")).toBe(true);
    const before = verifies;
    streamFailsAfterFirstChunk = true;
    const r = await privatemodeFetch("https://api.privatemode.ai/v1/chat/completions", post("v4", { model: "glm-5.3", stream: true }));
    const reader = r.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: {}\n\n");
    expect(await privatemodeVerified(BASE, "v4")).toBe(true); // first chunk arrived: the pass still holds
    expect(verifies).toBe(before);
    await expect(reader.read()).rejects.toThrow("decryption failed");
    expect(await privatemodeVerified(BASE, "v4")).toBe(true);
    expect(verifies).toBe(before + 1); // attested again
  });

  it("reads upstream only when the caller reads: the wrapper does not prefetch", async () => {
    upstreamPulls = 0;
    const r = await privatemodeFetch("https://api.privatemode.ai/v1/chat/completions", post("v5", { model: "glm-5.3", stream: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(upstreamPulls).toBe(0);
    await r.body!.getReader().read();
    expect(upstreamPulls).toBe(1);
    upstreamPulls = undefined;
  });
});
