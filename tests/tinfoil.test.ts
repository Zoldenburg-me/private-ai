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

import { tinfoilFetch } from "../lib/tinfoil";

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
});
