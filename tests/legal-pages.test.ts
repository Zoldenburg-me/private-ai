import { describe, it, expect, vi, afterEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Impressum from "../app/impressum/page";
import Datenschutz from "../app/datenschutz/page";
import Agb from "../app/agb/page";
import Metadata from "../app/privacy/metadata/page";
import { DATA_INVENTORY } from "../lib/data-inventory";
import { TIERS, planLines, type TierId } from "../lib/tiers";

const render = (c: () => React.ReactElement) => renderToStaticMarkup(createElement(c));

describe("legal pages", () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  it.each([["impressum", Impressum], ["datenschutz", Datenschutz], ["agb", Agb]] as const)("%s: German + English, lawyer TODOs visible", (_n, Page) => {
    const html = render(Page);
    expect(html).toContain('id="de" lang="de"');
    expect(html).toContain('id="en" lang="en"');
    expect(html).toContain("Zoldenburg UG");
    expect(html).toMatch(/data-todo=""/);
  });
  it.each([["impressum", Impressum], ["datenschutz", Datenschutz], ["agb", Agb], ["metadata", Metadata]] as const)("%s: English first (default view), German behind #de", (_n, Page) => {
    const html = render(Page);
    expect(html.indexOf('id="en"')).toBeLessThan(html.indexOf('id="de"'));
    expect(html).toContain('href="#de"');
  });
  it.each([["impressum", Impressum], ["datenschutz", Datenschutz], ["agb", Agb], ["metadata", Metadata]] as const)("%s: lawyer TODOs are hidden on the live site", (_n, Page) => {
    vi.stubEnv("NODE_ENV", "production");
    const html = render(Page);
    expect(html).not.toMatch(/data-todo|TODO|\(\s*\)|\(\s*:|; \)|\s;|<(h[123]|p|li)>\s*<\/\1>|yearly|jährlich/);
  });
  it("agb: plans and limits come from lib/tiers, the same lines as the Settings plan cards", () => {
    const html = render(Agb);
    for (const id of Object.keys(TIERS) as TierId[]) {
      expect(html).toContain(planLines(id).join("; ").replace(/&/g, "&amp;"));
      if (TIERS[id].priceEurMonth) expect(html).toContain(`${TIERS[id].priceEurMonth} € per month`);
    }
    // German list mirrors planLines(): same line count per plan, same numbers in German format.
    const deHtml = html.slice(html.indexOf('id="de"'));
    for (const [id, t] of Object.entries(TIERS) as [TierId, (typeof TIERS)[TierId]][]) {
      const li = deHtml.match(new RegExp(`<li>${t.name}:[^]*?</li>`))![0];
      expect(li.split("; ").length).toBe(planLines(id).length + 1);
      for (const n of [t.dailyMessages, t.incognitoDailyMessages, t.agentMaxSteps]) expect(li).toContain(n.toLocaleString("de"));
    }
  });
  it("agb: says third parties, not we, run the models and enclaves (EN + DE)", () => {
    const html = render(Agb);
    expect(html).toContain("we do not run the AI models, the enclaves or the hardware");
    expect(html).toContain("Wir betreiben weder die KI-Modelle noch die Enklaven");
    // Attestation exists only for enclave providers (not gateways, ZDR or incognito ones).
    expect(html).toContain("for providers that run models in an enclave you can check the attestation");
    expect(html).toContain("bei Anbietern, die Modelle in einer Enklave betreiben, können Sie die Attestierung");
  });
  it("impressum: email and fax as two contact routes, in both languages", () => {
    const html = render(Impressum);
    expect(html.match(/kontakt@zoldenburg\.com<\/a>/g)!.length).toBe(2);
    expect(html.match(/\+49 89 41629945/g)!.length).toBe(2);
  });
  it("datenschutz: web search is on by default, can be switched off, and its query leaves even an enclave (DE + EN)", () => {
    const html = render(Datenschutz);
    expect(html).not.toMatch(/standardmäßig aus|off by default/);
    expect(html).toMatch(/Websuche \(standardmäßig an/);
    expect(html).toMatch(/Web search \(on by default/);
    expect(html).toMatch(/verlässt dann die Enklave/);
    expect(html).toMatch(/leaves the enclave/);
  });
  it("datenschutz: image prompts go to NEAR AI Cloud from other providers' chats, not offered on NEAR chats (DE + EN)", () => {
    const html = render(Datenschutz);
    expect(html).toMatch(/Bilderzeugung \([^)]*nicht bei Modellen auf NEAR AI Cloud\)[^<]*auch wenn Sie für den Chat einen anderen Anbieter gewählt haben/);
    expect(html).toMatch(/Image generation \([^)]*not for models on NEAR AI Cloud\)[^<]*even when you picked another provider for the chat/);
  });
  it("privacy/metadata lists every inventory field in both languages", () => {
    const html = render(Metadata);
    for (const d of DATA_INVENTORY) {
      expect(html).toContain(`<code>${d.field}</code>`);
      expect(html).toContain(d.retentionEn.replace(/&/g, "&amp;"));
    }
    expect(html.match(/<tr>/g)!.length).toBe(2 * (DATA_INVENTORY.length + 1));
    expect(html).toContain("IP-Adressen");
    expect(html).toContain("IP addresses");
  });
});

describe("legal navigation keeps the language", () => {
  it("the German footer links keep #de, the English one does not", () => {
    const html = renderToStaticMarkup(createElement(Agb));
    const de = html.match(/<nav[^>]*lang="de"[^>]*>([\s\S]*?)<\/nav>/)?.[1] ?? "";
    const en = html.match(/<nav[^>]*lang="en"[^>]*>([\s\S]*?)<\/nav>/)?.[1] ?? "";
    for (const p of ["/impressum", "/datenschutz", "/agb", "/privacy/metadata"]) {
      expect(de).toContain(`href="${p}#de"`);
      expect(en).toContain(`href="${p}"`);
    }
  });
});
