"use client";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { CaretDown, Check, LockSimple, Prohibit } from "@phosphor-icons/react";
import type { ModelEntry } from "@/lib/catalog";
import { ANONYMIZED_NOTE, PROVIDER_LABEL, pickerGroup } from "@/lib/client/providers";

const ref = (m: ModelEntry) => `${m.provider}:${m.id}`;
/** Paid-only models are locked once the plan is known to be free; `paidPlan` is undefined while the tier loads. */
export const isLocked = (m: ModelEntry, paidPlan: boolean | undefined) => !!m.paid && paidPlan === false;

/** Model picker: TEE models by provider, all non-TEE models in one Incognito group. Blocked models are shown but not selectable. */
export function ModelPicker({ models, value, onChange, paidPlan }: { models: ModelEntry[]; value: string; onChange: (ref: string) => void; paidPlan?: boolean }) {
  const [open, setOpen] = useState(false);
  const uid = useId(); // ids stay unique if two pickers render
  const reasonId = (m: ModelEntry) => `${uid}why-${ref(m).replace(/[^\w-]/g, "_")}`;
  const root = useRef<HTMLDivElement>(null);
  const sel = models.find((m) => ref(m) === value);
  const groups = [...new Set(models.map(pickerGroup))];
  const locked = (m: ModelEntry) => isLocked(m, paidPlan);

  // Close on outside click; focus the selected (or first enabled) option when the menu opens.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", onDown);
    const opts = root.current?.querySelectorAll<HTMLButtonElement>("[role=option]");
    (root.current?.querySelector<HTMLButtonElement>("[role=option][aria-selected=true]") ?? root.current?.querySelector<HTMLButtonElement>("[role=option]:not([aria-disabled=true])") ?? opts?.[0])?.focus();
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const focusTrigger = () => root.current?.querySelector<HTMLButtonElement>(".picker-btn")?.focus();
  const onMenuKey = (e: KeyboardEvent) => {
    const opts = [...(root.current?.querySelectorAll<HTMLButtonElement>("[role=option]") ?? [])];
    const i = opts.indexOf(document.activeElement as HTMLButtonElement);
    // Focus outside the options: down goes to the first, up to the last.
    const move = (n: number) => { e.preventDefault(); opts[i < 0 ? (n > 0 ? 0 : opts.length - 1) : (i + n + opts.length) % opts.length]?.focus(); };
    if (e.key === "ArrowDown") move(1);
    else if (e.key === "ArrowUp") move(-1);
    else if (e.key === "Home") { e.preventDefault(); opts[0]?.focus(); }
    else if (e.key === "End") { e.preventDefault(); opts[opts.length - 1]?.focus(); }
    // Tab: the menu unmounts before the browser moves focus, so Tab/Shift+Tab continue from the trigger.
    else if (e.key === "Escape" || e.key === "Tab") { e.stopPropagation(); setOpen(false); focusTrigger(); }
  };

  return (
    <div className="picker" ref={root}>
      <button type="button" className="picker-btn" data-testid="model-picker" aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? `${uid}menu` : undefined}
        aria-label={`Model: ${sel ? `${sel.name}, ${sel.privacy}` : "none selected"}`} onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) { e.preventDefault(); setOpen(true); }
          else if (e.key === "Escape" && open) { e.stopPropagation(); setOpen(false); }
        }}>
        <span className="picker-name">{sel ? sel.name : "Select a model"}</span>
        {sel && <span className={`tag t-${sel.privacy}`} data-testid={`badge-${sel.privacy}`}
          title={sel.incognito ? ANONYMIZED_NOTE : undefined}>{sel.privacy.toUpperCase()}</span>}
        {sel?.incognito && <span className="sr-only">{ANONYMIZED_NOTE}</span>}
        <CaretDown aria-hidden />
      </button>
      {open && (
        <div className="picker-menu" data-testid="model-menu">
        {!models.length && <div className="picker-group" role="status">No models configured (set NEAR_AI_API_KEY)</div>}
        <div role="listbox" id={`${uid}menu`} aria-label="Models" onKeyDown={onMenuKey}>
          {groups.map((g) => (
            <div key={g} role="group" aria-labelledby={`${uid}group-${g}`} aria-describedby={g === "incognito" ? `${uid}note-${g}` : undefined}>
              <div className="picker-group" id={`${uid}group-${g}`}>{PROVIDER_LABEL[g] ?? g}</div>
              {g === "incognito" && <p className="picker-note" id={`${uid}note-${g}`}>{ANONYMIZED_NOTE}</p>}
              {models.filter((m) => pickerGroup(m) === g).map((m) => (
                <button type="button" role="option" aria-selected={ref(m) === value} key={ref(m)} aria-disabled={!m.selectable || locked(m) || undefined}
                  aria-describedby={!m.selectable || locked(m) ? reasonId(m) : undefined}
                  className={`picker-item ${ref(m) === value ? "on" : ""}`} onClick={() => { if (!m.selectable || locked(m)) return; onChange(ref(m)); setOpen(false); focusTrigger(); }}>
                  <span className="pi-name">{ref(m) === value && <Check weight="bold" aria-hidden />}{m.name}</span>
                  <span className="tags">
                    <span className={`tag t-${m.privacy}`}>{m.privacy.toUpperCase()}</span>
                    {m.paid && <span className="tag t-pro">PRO</span>}
                    {m.e2ee && <span className="tag t-e2ee"><LockSimple aria-hidden />E2EE</span>}
                    {m.contextLength && <span className="tag t-ctx">{Math.round(m.contextLength / 1000)}k</span>}
                  </span>
                  {!m.selectable && <span className="pi-blocked" id={reasonId(m)}><Prohibit aria-hidden />blocked by privacy policy</span>}
                  {m.selectable && locked(m) && <span className="pi-blocked" id={reasonId(m)}><Prohibit aria-hidden />paid plans only</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
        </div>
      )}
    </div>
  );
}
