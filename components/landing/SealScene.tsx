"use client";
import { useEffect, useRef, useState } from "react";
import { ArrowClockwise, ArrowUp, Check } from "@phosphor-icons/react";
import { tone } from "./sound";

const Q = "Summarise my blood test results and flag anything unusual.";
type Step = "idle" | "typing" | "press" | "sent" | "done";
const STEP_CLASS: Record<Step, string> = { idle: " instant", typing: " s-typing", press: " s-typing s-press", sent: " s-sent", done: " s-sent instant" };

// Chip geometry from the design canvas: 12 pins and traces per side, a heat spreader with brushed lines.
const IDX = Array.from({ length: 12 }, (_, i) => i);
const REACH = [-4, 0, 4, 8, 12, 16, 16, 12, 8, 4, 0, -4];
const BRUSH = Array.from({ length: 59 }, (_, i) => 112 + i * 2);

function Chip() {
  return (
    <svg className="chip" viewBox="0 0 340 340" role="img" aria-label="Enclave chip">
      <defs>
        <linearGradient id="gold" x1="0" x2="1"><stop offset="0" stopColor="#9c7a2c" /><stop offset=".45" stopColor="#f2d78a" /><stop offset="1" stopColor="#a8842c" /></linearGradient>
        <linearGradient id="goldh" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#9c7a2c" /><stop offset=".45" stopColor="#f2d78a" /><stop offset="1" stopColor="#a8842c" /></linearGradient>
        <linearGradient id="ihs" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#eef0f3" /><stop offset=".45" stopColor="#b9bec6" /><stop offset=".7" stopColor="#d7dbe0" /><stop offset="1" stopColor="#9aa0a9" /></linearGradient>
        <linearGradient id="sub" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#1d2a24" /><stop offset="1" stopColor="#0f1814" /></linearGradient>
      </defs>
      <g fill="none" strokeWidth="1.6" strokeLinecap="round">
        {IDX.map((i) => {
          const p = 93 + 14 * i, e = REACH[i];
          return <g key={i}><path className="trace" d={`M${p} 56V${e}`} /><path className="trace" d={`M${p} 284V${340 - e}`} /><path className="trace" d={`M56 ${p}H${e}`} /><path className="trace" d={`M284 ${p}H${340 - e}`} /></g>;
        })}
      </g>
      <rect x="74" y="78" width="200" height="200" rx="14" fill="#000" opacity=".25" />
      {IDX.map((i) => {
        const x = 90 + 14 * i;
        return <g key={i}><rect x={x} y="54" width="6" height="18" rx="1.2" fill="url(#gold)" /><rect x={x} y="268" width="6" height="18" rx="1.2" fill="url(#gold)" /><rect x="54" y={x} width="18" height="6" rx="1.2" fill="url(#goldh)" /><rect x="268" y={x} width="18" height="6" rx="1.2" fill="url(#goldh)" /></g>;
      })}
      <rect x="70" y="70" width="200" height="200" rx="14" fill="url(#sub)" stroke="#2c3b34" strokeWidth="1.5" />
      <path d="M70 96V84a14 14 0 0 1 14-14h12z" fill="#2c3b34" />
      {[[84, 96], [84, 108], [246, 226], [246, 238]].map(([x, y]) => <g key={`h${x}${y}`}><rect x={x} y={y} width="10" height="5" rx="1" fill="#b98a4a" /><rect x={x} y={y} width="2" height="5" fill="#c9ccd1" /><rect x={x + 8} y={y} width="2" height="5" fill="#c9ccd1" /></g>)}
      {[[226, 84], [238, 84], [96, 246], [108, 246]].map(([x, y]) => <g key={`v${x}${y}`}><rect x={x} y={y} width="5" height="10" rx="1" fill="#b98a4a" /><rect x={x} y={y} width="5" height="2" fill="#c9ccd1" /><rect x={x} y={y + 8} width="5" height="2" fill="#c9ccd1" /></g>)}
      <circle className="led" cx="254" cy="86" r="3.2" />
      <rect x="104" y="104" width="132" height="132" rx="10" fill="#0a0b0d" opacity=".35" transform="translate(2 3)" />
      <rect x="104" y="104" width="132" height="132" rx="10" fill="url(#ihs)" stroke="#f7f8fa" strokeOpacity=".8" strokeWidth="1.2" />
      {BRUSH.map((y, i) => <path key={y} d={`M110 ${y}H230`} stroke="#fff" strokeOpacity={i % 2 ? 0.1 : 0.18} strokeWidth="0.6" />)}
      <rect x="104.6" y="104.6" width="130.8" height="130.8" rx="9.5" fill="none" stroke="#6b717a" strokeOpacity=".5" />
      <path d="M114 114h10l-10 10z" fill="#5d636c" opacity=".7" />
      <g fontFamily="var(--mono)" fill="#3b3f46" fillOpacity=".85" textAnchor="middle">
        <text x="170" y="158" fontSize="14" fontWeight="600" letterSpacing="2.5">HIDDENSEE</text>
        <text x="170" y="176" fontSize="11" letterSpacing="1.5">TEE-01 ENCLAVE</text>
        <text x="170" y="196" fontSize="8.5" letterSpacing="1">TDX · H100 CC</text>
      </g>
    </svg>
  );
}

/** A question is typed, sent, and shrinks into the enclave chip, which lights up. Plays once when scrolled into view. */
export function SealScene() {
  const [step, setStep] = useState<Step>("idle");
  const [text, setText] = useState("");
  const ref = useRef<HTMLElement>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clear = () => { timers.current.forEach(clearTimeout); timers.current = []; };
  const later = (fn: () => void, ms: number) => { timers.current.push(setTimeout(fn, ms)); };
  const play = () => {
    clear();
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) { setText(Q); setStep("done"); return; }
    setText(""); setStep("typing");
    for (let i = 1; i <= Q.length; i++) later(() => setText(Q.slice(0, i)), i * 36);
    const end = Q.length * 36 + 420;
    later(() => setStep("press"), end);
    later(() => { setStep("sent"); tone([[392, 0.1], [784, 0.14], [1175, 0.3]]); }, end + 260);
  };

  useEffect(() => {
    const el = ref.current;
    if (!el || !("IntersectionObserver" in window)) { play(); return clear; }
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { io.disconnect(); play(); } }, { threshold: 0.35 });
    io.observe(el);
    return () => { io.disconnect(); clear(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section ref={ref} className={`l-seal${STEP_CLASS[step]}`} aria-labelledby="seal-h">
      <h2 id="seal-h">Your question ends up sealed in the chip.</h2>
      <p className="lead">Max Privacy chats run inside one hardware enclave. Our relay passes your message on without storing it, and the host machine and the cloud only see ciphertext.</p>
      <div className="seal-stage">
        <div className="seal-q" aria-hidden>
          <p>{text || <span className="muted">Ask anything, privately</span>}<span className="seal-caret" /></p>
          <div className="seal-bar">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <span className="l-composer-mode"><img src="/brand/narwhal-tee.svg" alt="" width={22} height={22} />Max Privacy</span>
            <span className="seal-send"><ArrowUp weight="bold" /></span>
          </div>
        </div>
        <div className="seal-wire" aria-hidden />
        <Chip />
        <ul className="seal-tags">
          <li className="seal-tag t1"><Check weight="bold" aria-hidden />Sealed in hardware the host cannot read</li>
          <li className="seal-tag t2"><Check weight="bold" aria-hidden />Attestation checked before you chat</li>
        </ul>
        <button type="button" className="replay pill pill-ghost" onClick={() => { setStep("idle"); setText(""); later(play, 60); }}>
          <ArrowClockwise aria-hidden />Play again
        </button>
      </div>
    </section>
  );
}
