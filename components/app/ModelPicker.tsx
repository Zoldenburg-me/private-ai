"use client";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { CaretDown, Check, Detective, EyeSlash, ImageSquare, LockSimple, MagicWand, MaskHappy, Prohibit, Question, ShieldCheck, TextT, Waveform } from "@phosphor-icons/react";
import type { ProofLevel } from "@/lib/client/proof";
import type { Modalities, ModelEntry } from "@/lib/catalog";
import { anonAllowed } from "@/lib/tiers";
import { ANONYMIZED_NOTE, PROVIDER_LABEL, pickerGroup } from "@/lib/client/providers";
import { LEVELS, type Level } from "@/lib/client/levels";

/** The chat bar's privacy level and Auto switch; `models` are then only that level's manual picks. */
export interface PrivacyControl { level: Level; onLevel: (l: Level) => void; auto: boolean; onAuto: () => void; note?: string }

const ref = (m: ModelEntry) => `${m.provider}:${m.id}`;
/** Paid-only models are locked once the plan is known to be free; `paidPlan` is undefined while the tier loads. */
export const isLocked = (m: ModelEntry, paidPlan: boolean | undefined) => !!m.paid && paidPlan === false;
/** Signed-out visitors on the free plan get the curated Auto line-up on TEE only (anonAllowed, as on the server); undefined while the session loads. */
export const needsSignIn = (m: ModelEntry, signedIn: boolean | undefined, paidPlan: boolean | undefined) => signedIn === false && paidPlan === false && !anonAllowed(m);

/** Menu badges, as in the design. */
const BADGE: Record<string, string> = { tee: "TEE", private: "PRIVATE", anonymized: "ANON" };

const MODALITY_ICONS = [
  { label: "Text", Icon: TextT, on: (x: Modalities) => x.out.includes("text") },
  { label: "Reads images", Icon: ImageSquare, on: (x: Modalities) => x.in.includes("image") },
  { label: "Makes images", Icon: MagicWand, on: (x: Modalities) => x.out.includes("image") },
  { label: "Audio", Icon: Waveform, on: (x: Modalities) => x.in.includes("audio") || x.out.includes("audio") },
];

/** Why a model cannot be picked: privacy, or it is not a chat model (and then what it is). */
export function blockedReason(m: ModelEntry): string {
  // Incognito models are anonymized yet selectable: theirs is never a privacy block.
  if (!m.incognito && m.privacy !== "tee" && m.privacy !== "private") return "blocked by privacy policy";
  if (m.modalities?.out.includes("image")) return "makes images, not a chat model";
  if (m.modalities?.out.includes("embedding")) return "embeddings, not a chat model";
  if (m.modalities?.in.includes("audio")) return "speech to text, not a chat model";
  return "not a chat model";
}

/** What the model reads and makes, as small icons; nothing when the provider does not say. */
export function ModalityIcons({ m }: { m: ModelEntry }) {
  const shown = MODALITY_ICONS.filter((x) => m.modalities && x.on(m.modalities));
  return shown.length ? (
    <span className="pi-badge" data-testid="modalities" style={{ color: "var(--muted)" }}>
      {shown.map(({ label, Icon }) => <span key={label} title={label}><Icon aria-hidden /></span>)}
      <span className="sr-only">{`, ${shown.map((x) => x.label).join(", ")}`}</span>
    </span>
  ) : null;
}

/** The model's privacy at a glance: a shield (green once the enclave is verified, orange until then),
 *  a detective for anonymized incognito models, a mask for zero-retention private ones. */
export function PrivacyIcon({ m, level }: { m?: ModelEntry; level?: ProofLevel }) {
  if (m?.privacy === "anonymized") return <Detective weight="duotone" aria-hidden className="pi-ico pi-incognito" />;
  if (m?.privacy === "private") return <MaskHappy weight="duotone" aria-hidden className="pi-ico pi-incognito" />;
  return <ShieldCheck weight="duotone" aria-hidden className={`pi-ico ${level === "verified" ? "pi-verified" : "pi-unverified"}`} />;
}

/** Model picker: TEE models by provider, all non-TEE models in one Incognito group. Blocked models are shown but not selectable. */
export function ModelPicker({ models, value, onChange, paidPlan, signedIn, onExplain, level, loadFailed, privacy }: { models: ModelEntry[]; value: string; onChange: (ref: string) => void; paidPlan?: boolean; signedIn?: boolean; onExplain?: () => void; level?: ProofLevel; loadFailed?: boolean; privacy?: PrivacyControl }) {
  const [open, setOpen] = useState(false);
  const uid = useId(); // ids stay unique if two pickers render
  const reasonId = (m: ModelEntry) => `${uid}why-${ref(m).replace(/[^\w-]/g, "_")}`;
  const root = useRef<HTMLDivElement>(null);
  const sel = models.find((m) => ref(m) === value);
  // With privacy levels, a curated model reads as itself: "Auto" is the separate row that also picks the model.
  const nameOf = (m: ModelEntry) => (privacy ? m.name.replace(/^Auto · /, "") : m.name);
  const isOn = (m: ModelEntry) => !privacy?.auto && ref(m) === value;
  const levelLabel = privacy && LEVELS.find((l) => l.id === privacy.level)?.label;
  const shown = privacy ? `${levelLabel} · ${privacy.auto ? "Auto" : sel ? nameOf(sel) : "Select a model"}` : sel ? sel.name : "Select a model";
  // The design's two groups: where the model runs.
  const groupOf = (m: ModelEntry) => (pickerGroup(m) === "incognito" ? "incognito" : "enclave");
  const groups = [...new Set(models.map(groupOf))];
  const locked = (m: ModelEntry) => isLocked(m, paidPlan) || needsSignIn(m, signedIn, paidPlan);

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
    // The explain link sits after the options in the same arrow-key order, so the keyboard can reach it.
    const opts = [...(root.current?.querySelectorAll<HTMLButtonElement>(".picker-level, [role=option], .picker-explain") ?? [])];
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
        aria-label={privacy ? `Privacy and model: ${shown}` : `Model: ${sel ? `${sel.name}, ${sel.privacy}` : "none selected"}`} onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) { e.preventDefault(); setOpen(true); }
          else if (e.key === "Escape" && open) { e.stopPropagation(); setOpen(false); }
        }}>
        <PrivacyIcon m={sel} level={level} />
        <span className="picker-name">{shown}</span>
        {sel && <span className="sr-only" data-testid={`badge-${sel.privacy}`}
          title={sel.incognito ? ANONYMIZED_NOTE : undefined}>{sel.privacy.toUpperCase()}</span>}
        {sel?.incognito && <span className="sr-only">{ANONYMIZED_NOTE}</span>}
        <CaretDown aria-hidden />
      </button>
      {open && (
        <div className="picker-menu" data-testid="model-menu" onKeyDown={onMenuKey}>
        {!models.length && <div className="picker-group" role="status">{loadFailed ? "Could not load models. Reload to try again." : privacy ? "This server offers no models at this privacy level." : "No models configured (set NEAR_AI_API_KEY)"}</div>}
        {privacy && (
          <div className="picker-levels" role="group" aria-label="Privacy level">
            {LEVELS.map((l) => (
              <button type="button" key={l.id} className={`picker-level ${l.id === privacy.level ? "on" : ""}`} aria-pressed={l.id === privacy.level} data-testid={`level-${l.id}`}
                title={l.note} onClick={() => privacy.onLevel(l.id)}><span className="pi-name">{l.label}</span><span className="pi-desc">{l.note}</span></button>
            ))}
          </div>
        )}
        <div role="listbox" id={`${uid}menu`} aria-label="Models">
          {privacy && (
            <button type="button" role="option" aria-selected={privacy.auto} className={`picker-item ${privacy.auto ? "on" : ""}`} data-testid="model-auto"
              onClick={() => { privacy.onAuto(); setOpen(false); focusTrigger(); }}>
              <span className="pi-text"><span className="pi-name">Auto</span>
                <span className="pi-desc">{privacy.auto && privacy.note ? privacy.note : "Picks the model and provider for you"}</span></span>
              <span className="tags"><Check weight="bold" aria-hidden className="pi-check" style={{ visibility: privacy.auto ? "visible" : "hidden" }} /></span>
            </button>
          )}
          {groups.map((g) => (
            <div key={g} role="group" aria-labelledby={`${uid}group-${g}`} aria-describedby={g === "incognito" ? `${uid}note-${g}` : undefined}>
              <div className="picker-group" id={`${uid}group-${g}`}>{g === "incognito" ? <><EyeSlash weight="duotone" aria-hidden />Incognito</> : <><ShieldCheck weight="duotone" aria-hidden />Private enclave</>}</div>
              {g === "incognito" && <p className="picker-note" id={`${uid}note-${g}`}>{ANONYMIZED_NOTE}</p>}
              {models.filter((m) => groupOf(m) === g).map((m) => (
                <button type="button" role="option" aria-selected={isOn(m)} key={ref(m)} aria-disabled={!m.selectable || locked(m) || undefined}
                  aria-describedby={!m.selectable || locked(m) ? reasonId(m) : undefined}
                  className={`picker-item ${isOn(m) ? "on" : ""}`} onClick={() => { if (!m.selectable || locked(m)) return; onChange(ref(m)); setOpen(false); focusTrigger(); }}>
                  <span className="pi-text"><span className="pi-name">{nameOf(m)}</span>
                    <span className="pi-desc">{[PROVIDER_LABEL[m.provider] ?? m.provider, m.contextLength && `${Math.round(m.contextLength / 1000)}k context`, m.paid && "Pro"].filter(Boolean).join(" · ")}</span></span>
                  <span className="tags">
                    <span className="pi-badge" style={m.privacy === "tee" ? { color: "var(--ok)" } : undefined}>{BADGE[m.privacy] ?? m.privacy.toUpperCase()}</span>
                    <ModalityIcons m={m} />
                    <Check weight="bold" aria-hidden className="pi-check" style={{ visibility: isOn(m) ? "visible" : "hidden" }} />
                    {m.e2ee && <span className="pi-badge"><LockSimple aria-hidden />E2EE</span>}
                  </span>
                  {!m.selectable && <span className="pi-blocked" id={reasonId(m)}><Prohibit aria-hidden />{blockedReason(m)}</span>}
                  {m.selectable && locked(m) && <span className="pi-blocked" id={reasonId(m)}><Prohibit aria-hidden />{needsSignIn(m, signedIn, paidPlan) ? "sign in to use this model" : "paid plans only"}</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
        {onExplain && <button type="button" className="picker-explain" onClick={() => { setOpen(false); onExplain(); }}><Question weight="duotone" aria-hidden />Enclave, private or anonymized: what&apos;s the difference?</button>}
        </div>
      )}
    </div>
  );
}
