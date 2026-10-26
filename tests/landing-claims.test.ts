import { describe, it, expect, afterEach, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync } from "node:fs";
import { NOT_VERIFIED } from "../lib/client/proof";
import { Closing, Compare, Faq, Hero, HowItWorks, PoweredBy, Pricing, Proof, frontierOn } from "../components/landing/Sections";
import { SoundToggle } from "../components/landing/SoundToggle";
import About from "../app/about/page";
import { FRONTIER_MODELS, PAID_ONLY_MODELS, TIERS } from "../lib/tiers";

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

  it("about page: no-signup claim only while the gate is off", () => {
    vi.stubEnv("INVITE_CODES", "");
    expect(render(About)).toContain("Start chatting without signing up");
    vi.stubEnv("INVITE_CODES", "test-code-1");
    const html = render(About);
    expect(html).not.toContain("without signing up");
    expect(html).not.toContain("No account by default");
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

  it("the FAQ says plainly that messages pass through our server", () => {
    const html = render(Faq);
    expect(html).toMatch(/pass through our server in Germany.*log or store/);
    expect(html).not.toMatch(/Can you read my chats\?<\/summary><p>No\b/); // the relay sees live messages: no blanket denial
  });

  it("does not claim per-reply attestation", () => {
    expect(render(Compare)).not.toContain("Checked on every reply");
  });

  it("powered-by always shows the partners, and gateways never under the confidential-compute heading", () => {
    for (const k of ["NEAR_AI", "PHALA", "TINFOIL", "PRIVATEMODE", "VENICE", "LIQUID"]) vi.stubEnv(`${k}_API_KEY`, ""); // keys live in the admin panel, not env
    const html = render(PoweredBy);
    const [tee, gateways = ""] = html.split("Frontier models via");
    expect(tee).toContain("Runs on confidential compute from");
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

  it("proof section lists what we do not verify yet, behind the technical details", () => {
    const html = render(Proof);
    expect(html).toContain("<details");
    expect(html).toContain("Technical details");
    expect(html).toContain("Not verified yet");
    expect(html).toContain("Example reply."); // the demo is labelled as an example
    expect(html).toContain("chain not verified yet"); // and claims no more than the app shows today
    expect(html).not.toMatch(/signed in (the )?enclave/i); // with the chain unverified the app says "signature matches", not "signed by"
    for (const n of NOT_VERIFIED) expect(html).toContain(n.replace(/&/g, "&amp;"));
  });
});

// Pricing belongs to lib/tiers.ts (another branch reworks it): the page shows what TIERS has and nothing it lacks.
describe("landing pricing follows lib/tiers.ts", () => {
  const html = renderToStaticMarkup(Pricing({ frontier: true }));

  it("renders every plan TIERS has, at its price", () => {
    for (const t of Object.values(TIERS)) {
      expect(html).toContain(`<h3>${t.name}</h3>`);
      expect(html).toContain(`€${t.priceEurMonth}`);
    }
    expect(html).toContain(TIERS.pro.dailyMessages.toLocaleString("en"));
    expect(html).toContain(`up to ${TIERS.pro.agentMaxSteps} steps per run`);
  });

  it("has no numbers or features TIERS does not define", () => {
    expect(html).not.toMatch(/images? a day|video|music|yearly|billed/i);
    // Frontier credit is a TIERS number: each plan shows exactly its own included amount.
    for (const t of Object.values(TIERS)) if (t.includedCreditsEur && t.id !== "pro") expect(html).toContain(`€${t.includedCreditsEur} frontier credit a month`);
    expect(html).toContain(`€${TIERS.pro.includedCreditsEur} of credit included every month`); // Pro is the big card
    expect(renderToStaticMarkup(Pricing({ frontier: false }))).not.toMatch(/credit/i);
    expect(html).not.toContain("frontier models pay as you go"); // Free cannot use the paid-only frontier models
    expect(readFileSync("components/landing/Sections.tsx", "utf8")).not.toMatch(/Generate images|€8\b|€80\b|€150\b|€490\b|Choose Plus|"Plus"/);
  });

  it("frontier models only while a gateway is live, and only the FRONTIER_MODELS TIERS lists", () => {
    expect(renderToStaticMarkup(Pricing({ frontier: false }))).not.toContain("frontier models");
    const shown = [...html.matchAll(/brand\/frontier\/(\w+)\.svg/g)].map((m) => m[1]);
    expect(shown.length).toBeGreaterThan(0);
    const prefix: Record<string, string> = { claude: "claude", gemini: "gemini", chatgpt: "gpt", grok: "grok" };
    for (const s of shown) expect([...FRONTIER_MODELS].some((id) => id.startsWith(prefix[s]))).toBe(true);
    expect(shown).toEqual(["claude", "gemini", "chatgpt", "grok"]);
    expect(PAID_ONLY_MODELS.has("grok-4-7")).toBe(false); // named on the landing, but open to every plan on credits
  });
});

// Sound is opt-in (Map.dc.html: "opt-in synthesised sound"), synthesised, and never remembered.
describe("landing sound and storage", () => {
  it("the toggle starts off", () => {
    const html = renderToStaticMarkup(createElement(SoundToggle));
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain("Turn sound on");
  });

  it("plays no audio files and writes no browser storage; motion needs no scroll listener", () => {
    // Every landing file, so new components are covered too.
    const files = readdirSync("components/landing").filter((f) => /\.tsx?$/.test(f)).map((f) => readFileSync(`components/landing/${f}`, "utf8")).join("\n");
    expect(files).not.toMatch(/new Audio\(|\.mp3|\.wav|\.ogg/);
    expect(files).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
    expect(files + readFileSync("app/landing.css", "utf8")).not.toMatch(/addEventListener\(\s*["']scroll/);
    const css = readFileSync("app/landing.css", "utf8");
    expect(css).toContain("prefers-reduced-motion: no-preference");
    expect(css).not.toMatch(/infinite/); // looping motion would need a pause control (WCAG 2.2.2)
  });

  it("keeps the section anchors the nav and other pages link to", async () => {
    const page = readFileSync("app/page.tsx", "utf8");
    for (const c of ["HowItWorks", "Proof", "Compare", "Pricing", "Faq"]) expect(page).toContain(`<${c}`);
    const html = render(HowItWorks) + render(Proof) + render(Compare) + renderToStaticMarkup(Pricing({})) + render(Faq);
    for (const id of ["how", "proof", "compare", "pricing", "faq"]) expect(html).toContain(`id="${id}"`);
  });
});

// /datenschutz names Cloudflare as seeing messages in transit; the chat's own privacy copy must not leave it out.
describe("chat privacy copy names Cloudflare", () => {
  it("in settings and under the composer", () => {
    for (const f of ["components/app/SettingsView.tsx", "components/app/ChatThread.tsx"])
      expect(readFileSync(f, "utf8")).toContain("Cloudflare");
  });
});
