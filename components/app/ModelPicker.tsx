"use client";
import { useState } from "react";
import type { ModelEntry } from "@/lib/catalog";
import { PROVIDER_LABEL } from "@/lib/client/providers";

const ref = (m: ModelEntry) => `${m.provider}:${m.id}`;

/** Model picker grouped by provider, with privacy tags. Blocked models are shown but not selectable. */
export function ModelPicker({ models, value, onChange }: { models: ModelEntry[]; value: string; onChange: (ref: string) => void }) {
  const [open, setOpen] = useState(false);
  const sel = models.find((m) => ref(m) === value);
  const groups = [...new Set(models.map((m) => m.provider))];
  return (
    <div className="picker">
      <button type="button" className="picker-btn" data-testid="model-picker" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="picker-name">{sel ? sel.name : "Select a model"}</span>
        {sel && <span className={`tag t-${sel.privacy}`} data-testid={`badge-${sel.privacy}`}>{sel.privacy.toUpperCase()}</span>}
        <span aria-hidden>▾</span>
      </button>
      {open && (
        <div className="picker-menu" role="listbox" data-testid="model-menu">
          {groups.map((g) => (
            <div key={g}>
              <div className="picker-group">{PROVIDER_LABEL[g] ?? g}</div>
              {models.filter((m) => m.provider === g).map((m) => (
                <button type="button" role="option" aria-selected={ref(m) === value} key={ref(m)} disabled={!m.selectable}
                  className={`picker-item ${ref(m) === value ? "on" : ""}`} onClick={() => { onChange(ref(m)); setOpen(false); }}>
                  <span>{m.name}</span>
                  <span className="tags">
                    <span className={`tag t-${m.privacy}`}>{m.privacy.toUpperCase()}</span>
                    {m.e2ee && <span className="tag t-e2ee">E2EE</span>}
                    {m.contextLength && <span className="tag">{Math.round(m.contextLength / 1000)}k</span>}
                  </span>
                  {!m.selectable && <span className="small muted">blocked by privacy policy</span>}
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
