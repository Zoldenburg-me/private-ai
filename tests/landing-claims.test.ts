import { describe, it, expect, afterEach, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { NOT_VERIFIED } from "../lib/client/proof";
import { Closing, Compare, Hero, HowItWorks, PoweredBy, Proof, frontierOn } from "../components/landing/Sections";

const render = (c: () => React.ReactElement | null) => renderToStaticMarkup(createElement(c));

// The landing page's claims are promises (AGENTS.md): "no signup" may only show while the invite gate is off.
describe("landing claims follow the invite gate", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("gate off: no-signup copy", () => {
    vi.stubEnv("INVITE_CODES", "");
    expect(render(Hero)).toContain("Start chatting, no signup");
    expect(render(Closing)).toContain("No account.");
    expect(render(Compare)).not.toContain("Invite-only beta");
  });

  it("gate on: never claims no signup or no account", () => {
    vi.stubEnv("INVITE_CODES", "test-code-1");
    const html = render(Hero) + render(Closing) + render(Compare);
    expect(html).toContain("Start chatting with an invite");
    expect(html).toContain("Invite-only beta");
    expect(html).not.toContain("no signup");
    expect(html).not.toContain("No account.");
  });

  it("frontier models: claimed only when the anonymizing gateway is configured", () => {
    vi.stubEnv("VENICE_API_KEY", "");
    vi.stubEnv("VENICE_MODELS", "");
    expect(render(Compare)).toContain("Coming soon, anonymized");
    vi.stubEnv("VENICE_API_KEY", "test-key"); // a key without vetted models is still off
    expect(render(Compare)).toContain("Coming soon, anonymized");
    vi.stubEnv("VENICE_MODELS", "test-model");
    expect(render(Compare)).not.toContain("Coming soon");
  });

  it("frontier models: admin-panel keys count, and a store outage never claims more than env does", async () => {
    vi.stubEnv("VENICE_API_KEY", "");
    vi.stubEnv("LIQUID_API_KEY", "");
    const gateway = [{ id: "venice", privacy: "anon-gateway" }] as never;
    expect(await frontierOn(async () => gateway)).toBe(true); // key stored in the admin panel only
    expect(await frontierOn(async () => [])).toBe(false);
    expect(await frontierOn(async () => { throw new Error("store down"); })).toBe(false); // falls back to env: off
    expect(renderToStaticMarkup(Compare({ frontier: true }))).not.toContain("Coming soon");
  });

  it("hero shows no hardcoded enclave status: the landing page checks nothing", () => {
    const html = render(Hero);
    expect(html).not.toContain("Enclave checks passed");
    expect(html).not.toContain("chain unverified");
  });

  it("does not claim per-reply attestation", () => {
    expect(render(Compare)).not.toContain("Checked on every reply");
  });

  it("powered-by always shows the partners, and gateways never under the confidential-compute heading", () => {
    for (const k of ["NEAR_AI", "PHALA", "TINFOIL", "PRIVATEMODE", "VENICE", "LIQUID"]) vi.stubEnv(`${k}_API_KEY`, ""); // keys live in the admin panel, not env
    const html = render(PoweredBy);
    const [tee, gateways = ""] = html.split("Frontier models via");
    expect(tee).toContain("Powered by confidential compute from");
    expect(tee).toContain('alt="NEAR AI Cloud"');
    expect(tee).toContain('alt="Phala Confidential AI"');
    expect(tee).toContain("Tinfoil");
    expect(tee).not.toContain("Venice");
    expect(gateways).toContain('alt="Venice"');
    expect(gateways).toContain("Liquid");
    expect(html).not.toContain("Mock");
  });

  // Tinfoil returns no per-reply signature (lib/evidence.ts), and the hardware chain is not verified yet.
  it("never claims every reply is signed, or that nobody can read the enclave's memory", () => {
    const files = ["components/landing/Sections.tsx", "components/app/PrivacyModes.tsx", "app/models/page.tsx"];
    const all = files.map((f) => readFileSync(f, "utf8")).join("\n") + render(Compare) + render(HowItWorks) + render(Proof);
    expect(all).not.toMatch(/every reply(,)? signed|signs? (each|every) reply|every reply carries|check on every reply/i);
    expect(all).not.toMatch(/not even the machine's owner/i);
  });

  it("proof section lists what we do not verify yet", () => {
    const html = render(Proof);
    expect(html).toContain("<details");
    expect(html).toContain("What we do not verify yet");
    for (const n of NOT_VERIFIED) expect(html).toContain(n.replace(/&/g, "&amp;"));
  });
});
