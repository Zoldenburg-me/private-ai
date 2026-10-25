import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Impressum from "../app/impressum/page";
import Datenschutz from "../app/datenschutz/page";
import Agb from "../app/agb/page";
import Metadata from "../app/privacy/metadata/page";
import { DATA_INVENTORY } from "../lib/data-inventory";

const render = (c: () => React.ReactElement) => renderToStaticMarkup(createElement(c));

describe("legal pages", () => {
  it.each([["impressum", Impressum], ["datenschutz", Datenschutz], ["agb", Agb]] as const)("%s: German + English, lawyer TODOs visible", (_n, Page) => {
    const html = render(Page);
    expect(html).toContain('id="de" lang="de"');
    expect(html).toContain('id="en" lang="en"');
    expect(html).toContain("Zoldenburg UG");
    expect(html).toMatch(/data-todo=""/);
  });
  it("datenschutz: web search is on by default, can be switched off, and its query leaves even an enclave (DE + EN)", () => {
    const html = render(Datenschutz);
    expect(html).not.toMatch(/standardmäßig aus|off by default/);
    expect(html).toMatch(/Websuche \(standardmäßig an/);
    expect(html).toMatch(/Web search \(on by default/);
    expect(html).toMatch(/verlässt dann die Enklave/);
    expect(html).toMatch(/leaves the enclave/);
  });
  it("datenschutz: image prompts go to NEAR AI Cloud whichever chat provider is picked (DE + EN)", () => {
    const html = render(Datenschutz);
    expect(html).toMatch(/Bilderzeugung[^<]*NEAR AI Cloud/);
    expect(html).toMatch(/Image generation[^<]*NEAR AI Cloud/);
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
