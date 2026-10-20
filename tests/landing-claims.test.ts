import { describe, it, expect, afterEach, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Closing, Compare, Hero } from "../components/landing/Sections";

const render = (c: () => React.ReactElement) => renderToStaticMarkup(createElement(c));

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

  it("hero shows no hardcoded enclave status: the landing page checks nothing", () => {
    const html = render(Hero);
    expect(html).not.toContain("Enclave checks passed");
    expect(html).not.toContain("chain unverified");
  });

  it("does not claim per-reply attestation", () => {
    expect(render(Compare)).not.toContain("Checked on every reply");
  });
});
