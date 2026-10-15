"use client";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { CaretDown, Check, LockSimple, Prohibit } from "@phosphor-icons/react";
import type { ModelEntry } from "@/lib/catalog";
import { PROVIDER_LABEL } from "@/lib/client/providers";

const ref = (m: ModelEntry) => `${m.provider}:${m.id}`;

/** Model picker grouped by provider, with privacy tags. Blocked models are shown but not selectable. */
export function ModelPicker({ models, value, onChange }: { models: ModelEntry[]; value: string; onChange: (ref: string) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const sel = models.find((m) => ref(m) === value);
  const groups = [...new Set(models.map((m) => m.provider))];

  // Close on outside click; focus the selected (or first enabled) option when the menu opens.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", onDown);
    const opts = root.current?.querySelectorAll<HTMLButtonElement>("[role=option]:not(:disabled)");
    (root.current?.querySelector<HTMLButtonElement>("[role=option][aria-selected=true]:not(:disabled)") ?? opts?.[0])?.focus();
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const onMenuKey = (e: KeyboardEvent) => {
    const opts = [...(root.current?.querySelectorAll<HTMLButtonElement>("[role=option]:not(:disabled)") ?? [])];
    const i = opts.indexOf(document.activeElement as HTMLButtonElement);
    const move = (n: number) => { e.preventDefault(); opts[(i + n + opts.length) % opts.length]?.focus(); };
    if (e.key === "ArrowDown") move(1);
    else if (e.key === "ArrowUp") move(-1);
    else if (e.key === "Home") { e.preventDefault(); opts[0]?.focus(); }
    else if (e.key === "End") { e.preventDefault(); opts[opts.length - 1]?.focus(); }
    else if (e.key === "Escape" || e.key === "Tab") { setOpen(false); root.current?.querySelector<HTMLButtonElement>(".picker-btn")?.focus(); }
  };

  return (
    <div className="picker" ref={root}>
      <button type="button" className="picker-btn" data-testid="model-picker" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === "ArrowDown" && !open) { e.preventDefault(); setOpen(true); } }}>
        <span className="picker-name">{sel ? sel.name : "Select a model"}</span>
        {sel && <span className={`tag t-${sel.privacy}`} data-testid={`badge-${sel.privacy}`}>{sel.privacy.toUpperCase()}</span>}
        <CaretDown aria-hidden />
      </button>
      {open && (
        <div className="picker-menu" role="listbox" aria-label="Models" data-testid="model-menu" onKeyDown={onMenuKey}>
          {groups.map((g) => (
            <div key={g} role="group" aria-label={PROVIDER_LABEL[g] ?? g}>
              <div className="picker-group" aria-hidden>{PROVIDER_LABEL[g] ?? g}</div>
              {models.filter((m) => m.provider === g).map((m) => (
                <button type="button" role="option" aria-selected={ref(m) === value} key={ref(m)} disabled={!m.selectable}
                  className={`picker-item ${ref(m) === value ? "on" : ""}`} onClick={() => { onChange(ref(m)); setOpen(false); }}>
                  <span className="pi-name">{ref(m) === value && <Check weight="bold" aria-hidden />}{m.name}</span>
                  <span className="tags">
                    <span className={`tag t-${m.privacy}`}>{m.privacy.toUpperCase()}</span>
                    {m.e2ee && <span className="tag t-e2ee"><LockSimple aria-hidden />E2EE</span>}
                    {m.contextLength && <span className="tag t-ctx">{Math.round(m.contextLength / 1000)}k</span>}
                  </span>
                  {!m.selectable && <span className="pi-blocked"><Prohibit aria-hidden />blocked by privacy policy</span>}
                </button>
              ))}
            </div>
          ))}
          {!models.length && <div className="picker-group">No models configured (set NEAR_AI_API_KEY)</div>}
        </div>
      )}
    </div>
  );
}
