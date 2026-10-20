import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { newNonce } from "@/lib/attestation";
import { mockReport } from "@/lib/mock-tee";
import { proofFromResponse, summarise, type Proof } from "@/lib/client/proof";
import { ProofBadge } from "@/components/app/ProofBadge";
import { ProofDrawer } from "@/components/app/ProofDrawer";

const text = (html: string) => html.replace(/<[^>]+>/g, " ");
// "not verified" / "unverified" are honest; a bare "verified" is a claim.
const claimsVerified = (s: string) => /verified/i.test(s.replace(/(not( yet)?\s+|un)verified/gi, ""));

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
    expect(text(html).trim().length).toBeLessThanOrEqual(12);
    expect(claimsVerified(text(html))).toBe(false);
    expect(claimsVerified(html)).toBe(false);
  });

  it("says Verified only when the chain is verified", () => {
    const p = passing();
    const allPass = p.reports.map((r) => ({ ...r, items: r.items.map((i) => ({ ...i, state: "pass" as const })) }));
    expect(text(badge(summarise("m", allPass, true)))).toMatch(/Verified/);
    expect(claimsVerified(badge(summarise("m", allPass, false)))).toBe(false);
  });
});

describe("proof drawer (summary first)", () => {
  it("leads with a plain status line, model, time and a check count", () => {
    const html = drawer(passing());
    const summary = html.slice(0, html.indexOf("<details"));
    expect(summary).toContain("Running in a sealed enclave. Hardware chain not yet verified.");
    expect(summary).toContain("mock:mock-tee-small");
    expect(summary).toContain("Checked");
    expect(text(summary)).toMatch(/14 of 14 checks passed/);
    expect(claimsVerified(text(summary))).toBe(false);
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
