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
  // NEAR has signed `model:req:resp` since 2026-03-04 (nearai/inference-proxy #50); the legacy form is `req:resp`.
  const exp = { reqSha256: "aa", respSha256: "bb", model: "deepseek-ai/DeepSeek-V3.1" };
  const signed = (t: string) => verifySignedResponse({ text: t, signature: mockSign(t) }, mockAddress(), exp);
  it("accepts the legacy 2-part signed text", () => expect(signed("aa:bb").ok).toBe(true));
  it("accepts the 3-part signed text naming the model we called", () => expect(signed("deepseek-ai/DeepSeek-V3.1:aa:bb").ok).toBe(true));
  it("accepts a model id that itself contains a colon", () => {
    const t = "org/m:fp8:aa:bb";
    expect(verifySignedResponse({ text: t, signature: mockSign(t) }, mockAddress(), { ...exp, model: "org/m:fp8" }).ok).toBe(true);
  });
  it("rejects a 3-part signed text for another model", () => expect(signed("other/model:aa:bb").ok).toBe(false));
  it("rejects a 3-part signed text when we don't know the model", () => {
    const t = "deepseek-ai/DeepSeek-V3.1:aa:bb";
    expect(verifySignedResponse({ text: t, signature: mockSign(t) }, mockAddress(), { reqSha256: "aa", respSha256: "bb" }).ok).toBe(false);
  });
  it("rejects a tampered hash in either form", () => {
    expect(signed("deepseek-ai/DeepSeek-V3.1:aa:cc").ok).toBe(false);
    expect(signed("aa:cc").ok).toBe(false);
  });
});

describe("verifyReport on a report without key or quote", () => {
  it("fails its checks instead of throwing", () => {
    const v = verifyReport({} as never, "00".repeat(32));
    expect(v.ok).toBe(false);
    expect(v.signingAddress).toBe("");
  });
});
