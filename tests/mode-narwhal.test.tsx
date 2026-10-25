import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { MODE_LOOK, ModeNarwhal } from "@/components/app/ModeNarwhal";
import { SettingsView } from "@/components/app/SettingsView";
import { LEVELS } from "@/lib/client/levels";

const noop = () => {};

// The design's pixel narwhals: green = attested enclave, ink = zero retention, classic = anonymized gateway.
describe("narwhal per privacy level", () => {
  it("maps each level to its narwhal, and every file exists", () => {
    expect(MODE_LOOK.max.src).toBe("/brand/narwhal-tee.svg");
    expect(MODE_LOOK.medium.src).toBe("/brand/narwhal-zdr.svg");
    expect(MODE_LOOK.anon.src).toBe("/brand/narwhal-anon.svg");
    for (const l of LEVELS) expect(existsSync(`public${MODE_LOOK[l.id].src}`)).toBe(true);
  });

  it("is decorative unless labelled, and the anonymized caption never claims an enclave", () => {
    expect(renderToStaticMarkup(<ModeNarwhal level="max" size={22} />)).toContain('alt=""');
    expect(renderToStaticMarkup(<ModeNarwhal level="anon" size={104} label />)).toContain('alt="Classic narwhal: anonymized"');
    expect(MODE_LOOK.anon.caption).not.toMatch(/enclave/i);
    expect(MODE_LOOK.medium.caption).toMatch(/no hardware proof/);
  });
});

describe("mode sounds", () => {
  const view = (sounds: boolean) => renderToStaticMarkup(<SettingsView tier={null} usage={null} billing={null} passkeys={null} ghost={false} account={null} devices={[]}
    onSignOut={noop} onRemoveDevice={noop} onCheckout={noop} onPortal={noop} onAddPasskey={noop} onLoginPasskey={noop} onRemovePasskey={noop}
    onExportAccount={noop} onDeleteAccount={noop} onExport={noop} onImport={noop} onWipe={noop}
    tools={{ available: true, webSearch: true, onWebSearch: noop, pickProvider: false, onPickProvider: noop, sounds, onSounds: noop }} />);

  it("is a setting that shows its state", () => {
    expect(view(false)).toMatch(/data-testid="setting-sounds"(?![^>]*checked)/);
    expect(view(true)).toMatch(/<input[^>]*data-testid="setting-sounds"[^>]*checked/);
  });

  it("plays only behind that setting, and synthesises the tones (no audio files)", () => {
    const page = readFileSync("app/chat/page.tsx", "utf8");
    expect(page).toMatch(/mode\.sounds\) playNotes\(/);
    const tone = readFileSync("lib/client/tone.ts", "utf8");
    expect(tone).toContain("createOscillator");
    expect(tone).not.toMatch(/new Audio\(|\.mp3|\.wav|fetch\(/);
  });
});
