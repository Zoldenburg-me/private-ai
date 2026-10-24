import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { ModelEntry } from "@/lib/catalog";
import { ModalityIcons, ModelPicker, blockedReason } from "@/components/app/ModelPicker";
import { ToolsMenu } from "@/components/app/ToolsMenu";
import { SettingsView } from "@/components/app/SettingsView";
import { ProofDrawer } from "@/components/app/ProofDrawer";
import { LEVEL_LABEL } from "@/lib/client/proof";

const kimi: ModelEntry = { id: "kimi-k3", provider: "venice", name: "Kimi K3", privacy: "private", tee: false, e2ee: false, selectable: true, incognito: true };
const auto = { id: "kimi-k3", provider: "auto", name: "Auto · Kimi K3", privacy: "tee" as const, tee: true, e2ee: false, selectable: true, routes: ["near:k"] };
const noop = () => {};
const privacy = (level: "max" | "medium" | "anon", isAuto: boolean) => ({ level, onLevel: noop, auto: isAuto, onAuto: noop });

describe("privacy level pill", () => {
  it("shows the level and Auto while Auto is on", () => {
    const html = renderToStaticMarkup(<ModelPicker models={[auto]} value="auto:kimi-k3" onChange={noop} privacy={privacy("max", true)} />);
    expect(html).toContain("Max · Auto");
  });
  it("shows the level and the model's own name (no Auto prefix) when the user picked one", () => {
    expect(renderToStaticMarkup(<ModelPicker models={[kimi]} value="venice:kimi-k3" onChange={noop} privacy={privacy("medium", false)} />)).toContain("Medium · Kimi K3");
    expect(renderToStaticMarkup(<ModelPicker models={[auto]} value="auto:kimi-k3" onChange={noop} privacy={privacy("max", false)} />)).toContain("Max · Kimi K3");
  });
});

describe("tools menu", () => {
  it("says whether web search is on, and is off-limits when the server has no search", () => {
    expect(renderToStaticMarkup(<ToolsMenu available webSearch onWebSearch={noop} />)).toContain("Tools: web search on");
    expect(renderToStaticMarkup(<ToolsMenu available webSearch={false} onWebSearch={noop} />)).toContain("Tools: web search off");
    expect(renderToStaticMarkup(<ToolsMenu available={false} webSearch onWebSearch={noop} />)).toContain("Tools: web search off");
  });
  it("uses plain buttons, not menu roles that promise arrow-key navigation it does not have", () => {
    const src = readFileSync("components/app/ToolsMenu.tsx", "utf8");
    expect(src).not.toMatch(/role="menu|aria-haspopup="menu"/);
    expect(src).toMatch(/aria-pressed=\{on\}/);
  });
});

describe("settings: privacy and tools", () => {
  const view = (available: boolean) => renderToStaticMarkup(<SettingsView tier={null} usage={null} billing={null} passkeys={null} ghost={false} account={null} devices={[]}
    onSignOut={noop} onRemoveDevice={noop} onCheckout={noop} onPortal={noop} onAddPasskey={noop} onLoginPasskey={noop} onRemovePasskey={noop}
    onExportAccount={noop} onDeleteAccount={noop} onExport={noop} onImport={noop} onWipe={noop}
    tools={{ available, webSearch: true, onWebSearch: noop, pickProvider: false, onPickProvider: noop }} />);
  it("offers web search (saying queries go to Brave) and provider choice", () => {
    const html = view(true);
    expect(html).toContain("data-testid=\"setting-web-search\"");
    expect(html).toMatch(/Brave/);
    expect(html).toContain("data-testid=\"setting-pick-provider\"");
  });
  it("says so when this server has no web search", () => {
    expect(view(false)).toMatch(/not available on this server/);
  });
});

describe("proof sheet", () => {
  it("shows which route Auto is using and why", () => {
    const proof = { modelRef: "near:k", level: "checks-passed" as const, label: LEVEL_LABEL["checks-passed"], chainVerified: false, checkedAt: 0, reports: [], notVerified: [] };
    const html = renderToStaticMarkup(<ProofDrawer proof={proof} open onClose={noop} onRecheck={noop} autoNote="Auto uses NEAR AI Cloud: the cheapest enclave." />);
    expect(html).toContain("data-testid=\"auto-note\"");
    expect(html).toContain("Auto uses NEAR AI Cloud");
  });
});

describe("model modality icons", () => {
  const base: ModelEntry = { id: "x", provider: "near", name: "X", privacy: "tee", tee: true, e2ee: false, selectable: true };
  const icons = (modalities?: ModelEntry["modalities"]) => renderToStaticMarkup(<ModalityIcons m={{ ...base, modalities }} />);
  it("shows what the model reads and makes", () => {
    const vision = icons({ in: ["text", "image"], out: ["text"] });
    expect(vision).toContain("Text");
    expect(vision).toContain("Reads images");
    expect(vision).not.toContain("Makes images");
    expect(icons({ in: ["text"], out: ["image"] })).toContain("Makes images");
    expect(icons({ in: ["audio"], out: ["text"] })).toContain("Audio");
  });
  it("says why a model cannot be picked", () => {
    const off = { ...base, selectable: false };
    expect(blockedReason({ ...off, modalities: { in: ["text"], out: ["image"] } })).toBe("makes images, not a chat model");
    expect(blockedReason({ ...off, modalities: { in: ["audio"], out: ["text"] } })).toBe("speech to text, not a chat model");
    expect(blockedReason({ ...off, modalities: { in: ["text"], out: ["embedding"] } })).toBe("embeddings, not a chat model");
    expect(blockedReason({ ...off, modalities: { in: ["text"], out: ["text"] } })).toBe("not a chat model");
    expect(blockedReason({ ...off, privacy: "anonymized", tee: false })).toBe("blocked by privacy policy");
    expect(blockedReason({ ...off, privacy: "anonymized", tee: false, incognito: true, modalities: { in: ["text"], out: ["image"] } })).toBe("makes images, not a chat model");
  });
  it("shows nothing when the provider does not say", () => {
    expect(icons()).toBe("");
  });
});
