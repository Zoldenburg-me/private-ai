import { describe, it, expect, vi } from "vitest";

const sent: string[] = [];
let failReady = true;
let failFetch = false;
let attested = false;
let attestations = 0;
vi.mock("tinfoil", () => ({
  SecureClient: class {
    async ready() {
      if (attested) return;
      if (failReady) { failReady = false; throw new Error("attestation failed"); }
      attestations++; attested = true;
    }
    reset() { attested = false; }
    getBaseURL() { return "https://enclave.example/v1/"; }
    fetch = async (url: URL) => {
      if (failFetch) { failFetch = false; throw new TypeError("fetch failed"); }
      sent.push(String(url)); return new Response("ok");
    };
  },
}));

import { tinfoilFetch, tinfoilVerified, VERIFY_FAIL_CACHE_MS } from "../lib/tinfoil";

describe("tinfoilFetch", () => {
  it("fails closed when attestation fails, then re-attests on the next request", async () => {
    await expect(tinfoilFetch("https://inference.tinfoil.sh/v1/models")).rejects.toThrow("attestation failed");
    expect(sent).toEqual([]);
    await tinfoilFetch("https://inference.tinfoil.sh/v1/models");
    expect(sent).toEqual(["https://enclave.example/v1/models"]);
  });

  it("sends the path after /v1 to the verified enclave", async () => {
    await tinfoilFetch("https://inference.tinfoil.sh/v1/chat/completions?x=1", { method: "POST" });
    expect(sent.at(-1)).toBe("https://enclave.example/v1/chat/completions?x=1");
  });

  it("re-attests on the next request after a transport error", async () => {
    const before = attestations;
    await tinfoilFetch("https://inference.tinfoil.sh/v1/models");
    expect(attestations).toBe(before); // attestation is reused while the channel works
    failFetch = true;
    await expect(tinfoilFetch("https://inference.tinfoil.sh/v1/models")).rejects.toThrow("fetch failed");
    await tinfoilFetch("https://inference.tinfoil.sh/v1/models");
    expect(attestations).toBe(before + 1);
  });

  it("tinfoilVerified reports the SDK's attestation; a failure is reused briefly instead of attesting on every call", async () => {
    attested = false; failReady = true;
    const before = attestations;
    expect(await tinfoilVerified(1_000)).toBe(false);
    expect(await tinfoilVerified(1_000 + VERIFY_FAIL_CACHE_MS - 1)).toBe(false); // cached: no new attempt
    expect(attestations).toBe(before);
    expect(await tinfoilVerified(1_000 + VERIFY_FAIL_CACHE_MS)).toBe(true);
    expect(attestations).toBe(before + 1);
  });

  it("a request that attests again clears a cached failure", async () => {
    attested = false; failReady = true;
    expect(await tinfoilVerified()).toBe(false);
    await tinfoilFetch("https://inference.tinfoil.sh/v1/models"); // attests successfully
    expect(await tinfoilVerified()).toBe(true);
  });
});
