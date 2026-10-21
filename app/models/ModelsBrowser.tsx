"use client";
import { Fragment, useState } from "react";
import Link from "next/link";
import { CaretDown, CaretUp, ChatCircle, CheckSquare, Circle, EyeSlash, MagnifyingGlass, MaskHappy, RadioButton, ShieldCheck, Square } from "@phosphor-icons/react";
import type { Privacy } from "@/lib/catalog";
import { TIERS, type TierId } from "@/lib/tiers";
import { NO_FILTERS, PRIVACY_ORDER, ctxOn, fmtCtx, passes, sortRows, type FilterKey, type Filters, type ModelRow, type SortKey } from "./rows";

const PRIV: Record<Privacy, { full: string; short: string; Icon: typeof ShieldCheck }> = {
  tee: { full: "Private enclave", short: "Enclave", Icon: ShieldCheck },
  private: { full: "Incognito · private", short: "Private", Icon: MaskHappy },
  anonymized: { full: "Incognito · anonymized", short: "Anonymized", Icon: EyeSlash },
};
const PLAN_IDS = Object.keys(TIERS) as TierId[];
const msgs = (t: TierId) => (t === "max" ? "high fair-use limit" : `${TIERS[t].dailyMessages.toLocaleString("en")} messages a day`);
type Group = "none" | "provider" | "privacy" | "plan";
const GROUP_OPTS: [Group, string][] = [["none", "None"], ["provider", "Provider"], ["privacy", "Privacy"], ["plan", "Plan"]];
const GROUP_KEY: Record<Exclude<Group, "none">, (r: ModelRow) => string> = {
  provider: (r) => r.providerName, privacy: (r) => PRIV[r.privacy].full, plan: (r) => `Included from ${TIERS[r.plan].name}`,
};
const HEADS: [SortKey, string][] = [["name", "Model"], ["privacy", "Runs in"], ["provider", "Served by"], ["ctx", "Context"], ["plan", "Plan"]];

interface Opt { label: string; on: boolean; count: number; toggle: () => void }
function FilterGroup({ label, opts, radio, clear }: { label: string; opts: Opt[]; radio?: boolean; clear?: () => void }) {
  return (
    <div>
      <div className="mdl-fhead"><span>{label}</span>{clear && <button type="button" onClick={clear}>clear</button>}</div>
      <div className="mdl-opts">
        {opts.map((o) => {
          const Box = radio ? (o.on ? RadioButton : Circle) : (o.on ? CheckSquare : Square);
          return (
            <button key={o.label} type="button" className="mdl-opt" aria-pressed={o.on} onClick={o.toggle}>
              <Box weight={o.on ? "fill" : "duotone"} className="box" aria-hidden /><span className="grow">{o.label}</span><span className="n">{o.count}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function ModelsBrowser({ rows }: { rows: ModelRow[] }) {
  const [f, setF] = useState<Filters>(NO_FILTERS);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "name", dir: 1 });
  const [group, setGroup] = useState<Group>("none");
  const [open, setOpen] = useState<string | null>(null);

  const count = (skip: FilterKey, pick: (r: ModelRow) => boolean) => rows.filter((r) => passes(r, f, skip) && pick(r)).length;
  const toggle = <K extends "providers" | "privacy">(k: K, v: Filters[K][number]) => () =>
    setF((x) => ({ ...x, [k]: (x[k] as string[]).includes(v) ? (x[k] as string[]).filter((y) => y !== v) : [...x[k], v] }));
  const providers = [...new Map(rows.map((r) => [r.provider, r.providerName])).entries()];
  const privacies = PRIVACY_ORDER.filter((p) => rows.some((r) => r.privacy === p));

  const shown = sortRows(rows.filter((r) => passes(r, f)), sort.key, sort.dir);
  const sections = group === "none"
    ? [{ label: "", rows: shown }]
    : [...new Set(shown.map(GROUP_KEY[group]))].map((label) => ({ label, rows: shown.filter((r) => GROUP_KEY[group](r) === label) }));
  const plan = f.plan;

  return (
    <div className="mdl-grid mdl-pad">
      <aside aria-label="Filters" className="mdl-aside">
        <label className="mdl-search"><MagnifyingGlass weight="duotone" aria-hidden />
          <input placeholder="Search models" aria-label="Search models" value={f.query} onChange={(e) => setF((x) => ({ ...x, query: e.target.value }))} /></label>
        <FilterGroup label="Privacy" clear={f.privacy.length ? () => setF((x) => ({ ...x, privacy: [] })) : undefined}
          opts={privacies.map((p) => ({ label: PRIV[p].full, on: f.privacy.includes(p), toggle: toggle("privacy", p), count: count("privacy", (r) => r.privacy === p) }))} />
        <FilterGroup label="Served by" clear={f.providers.length ? () => setF((x) => ({ ...x, providers: [] })) : undefined}
          opts={providers.map(([id, name]) => ({ label: name, on: f.providers.includes(id), toggle: toggle("providers", id), count: count("providers", (r) => r.provider === id) }))} />
        <FilterGroup label="Your plan" radio clear={plan ? () => setF((x) => ({ ...x, plan: null })) : undefined}
          opts={PLAN_IDS.map((t) => ({ label: TIERS[t].name, on: plan === t, toggle: () => setF((x) => ({ ...x, plan: x.plan === t ? null : t })), count: count("plan", (r) => passes(r, { ...NO_FILTERS, plan: t })) }))} />
      </aside>

      <section className="mdl-results">
        {plan && (
          <div className="mdl-plan">
            <span className="big">On <em>{TIERS[plan].name}</em></span>
            <span>{msgs(plan)}</span><span>up to {fmtCtx(TIERS[plan].maxContextTokens)} context</span>
            <span>€{TIERS[plan].priceEurMonth} / month</span>
            <Link href="/#pricing" className="mdl-a">Compare plans</Link>
          </div>
        )}
        <div className="mdl-bar">
          <span className="mdl-count">{shown.length} of {rows.length} models</span>
          <div className="mdl-groupby" role="group" aria-label="Group by"><span>Group by</span>
            {GROUP_OPTS.map(([id, label]) => <button key={id} type="button" aria-pressed={group === id} onClick={() => setGroup(id)}>{label}</button>)}
          </div>
        </div>
        <div className="mdl-head mdl-cols">
          {HEADS.map(([k, label]) => (
            <button key={k} type="button" className={sort.key === k ? "on" : ""} onClick={() => setSort((s) => ({ key: k, dir: s.key === k ? (-s.dir as 1 | -1) : 1 }))}>
              {label}{sort.key === k && (sort.dir > 0 ? <CaretUp weight="bold" aria-label="ascending" /> : <CaretDown weight="bold" aria-label="descending" />)}
            </button>
          ))}
        </div>
        {sections.map((s) => (
          <Fragment key={s.label || "all"}>
            {s.label && <div className="mdl-sec"><span>{s.label}</span><em>{s.rows.length} {s.rows.length === 1 ? "model" : "models"}</em></div>}
            {s.rows.map((r) => {
              const P = PRIV[r.privacy]; const isOpen = open === r.key; const ctx = ctxOn(r, plan);
              return (
                <div key={r.key} className="mdl-row">
                  <button type="button" className="mdl-cols mdl-main" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : r.key)}>
                    <span className="name">{r.name}<span className="sub">{r.maker ?? r.providerName}</span></span>
                    <span className={`priv${r.privacy === "tee" ? " tee" : ""}`} title={P.full}><P.Icon weight="duotone" aria-hidden />{P.short}</span>
                    <span className="via">{r.providerName}</span>
                    <span className="ctx">{fmtCtx(ctx)}{plan && r.ctx && ctx! < r.ctx && <span className="note">of {fmtCtx(r.ctx)} on {TIERS[plan].name}</span>}</span>
                    <span className={`tier${r.plan === "free" ? "" : " paid"}`}>{TIERS[r.plan].name}+</span>
                  </button>
                  {isOpen && (
                    <div className="mdl-more">
                      <div className="mdl-facts">
                        <span><em>Runs in</em> · {P.full}</span>
                        <span><em>Served by</em> · {r.providerName}{r.maker ? ` · made by ${r.maker}` : ""}</span>
                        <span><em>Context</em> · {fmtCtx(r.ctx)}</span>
                        <span><em>Allowance</em> · {r.incognito ? "separate incognito allowance" : "counts toward your daily messages"}</span>
                      </div>
                      <div><Link href="/chat" className="mdl-cta"><ChatCircle weight="duotone" aria-hidden />Open the chat</Link></div>
                    </div>
                  )}
                </div>
              );
            })}
          </Fragment>
        ))}
        {!shown.length && (
          <p className="mdl-empty">{rows.length ? <>No model matches all of those. <button type="button" onClick={() => setF(NO_FILTERS)}>Clear filters</button></> : "No models are configured on this server right now."}</p>
        )}
        <div className="mdl-legend">
          {privacies.map((p) => { const P = PRIV[p]; return <span key={p}><P.Icon weight="duotone" aria-hidden /><em>{P.full}</em></span>; })}
        </div>
      </section>
    </div>
  );
}
