import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { newNonce } from "@/lib/attestation";
import { mockReport } from "@/lib/mock-tee";
import { proofFromResponse, serverCheckedProof, summarise, type Proof } from "@/lib/client/proof";
import { ProofBadge } from "@/components/app/ProofBadge";
import { ProofDrawer } from "@/components/app/ProofDrawer";

const text = (html: string) => html.replace(/<[^>]+>/g, " ");
// "not verified" / "unverified" / "partly verified" are honest; a bare "verified" is a claim.
const claimsVerified = (s: string) => /verified/i.test(s.replace(/(not( yet)?\s+|un|partly\s+)verified/gi, ""));

function passing(): Proof {
  const n = newNonce();
  const r = mockReport(n);
  return proofFromResponse("mock:mock-tee-small", { gateway_attestation: r, model_attestations: [r] }, n);
}
const drawer = (p: Proof) => renderToStaticMarkup(<ProofDrawer open proof={p} onClose={() => {}} onRecheck={() => {}} />);
const badge = (p: Proof | null) => renderToStaticMarkup(<ProofBadge proof={p} onOpen={() => {}} />);

describe("proof badge (short, honest)", () => {
  it("is short but keeps the full status as its accessible name", () => {
    const p = passing();
    const html = badge(p);
    expect(html).toContain(`aria-label="${p.label}"`);
    expect(html).toContain('data-testid="chain-status"');
    expect(text(html)).toMatch(/Partly verified/); // the caveat is visible, not only a dot or tooltip
    expect(text(html) + p.label).not.toMatch(/passed/i); // no "passed" claim while checks are missing
    expect(text(html)).not.toContain("✓");
    expect(text(html).replace(/\s+/g, " ").trim().length).toBeLessThanOrEqual(20);
    expect(claimsVerified(text(html))).toBe(false);
    expect(claimsVerified(html)).toBe(false);
  });

  it("says Verified only when the chain is verified", () => {
    const p = passing();
    const allPass = p.reports.map((r) => ({ ...r, items: r.items.map((i) => ({ ...i, state: "pass" as const })) }));
    expect(text(badge(summarise("m", allPass, true)))).toMatch(/Verified/);
    expect(claimsVerified(badge(summarise("m", allPass, false)))).toBe(false);
  });

  it("failed and unavailable proofs keep their own label, with no chain chip that could hide it", () => {
    const n = newNonce();
    const failed = proofFromResponse("m", { model_attestations: [mockReport(n, { debug: true })] }, n);
    const none = proofFromResponse("m", {}, n);
    expect(text(badge(failed))).toMatch(/Proof failed/);
    expect(text(badge(none))).toMatch(/No proof/);
    expect(badge(failed)).not.toContain("chain-status");
    expect(badge(none)).not.toContain("chain-status");
  });
});

describe("proof drawer (summary first)", () => {
  it("leads with a plain status line, model, time and a check count", () => {
    const html = drawer(passing());
    const summary = html.slice(0, html.indexOf("<details"));
    expect(summary).toContain("Partly verified");
    expect(summary).not.toMatch(/checks passed</); // no bare "passed" status line while checks are missing
    expect(summary).toContain("not a full proof");
    expect(summary).not.toMatch(/sealed|running in/i); // an unverified quote cannot prove where it runs
    expect(summary).toContain("mock:mock-tee-small");
    expect(summary).toContain("Checked");
    expect(text(summary)).toMatch(/14 of 14 checks run passed · 6 not run yet/);
    expect(claimsVerified(text(summary))).toBe(false);
  });

  it("lists every check that did not run before the collapsed Technical details", () => {
    const html = drawer(passing());
    const before = text(html.slice(0, html.indexOf("<details")));
    expect(before).toContain("Not checked yet");
    for (const gap of [/DCAP certificate chain and TCB/, /NRAS/, /RTMR3/, /Image provenance/, /TLS binding/]) expect(before).toMatch(gap);
  });

  it("puts the key, the explanation and every check behind a collapsed Technical details", () => {
    const html = drawer(passing());
    const at = html.indexOf("<details");
    expect(at).toBeGreaterThan(0);
    expect(html).toMatch(/<details[^>]*class="tech"(?![^>]*\bopen\b)[^>]*>/);
    expect(html.slice(at)).toContain("<summary>Technical details</summary>");
    const before = html.slice(0, at);
    expect(before).not.toMatch(/signing key/i);
    expect(before).not.toContain("proof-item-");
    expect(before).not.toContain("Intel/NVIDIA");
    expect(html.slice(at)).toMatch(/signing key/i);
    expect(html.slice(at)).toContain("proof-item-nonce echoed");
  });

  it("shows a failed check outside the collapsed section", () => {
    const n = newNonce();
    const p = proofFromResponse("m", { model_attestations: [mockReport(n, { debug: true })] }, n);
    expect(p.level).toBe("failed");
    const html = drawer(p);
    const before = html.slice(0, html.indexOf("<details"));
    expect(before).toContain('data-testid="failed-checks"');
    expect(before).toMatch(/debug/i);
    expect(claimsVerified(text(before))).toBe(false);
  });
});

describe("gateway reports", () => {
  it("RedPill's legacy aci/ report counts as its gateway, and the drawer names the provider, not NEAR", () => {
    const n = newNonce();
    const p = proofFromResponse("redpill:qwen/qwen3", { ...mockReport(n), api_version: "aci/v1" }, n);
    expect(p.reports.map((r) => r.role)).toEqual(["gateway"]);
    // A gateway-only proof makes no enclave claim for the model.
    expect(p.level).toBe("gateway-checked");
    expect(text(badge(p))).not.toMatch(/Enclave/);
    expect(claimsVerified(badge(p))).toBe(false);
    const html = text(drawer(p));
    expect(p.signingAddress).toBeUndefined(); // the gateway's key never stands in for the model's
    expect(html).not.toContain("Enclave signing key");
    expect(html).toContain("Replies are not signature-checked here");
    expect(html).not.toContain("After each reply we fetch");
    expect(html).toContain("RedPill gateway (TDX)");
    expect(html).not.toContain("NEAR AI");
    expect(html).not.toContain("Model enclave");
    // Reports without an aci/ version stay model reports; NEAR's gateway keeps its provider's name.
    expect(proofFromResponse("phala:m", mockReport(n), n).reports.map((r) => r.role)).toEqual(["model"]);
    expect(text(drawer(passing()))).toContain("Mock enclave (dev) gateway (TDX)");
    const g = mockReport(n);
    expect(proofFromResponse("redpill:m", { gateway_attestation: g, model_attestations: [{ ...mockReport(n), api_version: "aci/v1" }] }, n).reports.map((r) => r.role)).toEqual(["gateway", "model"]);
  });
});

describe("badge tone and no-enclave notes", () => {
  it("a verified proof gets the green tone, unverified does not", () => {
    const p = passing();
    const allPass = p.reports.map((r) => ({ ...r, items: r.items.map((i) => ({ ...i, state: "pass" as const })) }));
    expect(badge(summarise("m", allPass, true))).toContain("tone-ok");
    expect(badge(p)).not.toContain("tone-ok");
  });

  it("no-enclave drawer shows one note, and claims identity stripping only for anonymized models", () => {
    const p: Proof = { ...passing(), level: "no-enclave", reports: [] };
    const html = (privacy?: string) => renderToStaticMarkup(<ProofDrawer open proof={p} privacy={privacy} onClose={() => {}} onRecheck={() => {}} />);
    for (const pv of [undefined, "private", "anonymized"]) expect(html(pv).match(/summary-note/g)).toHaveLength(1);
    expect(text(html("anonymized"))).toMatch(/identity is stripped/);
    expect(text(html(undefined))).not.toMatch(/identity is stripped/);
    expect(text(html("private"))).not.toMatch(/identity is stripped/);
    expect(text(html("private"))).toMatch(/Zero-retention/);
  });
});


describe("Chutes-hosted model reports (NEAR Kimi, live shape)", () => {
  // NEAR's model_attestations entry for Chutes-hosted models: no signing_address, no intel_quote.
  const chutes = (nonce: string) => ({ provider: "chutes", verified: true, model: "moonshotai/kimi-k3", nonce, quote_b64: "AAAA", e2e_pubkey: "x", gpu_verdict: "PASS" });

  it("does not crash: the gateway stays checked, the model report is named as not checkable, and no key stands in", () => {
    const n = newNonce();
    const p = proofFromResponse("near:moonshotai/kimi-k3", { gateway_attestation: mockReport(n), model_attestations: [chutes(n)] }, n);
    expect(p.level).toBe("gateway-checked");
    expect(p.signingAddress).toBeUndefined();
    expect(p.notVerified.join(" ")).toMatch(/Chutes/);
  });

  it("a Chutes report alone is no proof", () => {
    const n = newNonce();
    expect(proofFromResponse("near:moonshotai/kimi-k3", { model_attestations: [chutes(n)] }, n).level).toBe("unavailable");
  });
});

describe("Tinfoil proof sheet", () => {
  it("says the checks ran on our server and that replies carry no signature, not '0 of 0 checks'", () => {
    const html = text(drawer(serverCheckedProof("tinfoil:kimi-k3")));
    expect(html).not.toMatch(/0 of 0/);
    expect(html).toMatch(/on our server/);
    expect(html).toContain("Tinfoil does not sign each reply");
  });
});
