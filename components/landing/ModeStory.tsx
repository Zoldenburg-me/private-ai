"use client";
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";

const CYCLE_MS = 4500;
// Example chats, one per privacy level (lib/client privacy modes: Max = enclave, Private = zero retention, Anon = gateway).
const MODES = [
  { name: "Max Privacy", img: "/brand/narwhal-tee.svg", model: "Open model in a hardware enclave", badge: "Hardware enclave", tone: "ok",
    q: "Summarise my blood test results and flag anything unusual.", a: "Your ferritin is below the usual range. Everything else sits inside it. Worth asking your doctor about iron.",
    note: "Runs in sealed hardware. The host machine cannot read it, and you can check the proof yourself." },
  { name: "Private", img: "/brand/narwhal-pixel/narwhal-ink-default.svg", model: "Open model, zero retention", badge: "Zero retention", tone: "ink",
    q: "Draft a polite reply turning down this job offer.", a: "Thank you for the offer and for your time. After a lot of thought, I have decided to stay where I am for now.",
    note: "The provider is under contract not to keep or train on what you send." },
  { name: "Anon", img: "/brand/narwhal-pixel/narwhal-classic-default.svg", model: "Frontier model via an anonymizing gateway", badge: "No account linked", tone: "muted",
    q: "Explain this contract clause like I am new to law.", a: "It says either side can end the deal with 30 days notice, but you still owe for work already done.",
    note: "Frontier models through an anonymizing gateway. They see the text, never who you are." },
] as const;

/** Three privacy levels as tabs; they play through once while on screen (never under reduced motion), then stay put. */
export function ModeStory() {
  const [idx, setIdx] = useState(0);
  const [visible, setVisible] = useState(false);
  const [still, setStill] = useState(true);
  const [auto, setAuto] = useState(true); // one pass through the modes, then still for good (WCAG 2.2.2)
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    setStill(matchMedia("(prefers-reduced-motion: reduce)").matches);
    const el = ref.current;
    if (!el || !("IntersectionObserver" in window)) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { threshold: 0.3 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const playing = visible && !still && auto;
  useEffect(() => {
    if (!playing) return;
    const t = setTimeout(() => {
      if (idx === MODES.length - 1) setAuto(false);
      else setIdx(idx + 1);
    }, CYCLE_MS);
    return () => clearTimeout(t);
  }, [playing, idx]);

  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const pick = (i: number, focus = false) => { setAuto(false); setIdx(i); if (focus) tabs.current[i]?.focus(); };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const n = MODES.length;
    const next = { ArrowRight: (idx + 1) % n, ArrowLeft: (idx + n - 1) % n, Home: 0, End: n - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault(); pick(next, true);
  };

  return (
    <section ref={ref} className={`l-wrap l-story${playing ? " playing" : ""}`} aria-labelledby="story-h" style={{ "--cycle": `${CYCLE_MS}ms` } as CSSProperties}>
      <div className="story-copy">
        <h2 id="story-h">Pick how private each chat is.</h2>
        <p className="lead">Three modes, one composer. The narwhal changes colour so you always know where your words go.</p>
        <div role="tablist" aria-label="Privacy modes" className="mtabs" onKeyDown={onKey}>
          {MODES.map((m, i) => (
            <button key={m.name} type="button" role="tab" id={`mtab-${i}`} aria-controls={`mpanel-${i}`} aria-selected={i === idx}
              tabIndex={i === idx ? 0 : -1} ref={(el) => { tabs.current[i] = el; }} className="mtab" onClick={() => pick(i)}>
              <span className="track"><span className="fill" key={idx} /></span>{m.name}
            </button>
          ))}
        </div>
      </div>
      <div className="frames">
        {MODES.map((m, i) => (
          <article key={m.name} id={`mpanel-${i}`} role="tabpanel" aria-labelledby={`mtab-${i}`}
            className={`frame${i === idx ? " on" : ""}`} aria-hidden={i !== idx}>
            <div className="frame-top">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={m.img} alt="" width={52} height={52} />
              <div><div className="frame-name">{m.name}</div><div className="frame-model">{m.model}</div></div>
              <span className={`frame-badge t-${m.tone}`}>{m.badge}</span>
            </div>
            <p className="frame-q">{m.q}</p>
            <p className="frame-a">{m.a}</p>
            <p className="frame-note">{m.note}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
