"use client";
import { useEffect, useId, useRef, useState } from "react";
import { Check, Lightbulb, MagnifyingGlass, Plus } from "@phosphor-icons/react";

/** The composer's "+" menu: tools the model may call. Web search is the only live one; Think longer is marked "coming soon". Files go through the paperclip. */
export function ToolsMenu({ available, webSearch, onWebSearch, ghost }: { available: boolean; webSearch: boolean; onWebSearch: (on: boolean) => void; ghost?: boolean }) {
  const [open, setOpen] = useState(false);
  const [tipOff, setTipOff] = useState(false); // Escape hides the hover/focus hint (WCAG 1.4.13: it can cover the draft)
  const uid = useId();
  const root = useRef<HTMLDivElement>(null);
  const on = available && webSearch;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", onDown);
    root.current?.querySelector<HTMLButtonElement>("[data-testid=tool-web-search]")?.focus();
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);
  useEffect(() => {
    if (!on || open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setTipOff(true); }; // wherever focus is, e.g. typing while the pointer rests on the button
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [on, open]);
  const close = () => { setOpen(false); root.current?.querySelector<HTMLButtonElement>(".tools-btn")?.focus(); setTipOff(true); }; // the Escape that closed the menu also hides the hint
  return (
    <div className="picker tools" ref={root} onKeyDown={(e) => { if (e.key === "Escape" && open) { e.stopPropagation(); close(); } }}>
      <button type="button" className={`tool-toggle tools-btn ${on ? "on" : ""}`} data-testid="tools-menu" aria-expanded={open}
        aria-controls={open ? `${uid}menu` : undefined} aria-label={`Tools: web search ${on ? "enabled" : "off"}`} title={on ? undefined : "Tools"} data-tip={on && !tipOff ? "Web search enabled" : undefined}
        onFocus={() => setTipOff(false)} onMouseEnter={() => setTipOff(false)} onClick={() => setOpen((o) => !o)}>
        <Plus weight="bold" aria-hidden />{on && <MagnifyingGlass weight="duotone" aria-hidden />}
      </button>
      {open && (
        <div className="picker-menu tools-menu" id={`${uid}menu`} role="group" aria-label="Tools">
          <button type="button" aria-pressed={on} aria-disabled={!available || undefined} className="picker-item" data-testid="tool-web-search"
            onClick={() => { if (available) onWebSearch(!webSearch); }}>
            <span className="pi-text"><span className="pi-name"><MagnifyingGlass weight="duotone" aria-hidden /> Web search</span>
              <span className="pi-desc">{!available ? "Not available on this server" : `${ghost ? "Off by default in ghost chat" : "When needed"}; queries go to Brave, without your identity. Each search counts as a message.`}</span></span>
            <Check weight="bold" aria-hidden className="pi-check" style={{ visibility: on ? "visible" : "hidden" }} />
          </button>
          <button type="button" aria-disabled="true" className="picker-item">
            <span className="pi-text"><span className="pi-name"><Lightbulb weight="duotone" aria-hidden /> Think longer</span><span className="pi-desc">Coming soon</span></span>
          </button>
        </div>
      )}
    </div>
  );
}
