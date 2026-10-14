import { describe, it, expect } from "vitest";
import { newNonce } from "@/lib/attestation";
import { mockReport, mockQuote } from "@/lib/mock-tee";
import { proofFromResponse, summarise, readMeasurements, expectedMrConfigId, TD_FIELDS, LEVEL_LABEL, signatureLevel, normalizeSigned } from "@/lib/client/proof";
import { hexToBytes, bytesToHex } from "@noble/hashes/utils";

describe("proof model (honest badge)", () => {
  it("valid mock evidence => checks-passed, never 'Verified' while the chain is unchecked", () => {
    const n = newNonce();
    const r = mockReport(n);
    const p = proofFromResponse("mock:mock-tee-small", { gateway_attestation: r, model_attestations: [r] }, n);
    expect(p.level).toBe("checks-passed");
    expect(p.chainVerified).toBe(false);
    expect(p.label).not.toMatch(/^Verified/);
    expect(p.label).toMatch(/chain not verified/);
    expect(p.notVerified.length).toBeGreaterThan(0);
    const dcap = p.reports[0].items.find((i) => i.id === "dcap-chain");
    expect(dcap?.state).toBe("not-checked");
  });

  it("debug enclave or wrong nonce => failed", () => {
    const n = newNonce();
    expect(proofFromResponse("m", { model_attestations: [mockReport(n, { debug: true })] }, n).level).toBe("failed");
    expect(proofFromResponse("m", { model_attestations: [mockReport(n)] }, newNonce()).level).toBe("failed");
  });

  it("no reports => unavailable", () => {
    expect(proofFromResponse("m", {}, newNonce()).level).toBe("unavailable");
  });

  it("'verified' only when chainVerified AND every item passed", () => {
    const n = newNonce();
    const base = proofFromResponse("m", { model_attestations: [mockReport(n)] }, n).reports;
    expect(summarise("m", base, true).level).toBe("checks-passed"); // still has not-checked items
    const allPass = base.map((r) => ({ ...r, items: r.items.map((i) => ({ ...i, state: "pass" as const })) }));
    expect(summarise("m", allPass, false).level).toBe("checks-passed");
    const v = summarise("m", allPass, true);
    expect(v.level).toBe("verified"); expect(v.label).toBe(LEVEL_LABEL.verified);
  });

  it("reads TDX measurements and checks MRCONFIGID against app_compose", () => {
    const n = newNonce();
    const compose = '{"services":{}}';
    const q = hexToBytes(mockQuote(n));
    q.set(hexToBytes(expectedMrConfigId(compose)), TD_FIELDS.MRCONFIGID);
    q.set(new Uint8Array(48).fill(0xab), TD_FIELDS.MRTD);
    const rep = { ...mockReport(n), intel_quote: bytesToHex(q), info: { tcb_info: JSON.stringify({ app_compose: compose }) } };
    const m = readMeasurements(rep.intel_quote);
    expect(m.find((x) => x.name === "MRTD")?.value).toBe("ab".repeat(48));
    const p = proofFromResponse("m", { model_attestations: [rep] }, n);
    expect(p.reports[0].items.find((i) => i.id === "compose")?.state).toBe("pass");
    const bad = proofFromResponse("m", { model_attestations: [{ ...rep, info: { tcb_info: { app_compose: "tampered" } } }] }, n);
    expect(bad.level).toBe("failed");
  });

  it("a matching signature is 'signed by enclave' only when the quote chain is verified", () => {
    const n = newNonce();
    const p = proofFromResponse("m", { model_attestations: [mockReport(n)] }, n);
    expect(signatureLevel(p, true)).toBe("key-match");
    expect(signatureLevel(p, false)).toBe("fail");
    expect(signatureLevel({ chainVerified: true }, true)).toBe("enclave");
    expect(normalizeSigned("ok")).toBe("key-match"); // legacy entries were never chain-verified
    expect(normalizeSigned("enclave")).toBe("enclave");
    expect(normalizeSigned("bogus")).toBeUndefined();
  });
});
