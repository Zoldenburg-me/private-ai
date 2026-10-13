import { describe, it, expect } from "vitest";
import { verifyReport, verifySignedResponse, newNonce, recoverAddress } from "../lib/attestation";
import { mockReport, mockSign, mockAddress, mockQuote } from "../lib/mock-tee";

describe("TEE attestation verification", () => {
  it("accepts a well-formed fresh report", () => {
    const n = newNonce();
    const r = verifyReport(mockReport(n), n);
    expect(r.ok).toBe(true);
    expect(r.chainVerified).toBe(false); // DCAP chain not verified locally -> never overclaimed
  });
  it("rejects debug-mode enclaves", () => {
    const n = newNonce();
    const r = verifyReport(mockReport(n, { debug: true }), n);
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === "debug mode off")?.ok).toBe(false);
  });
  it("rejects stale / replayed nonce", () => {
    const n = newNonce();
    expect(verifyReport(mockReport(n), newNonce()).ok).toBe(false);
  });
  it("rejects report_data not bound to signer", () => {
    const n = newNonce();
    const rep = { ...mockReport(n), intel_quote: mockQuote(n, { address: "0x" + "11".repeat(20) }) };
    expect(verifyReport(rep, n).checks.find((c) => c.name.startsWith("report_data"))?.ok).toBe(false);
  });
  it("rejects short/garbage quotes", () => {
    const n = newNonce();
    expect(verifyReport({ ...mockReport(n), intel_quote: "abcd" }, n).ok).toBe(false);
  });
});

describe("signed responses", () => {
  it("recovers mock enclave address", () => {
    expect(recoverAddress("hello", mockSign("hello"))).toBe(mockAddress());
  });
  it("verifies signer and hashes", () => {
    const text = "aa:bb";
    expect(verifySignedResponse({ text, signature: mockSign(text) }, mockAddress(), { reqSha256: "aa", respSha256: "bb" }).ok).toBe(true);
    expect(verifySignedResponse({ text, signature: mockSign(text) }, mockAddress(), { reqSha256: "aa", respSha256: "cc" }).ok).toBe(false);
    expect(verifySignedResponse({ text, signature: mockSign(text) }, "0x" + "22".repeat(20)).ok).toBe(false);
  });
});
